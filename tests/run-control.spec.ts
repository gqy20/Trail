import { test, expect } from "@playwright/test";
import { advanceBatchRun, describeBatchRun, buildBatchRunResultFromState, isTransientBatchError, requestPauseBatchRun, requestStopBatchRun, consumeControlRequest, clearControlRequest, type BatchRunState } from "../src/background/runControl";

function sampleState(overrides: Partial<BatchRunState> = {}): BatchRunState {
  return {
    runId: "browser_tool_batch_t1",
    toolId: "twitter-timeline",
    toolName: "X 用户时间线采集",
    keywords: ["karpathy", "ylecun", "sama"],
    nextIndex: 0,
    completedKeywords: 0,
    parameters: {},
    status: "running",
    startedAt: Date.now() - 1000,
    updatedAt: Date.now() - 1000,
    lastPageUrl: "https://x.com/home",
    lastPageTitle: "X",
    data: {},
    ...overrides
  };
}

test("advanceBatchRun 累积记录、注入 _query 并推进游标", () => {
  let state = sampleState();
  state = advanceBatchRun(state, "karpathy", { tweets: [{ id: "1", text: "a" }] });
  state = advanceBatchRun(state, "ylecun", { tweets: [{ id: "2", text: "b" }], users: [{ id: "ylecun" }] });

  expect(state.nextIndex).toBe(2);
  expect(state.completedKeywords).toBe(2);
  expect(state.data.tweets.map((record) => record._query)).toEqual(["karpathy", "ylecun"]);
  expect(state.data.users).toHaveLength(1);
  expect(state.updatedAt).toBeGreaterThanOrEqual(sampleState().updatedAt);

  // 暂停后恢复：从 nextIndex 继续，旧数据保留
  const resumed = advanceBatchRun(state, "sama", { tweets: [{ id: "3", text: "c" }] });
  expect(resumed.data.tweets).toHaveLength(3);
  expect(resumed.completedKeywords).toBe(3);
});

test("advanceBatchRun 不改动原有状态对象（可安全持久化旧快照）", () => {
  const state = sampleState({ data: { tweets: [{ id: "0" }] } });
  const next = advanceBatchRun(state, "karpathy", { tweets: [{ id: "1" }] });
  expect(state.nextIndex).toBe(0);
  expect(state.data.tweets).toHaveLength(1);
  expect(next.data.tweets).toHaveLength(2);
});

test("describeBatchRun 汇报进度与记录数", () => {
  const state = sampleState({ completedKeywords: 2 });
  state.data = { tweets: [{ id: "1" }, { id: "2" }, { id: "3" }] };
  expect(describeBatchRun(state)).toBe("正在运行 · 2/3 个输入 · 3 条记录");
  expect(describeBatchRun({ ...state, status: "paused" })).toBe("已暂停 · 2/3 个输入 · 3 条记录");
});

test("buildBatchRunResultFromState 保留数据与状态语义", () => {
  const state = sampleState({ status: "paused", completedKeywords: 1 });
  const result = buildBatchRunResultFromState(state, "paused", "已暂停：完成 1/3 个输入。");
  expect(result.status).toBe("paused");
  expect(result.data).toBe(state.data);
  expect(result.error).toContain("1/3");
});

test("控制请求按工具隔离：定向请求只被目标工具消费", () => {
  clearControlRequest();
  requestPauseBatchRun("twitter-timeline");
  // 并行运行的其他工具不受影响，也不会消费掉定向请求。
  expect(consumeControlRequest("xhs-notes").pause).toBe(false);
  expect(consumeControlRequest("twitter-timeline").pause).toBe(true);
  expect(consumeControlRequest("twitter-timeline").pause).toBe(false);
});

test("全局控制请求对所有工具生效，清理时一并移除", () => {
  clearControlRequest();
  requestStopBatchRun();
  expect(consumeControlRequest("twitter-timeline").stop).toBe(true);
  expect(consumeControlRequest("xhs-notes").stop).toBe(true);
  // 定向清理会把全局请求一并清掉，避免新运行被遗留请求误停。
  clearControlRequest("xhs-notes");
  expect(consumeControlRequest("twitter-timeline").stop).toBe(false);
});

test("isTransientBatchError 只把瞬时网络错误判为可重试", () => {
  expect(isTransientBatchError("页面内请求失败：Failed to fetch")).toBe(true);
  expect(isTransientBatchError("TypeError: Failed to fetch")).toBe(true);
  expect(isTransientBatchError("net::ERR_CONNECTION_RESET")).toBe(true);
  expect(isTransientBatchError("等待元素超时：.checkin-btn")).toBe(true);
  expect(isTransientBatchError("Could not establish connection. Receiving end does not exist.")).toBe(true);
  // 限流与登录态问题不能靠重试解决，必须立即停止
  expect(isTransientBatchError("x.com 返回 429 限流，请降低抓取频率并稍后重试。")).toBe(false);
  expect(isTransientBatchError("x.com 拒绝了请求（HTTP 401），登录态可能已过期。")).toBe(false);
  expect(isTransientBatchError("无法解析 UserTweets 的 queryId。")).toBe(false);
});
