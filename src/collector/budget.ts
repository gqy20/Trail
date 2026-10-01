import { logDebug, logInfo, logWarn } from "../logging/logger";

/** 平台独立的 24 小时滚动预算。分钟是浏览量估算，不是实际运行时间。 */
const KEY = "trail.activityBudget.v2";
const CONFIG_KEY = "trail.activityBudgetConfig.v1";
const WINDOW_MS = 24 * 60 * 60_000;
export type BudgetKind = "profile" | "detail";
export const BUDGET_COST = { profile: 2, detail: 1 } as const;
export const DEFAULT_BUDGET_CONFIG = { hours: 6, profileIntervalSeconds: 15, detailIntervalSeconds: 5 };
export type BudgetConfig = typeof DEFAULT_BUDGET_CONFIG & { profileLimit?: number; detailLimit?: number };
type Event = { kind: BudgetKind; at: number };
type Ledger = Record<string, Event[]>;
export type BudgetState = { platform: string; config: BudgetConfig; used: number; limit: number; profile: number; detail: number; nextAvailableAt?: number };
export type BudgetReservation = BudgetState & { allowed: boolean; delayMs: number; reservedAt?: number };
let writes: Promise<unknown> = Promise.resolve();

function serialized<T>(action: () => Promise<T>): Promise<T> {
  const next = writes.then(action);
  writes = next.catch(() => undefined);
  return next;
}
function validatePlatform(platform: string) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(platform)) throw new Error("无效的采集平台。");
}
export function validateBudgetConfig(config: BudgetConfig): BudgetConfig {
  if (!Number.isFinite(config.hours) || config.hours < 1 || config.hours > 24
    || !Number.isInteger(config.profileIntervalSeconds) || config.profileIntervalSeconds < 1 || config.profileIntervalSeconds > 3600
    || !Number.isInteger(config.detailIntervalSeconds) || config.detailIntervalSeconds < 1 || config.detailIntervalSeconds > 3600) throw new Error("预算需为 1–24 小时，访问间隔需为 1–3600 秒。");
  for (const cap of [config.profileLimit, config.detailLimit]) if (cap !== undefined && (!Number.isInteger(cap) || cap < 0 || cap > 10000)) throw new Error("访问次数上限需为 0–10000，0 表示仅按浏览量限制。");
  return { profileLimit: config.profileLimit ?? 0, detailLimit: config.detailLimit ?? 0, hours: config.hours, profileIntervalSeconds: config.profileIntervalSeconds, detailIntervalSeconds: config.detailIntervalSeconds };
}
/** 保留旧纯函数测试入口；边界恰好 24 小时的记录已过期。 */
export function pruneAndCheck(timestamps: number[], now: number, limit: number, count = 1) {
  const kept = timestamps.filter((at) => now - at < WINDOW_MS);
  return { allowed: kept.length + count <= limit, used: kept.length, kept };
}
export function evaluateBudget(platform: string, events: Event[], config: BudgetConfig, now: number, kind: BudgetKind = "profile"): BudgetReservation {
  const kept = events.filter((event) => now - event.at < WINDOW_MS).sort((a, b) => a.at - b.at);
  const used = kept.reduce((sum, event) => sum + BUDGET_COST[event.kind], 0);
  const limit = Math.round(config.hours * 60);
  const countLimit = (kind === "profile" ? config.profileLimit : config.detailLimit) || Infinity;
  let remainingCount = kept.filter((event) => event.kind === kind).length;
  const allowed = used + BUDGET_COST[kind] <= limit && remainingCount + 1 <= countLimit;
  let remaining = used;
  let nextAvailableAt: number | undefined;
  if (!allowed) for (const event of kept) {
    remaining -= BUDGET_COST[event.kind];
    if (event.kind === kind) remainingCount -= 1;
    if (remaining + BUDGET_COST[kind] <= limit && remainingCount + 1 <= countLimit) { nextAvailableAt = event.at + WINDOW_MS; break; }
  }
  const last = kept[kept.length - 1];
  const baseInterval = (kind === "profile" ? config.profileIntervalSeconds : config.detailIntervalSeconds) * 1000;
  // 间隔加 ±30% 随机偏移，消除等间隔访问模式。
  const jitter = baseInterval * 0.3;
  const intervalMs = baseInterval + (Math.random() - 0.5) * jitter * 2;
  return { platform, config, used, limit, allowed, nextAvailableAt, delayMs: last ? Math.max(0, last.at + intervalMs - now) : 0,
    profile: kept.filter((event) => event.kind === "profile").length, detail: kept.filter((event) => event.kind === "detail").length };
}
export async function getBudgetUsage(platforms: string[]): Promise<BudgetState[]> {
  await writes;
  const data = await chrome.storage.local.get([KEY, CONFIG_KEY]);
  const ledger = (data[KEY] || {}) as Ledger;
  const configs = (data[CONFIG_KEY] || {}) as Record<string, BudgetConfig>;
  return [...new Set(platforms)].map((platform) => { validatePlatform(platform); return evaluateBudget(platform, ledger[platform] || [], configs[platform] || DEFAULT_BUDGET_CONFIG, Date.now()); });
}
export async function saveBudgetConfig(platform: string, config: BudgetConfig): Promise<void> {
  validatePlatform(platform);
  const next = validateBudgetConfig(config);
  await serialized(async () => {
    const data = await chrome.storage.local.get(CONFIG_KEY);
    const previous = ((data[CONFIG_KEY] || {}) as Record<string, BudgetConfig>)[platform] || DEFAULT_BUDGET_CONFIG;
    await chrome.storage.local.set({ [CONFIG_KEY]: { ...(data[CONFIG_KEY] || {}), [platform]: next } });
    logInfo("budget", "budget.config.changed", "更新平台采集预算", { platform, previous, config: next });
  });
}
/** 串行预留每次访问尝试，避免并发超额；返回间隔由调用端可中断地等待。 */
export async function recordActivity(platform: string, kind: BudgetKind): Promise<BudgetReservation> {
  validatePlatform(platform);
  return serialized(async () => {
    const data = await chrome.storage.local.get([KEY, CONFIG_KEY]);
    const ledger = (data[KEY] || {}) as Ledger;
    const config = ((data[CONFIG_KEY] || {}) as Record<string, BudgetConfig>)[platform] || DEFAULT_BUDGET_CONFIG;
    const now = Date.now();
    const state = evaluateBudget(platform, ledger[platform] || [], config, now, kind);
    if (!state.allowed) { logWarn("budget", "budget.denied", "访问预算不足，保留进度", { ...state, kind }); return state; }
    const kept = (ledger[platform] || []).filter((event) => now - event.at < WINDOW_MS);
    ledger[platform] = [...kept, { kind, at: now + state.delayMs }];
    await chrome.storage.local.set({ [KEY]: ledger });
    logDebug("budget", "budget.reserved", state.delayMs ? "等待平台访问间隔" : "预留平台访问用量", { platform, kind, config, used: state.used + BUDGET_COST[kind], limit: state.limit, profile: state.profile + (kind === "profile" ? 1 : 0), detail: state.detail + (kind === "detail" ? 1 : 0), delayMs: state.delayMs, reservedAt: now + state.delayMs });
    return { ...state, used: state.used + BUDGET_COST[kind], [kind]: state[kind] + 1, reservedAt: now + state.delayMs };
  });
}
/** 等待期间取消且尚未访问时退还预留。已发起的访问（包括重试）不退还。 */
export async function releaseActivity(state: BudgetReservation, kind: BudgetKind): Promise<void> {
  if (state.reservedAt === undefined) return;
  await serialized(async () => {
    const data = await chrome.storage.local.get(KEY);
    const ledger = (data[KEY] || {}) as Ledger;
    const events = ledger[state.platform] || [];
    const index = events.findIndex((event) => event.kind === kind && event.at === state.reservedAt);
    if (index < 0) return;
    events.splice(index, 1);
    logInfo("budget", "budget.released", "取消等待，退还未访问用量", { platform: state.platform, kind, reservedAt: state.reservedAt });
    await chrome.storage.local.set({ [KEY]: ledger });
  });
}
export function budgetPauseReason(state: BudgetReservation): string {
  const name = state.platform === "twitter" ? "X" : state.platform === "xhs" ? "小红书" : state.platform;
  const recovery = state.nextAvailableAt ? `最早 ${new Date(state.nextAvailableAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} 释放所需额度` : "额度按 24 小时滚动窗口释放";
  return `${name} 近 24 小时访问预算不足（${state.used}/${state.limit} 分钟等效量；主页 ${state.profile}${state.config.profileLimit ? `/${state.config.profileLimit}` : ""} 次，详情 ${state.detail}${state.config.detailLimit ? `/${state.config.detailLimit}` : ""} 次），${recovery}；进度已保存，额度恢复或调整预算后请点继续。`;
}
