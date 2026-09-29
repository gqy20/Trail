import type { CollectorJob } from "./types";

const RETRY_LIMIT_PER_DAY = 3;
const RETRY_SPACING_MS = 30 * 60_000;

function dayKey(now: number): string {
  return new Date(now).toLocaleDateString("sv-SE");
}

/** 间隔型任务到期判断：距上次成功不足间隔、运行中、待人工处理都不到期。 */
export function isCollectorDue(job: CollectorJob, now: number): boolean {
  if (!job.enabled || job.status === "running" || job.status === "needs_user") return false;
  const lastSuccess = job.lastSuccessAt || 0;
  if (lastSuccess > 0 && now - lastSuccess < job.intervalHours * 3_600_000) return false;
  if (job.attemptDay === dayKey(now) && (job.attempts || 0) >= RETRY_LIMIT_PER_DAY) return false;
  return !job.lastAttemptAt || now - job.lastAttemptAt >= RETRY_SPACING_MS;
}

export function clampIntervalHours(value: number): number {
  if (!Number.isFinite(value)) return 4;
  return Math.min(48, Math.max(1, Math.round(value)));
}
