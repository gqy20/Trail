/**
 * 活动预算账本：24 小时滚动窗口内的主页/详情访问时间戳。
 * 跨轮次、跨手动/定时的总量硬顶，防止累积 velocity 触发风控升级
 * （opencli #2208 的持久化实现）。
 */

const KEY = "trail.activityBudget.v1";
const WINDOW_MS = 24 * 60 * 60_000;

export const BUDGET_LIMITS = { profile: 30, detail: 40 } as const;
export type BudgetKind = keyof typeof BUDGET_LIMITS;

type Ledger = { profile: number[]; detail: number[] };

/** 纯函数：裁剪过期时间戳并判定本次请求是否放行（不写入）。 */
export function pruneAndCheck(
  timestamps: number[],
  now: number,
  limit: number,
  count = 1
): { allowed: boolean; used: number; kept: number[] } {
  const kept = timestamps.filter((ts) => now - ts < WINDOW_MS);
  return { allowed: kept.length + count <= limit, used: kept.length, kept };
}

async function readLedger(): Promise<Ledger> {
  const result = await chrome.storage.local.get(KEY);
  return (result[KEY] as Ledger | undefined) || { profile: [], detail: [] };
}

async function writeLedger(ledger: Ledger): Promise<void> {
  await chrome.storage.local.set({ [KEY]: ledger });
}

/** 记录一次访问；超预算时拒绝并返回当前用量（不记录）。 */
export async function recordActivity(kind: BudgetKind, count = 1): Promise<{ allowed: boolean; used: number; limit: number }> {
  const ledger = await readLedger();
  const check = pruneAndCheck(ledger[kind], Date.now(), BUDGET_LIMITS[kind], count);
  if (!check.allowed) return { allowed: false, used: check.used, limit: BUDGET_LIMITS[kind] };
  ledger[kind] = [...check.kept, ...Array.from({ length: count }, () => Date.now())];
  await writeLedger(ledger);
  return { allowed: true, used: ledger[kind].length, limit: BUDGET_LIMITS[kind] };
}

export async function getBudgetUsage(): Promise<Record<BudgetKind, { used: number; limit: number }>> {
  const ledger = await readLedger();
  const now = Date.now();
  const read = (kind: BudgetKind) => {
    const check = pruneAndCheck(ledger[kind], now, BUDGET_LIMITS[kind], 0);
    return { used: check.used, limit: BUDGET_LIMITS[kind] };
  };
  return { profile: read("profile"), detail: read("detail") };
}
