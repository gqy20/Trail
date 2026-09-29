import { test, expect } from "@playwright/test";
import { advanceBatchRun, describeBatchRun, buildBatchRunResultFromState, type BatchRunState } from "../src/background/runControl";

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
