/**
 * 增量采集水位线：按 平台+账号 记录最近一次成功采集到的最新发布时间。
 * 首次无水位线时用回填窗口（如 7 天），之后只保留发布时间晚于水位线的记录，
 * 已采过的内容不再进入详情补全与暂存，节约行为预算。
 */

const KEY = "trail.watermarks.v1";

export type WatermarkMap = Record<string, string>;

async function readMap(): Promise<WatermarkMap> {
  const result = await chrome.storage.local.get(KEY);
  return (result[KEY] as WatermarkMap | undefined) || {};
}

export function watermarkKey(platform: string, handle: string): string {
  return `${platform}:${handle}`;
}

export async function getWatermark(platform: string, handle: string): Promise<string | undefined> {
  return (await readMap())[watermarkKey(platform, handle)];
}

export async function setWatermark(platform: string, handle: string, iso: string): Promise<void> {
  const map = await readMap();
  const key = watermarkKey(platform, handle);
  const current = map[key];
  if (current && Date.parse(current) >= Date.parse(iso)) return;
  map[key] = iso;
  await chrome.storage.local.set({ [KEY]: map });
}

/** 手动重置水位线到目标时间（回填入口），忽略"只增不减"保护。 */
export async function resetWatermark(platform: string, handle: string, iso: string): Promise<void> {
  const map = await readMap();
  map[watermarkKey(platform, handle)] = iso;
  await chrome.storage.local.set({ [KEY]: map });
}

/**
 * 纯函数：按水位线过滤记录。
 * - 有水位线：保留 created_at >= 水位线 的记录
 * - 无水位线（首次）：保留 created_at >= now - lookbackDays 的记录
 * 返回保留记录与其中最新/最旧时间（推进水位线用）。
 */
export function filterSinceRecords(
  records: Array<Record<string, unknown>>,
  field: string,
  watermarkIso: string | undefined,
  lookbackDays: number,
  now = Date.now()
): { kept: Array<Record<string, unknown>>; newestIso?: string; oldestIso?: string } {
  const threshold = watermarkIso
    ? Date.parse(watermarkIso)
    : now - Math.max(1, lookbackDays) * 24 * 60 * 60_000;
  const kept: Array<Record<string, unknown>> = [];
  let newest: number | undefined;
  let oldest: number | undefined;
  for (const record of records) {
    const raw = record[field];
    if (typeof raw !== "string") {
      kept.push(record);
      continue;
    }
    const time = Date.parse(raw);
    if (!Number.isFinite(time) || time < threshold) continue;
    kept.push(record);
    if (newest === undefined || time > newest) newest = time;
    if (oldest === undefined || time < oldest) oldest = time;
  }
  return {
    kept,
    newestIso: newest !== undefined ? new Date(newest).toISOString() : undefined,
    oldestIso: oldest !== undefined ? new Date(oldest).toISOString() : undefined
  };
}
