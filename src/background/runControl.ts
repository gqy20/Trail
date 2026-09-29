import type { BrowserToolRunResult } from "../browser-tools/contracts";

export type BatchRunStatus = "running" | "paused" | "completed" | "stopped" | "failed";

/**
 * 批量采集的运行状态。写入 chrome.storage.session：
 * 浏览器会话内 Service Worker 重启不丢进度，浏览器关闭后自然清空。
 */
export type BatchRunState = {
  runId: string;
  toolId: string;
  toolName: string;
  keywords: string[];
  nextIndex: number;
  completedKeywords: number;
  parameters: Record<string, unknown>;
  tabId?: number;
  status: BatchRunStatus;
  /** 用户已请求但尚未生效的暂停/停止；运行循环在边界消费并清除。 */
  pendingControl?: "pause" | "stop";
  startedAt: number;
  updatedAt: number;
  lastPageUrl: string;
  lastPageTitle: string;
  data: Record<string, Array<Record<string, unknown>>>;
};

const STATE_KEY = "trail.browserToolBatchRun.v1";
/** running 状态超过该时长没有心跳视为中断（Service Worker 被回收）。 */
const STALE_RUNNING_MS = 120_000;

/** 只存在于内存的控制请求，由运行循环在每个账号边界消费。 */
type ControlRequest = { pause: boolean; stop: boolean };
let controlRequest: ControlRequest = { pause: false, stop: false };

/**
 * 判断批量错误是否为瞬时网络类（页面导航中断、连接抖动等）。
 * 这类错误值得对当前输入重试一次；限流、登录态失效则必须立即停止。
 */
const TRANSIENT_ERROR_PATTERNS: RegExp[] = [
  /failed to fetch/i,
  /页面内请求失败/,
  /networkerror/i,
  /net::err/i,
  /err_connection/i,
  /err_timed_out/i,
  /请求超时/,
  /等待元素超时/
];

export function isTransientBatchError(message: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export async function getBatchRunState(): Promise<BatchRunState | null> {
  const result = await chrome.storage.session.get(STATE_KEY);
  const state = result[STATE_KEY] as BatchRunState | undefined;
  if (!state) return null;
  if (state.status === "running" && Date.now() - state.updatedAt > STALE_RUNNING_MS) {
    // 运行循环已不存在（SW 重启），降级为暂停，允许用户继续。
    const interrupted = { ...state, status: "paused" as BatchRunStatus };
    await saveBatchRunState(interrupted);
    return interrupted;
  }
  return state;
}

export async function saveBatchRunState(state: BatchRunState): Promise<void> {
  await chrome.storage.session.set({ [STATE_KEY]: state });
}

export async function clearBatchRunState(): Promise<void> {
  await chrome.storage.session.remove(STATE_KEY);
}

export function requestPauseBatchRun(): { requested: boolean } {
  controlRequest = { pause: true, stop: false };
  void persistPendingControl('pause');
  return { requested: true };
}

export function requestStopBatchRun(): { requested: boolean } {
  controlRequest = { pause: false, stop: true };
  void persistPendingControl('stop');
  return { requested: true };
}

/** 把待生效的控制请求写入状态，供 UI 即时反馈与 SW 重启后的恢复。 */
async function persistPendingControl(control: 'pause' | 'stop'): Promise<void> {
  try {
    const state = await getBatchRunState();
    if (state && state.status === 'running') {
      await saveBatchRunState({ ...state, pendingControl: control, updatedAt: Date.now() });
    }
  } catch {
    // 状态写入失败不影响内存标志生效。
  }
}

/** 不消费地查看当前控制请求；长循环（如详情补全）用它提前响应暂停/停止。 */
export function peekControlRequest(): ControlRequest {
  return { ...controlRequest };
}

/** 运行循环在账号边界调用：取出当前控制请求并复位。 */
export function consumeControlRequest(): ControlRequest {
  const current = controlRequest;
  controlRequest = { pause: false, stop: false };
  return current;
}

export function clearControlRequest(): void {
  controlRequest = { pause: false, stop: false };
}

/** 由运行结果构造面向 UI 的摘要。 */
export function describeBatchRun(state: BatchRunState): string {
  const total = state.keywords.length;
  const done = state.completedKeywords;
  const records = Object.values(state.data).reduce((sum, list) => sum + list.length, 0);
  const statusText: Record<BatchRunStatus, string> = {
    running: "正在运行",
    paused: "已暂停",
    completed: "已完成",
    stopped: "已停止",
    failed: "失败"
  };
  return `${statusText[state.status]} · ${done}/${total} 个输入 · ${records} 条记录`;
}

/** 累积记录到运行状态并推进游标（纯函数，便于测试）。 */
export function advanceBatchRun(
  state: BatchRunState,
  keyword: string,
  recordsByCollection: Record<string, Array<Record<string, unknown>>>
): BatchRunState {
  const data: BatchRunState["data"] = {};
  for (const [collection, list] of Object.entries(state.data)) data[collection] = [...list];
  for (const [collection, records] of Object.entries(recordsByCollection)) {
    const target = (data[collection] ||= []);
    target.push(...records.map((record) => ({ _query: keyword, ...record })));
  }
  return {
    ...state,
    data,
    nextIndex: state.nextIndex + 1,
    completedKeywords: state.completedKeywords + 1,
    updatedAt: Date.now()
  };
}

/** 用累积状态构造运行结果（暂停/停止/中断时的收尾）。 */
export function buildBatchRunResultFromState(
  state: BatchRunState,
  status: BrowserToolRunResult["status"],
  error?: string
): Pick<BrowserToolRunResult, "status" | "data" | "error"> {
  return { status, data: state.data, error };
}
