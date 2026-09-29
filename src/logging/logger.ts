/**
 * Trail 结构化日志：后台关键路径打点，持久化到 chrome.storage.local
 * 的环形缓冲（保留最新 N 条），并镜像到控制台便于 DevTools 实时调试。
 * 任何包含 token/cookie/CSRF 等敏感键的数据在写入前脱敏。
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  ts: number;
  level: LogLevel;
  /** 打点区域：batch / graphql / feed / run / tool。 */
  scope: string;
  /** 稳定事件名（点分），便于过滤与统计，如 keyword.retry、publish.done。 */
  event: string;
  message: string;
  data?: Record<string, unknown>;
};

export const LOG_STORE_KEY = "trail.logs.v1";
const MAX_LOG_ENTRIES = 600;
const MAX_DATA_TEXT = 400;
const SENSITIVE_KEY_PATTERN = /token|cookie|authorization|csrf|ct0|password|secret|bearer/i;

let writeChain: Promise<void> = Promise.resolve();

function log(level: LogLevel, scope: string, event: string, message: string, data?: Record<string, unknown>): void {
  const entry: LogEntry = { ts: Date.now(), level, scope, event, message };
  const safeData = data ? redactLogData(data) : undefined;
  if (safeData && Object.keys(safeData).length > 0) entry.data = safeData;
  mirrorToConsole(entry);
  writeChain = writeChain.then(() => appendLogEntries([entry])).catch(() => undefined);
}

export function logDebug(scope: string, event: string, message: string, data?: Record<string, unknown>): void {
  log("debug", scope, event, message, data);
}

export function logInfo(scope: string, event: string, message: string, data?: Record<string, unknown>): void {
  log("info", scope, event, message, data);
}

export function logWarn(scope: string, event: string, message: string, data?: Record<string, unknown>): void {
  log("warn", scope, event, message, data);
}

export function logError(scope: string, event: string, message: string, data?: Record<string, unknown>): void {
  log("error", scope, event, message, data);
}

export async function getLogEntries(): Promise<LogEntry[]> {
  const result = await chrome.storage.local.get(LOG_STORE_KEY);
  return (result[LOG_STORE_KEY] as LogEntry[] | undefined) || [];
}

export async function clearLogEntries(): Promise<void> {
  await chrome.storage.local.remove(LOG_STORE_KEY);
}

/** 追加日志并裁剪到上限（串行化写入，避免读-改-写竞争）。 */
async function appendLogEntries(incoming: LogEntry[]): Promise<void> {
  const result = await chrome.storage.local.get(LOG_STORE_KEY);
  const existing = (result[LOG_STORE_KEY] as LogEntry[] | undefined) || [];
  await chrome.storage.local.set({ [LOG_STORE_KEY]: trimLogEntries([...existing, ...incoming], MAX_LOG_ENTRIES) });
}

/** 纯函数：保留最新 max 条。 */
export function trimLogEntries(entries: LogEntry[], max: number): LogEntry[] {
  return entries.slice(Math.max(0, entries.length - Math.max(1, max)));
}

/** 纯函数：脱敏敏感键并截断超长值。 */
export function redactLogData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      out[key] = "[已脱敏]";
      continue;
    }
    out[key] = clampLogValue(value);
  }
  return out;
}

function clampLogValue(value: unknown): unknown {
  if (typeof value === "string") return value.length > MAX_DATA_TEXT ? `${value.slice(0, MAX_DATA_TEXT)}…` : value;
  if (value === null || value === undefined || typeof value !== "object") return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > MAX_DATA_TEXT ? `${serialized.slice(0, MAX_DATA_TEXT)}…` : value;
  } catch {
    return "[不可序列化]";
  }
}

function mirrorToConsole(entry: LogEntry): void {
  const prefix = `[trail:${entry.scope}] ${entry.event}`;
  const args: unknown[] = entry.data ? [prefix, entry.message, entry.data] : [prefix, entry.message];
  const sink = entry.level === "error" ? console.error : entry.level === "warn" ? console.warn : entry.level === "debug" ? console.debug : console.info;
  sink(...args);
}

/** 导出为人读文本（每行一条，便于贴进 issue）。 */
export function formatLogEntriesText(entries: LogEntry[]): string {
  return entries
    .map((entry) => {
      const time = new Date(entry.ts).toLocaleString("sv-SE", { hour12: false });
      const data = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
      return `${time} [${entry.level}] [${entry.scope}] ${entry.event} — ${entry.message}${data}`;
    })
    .join("\n");
}
