import type { CheckinJob } from "./types";

export function localClock(now: number, timezone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return { day: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

export function isCheckinDue(job: CheckinJob, timezone: string, now: number): boolean {
  const clock = localClock(now, timezone);
  if (!job.enabled || job.status === "running" || job.status === "needs_user") return false;
  if (job.lastSuccessDay === clock.day || clock.time < job.time) return false;
  if (job.attemptDay === clock.day && (job.attempts || 0) >= 3) return false;
  return !job.lastAttemptAt || now - job.lastAttemptAt >= 30 * 60_000;
}
