import type { FollowEntry, FollowsImportResult } from "./types";

const KEY = "trail.follows.v1";
const MAX_FOLLOWS = 200;

async function readAll(): Promise<FollowEntry[]> {
  const result = await chrome.storage.local.get(KEY);
  return (result[KEY] as FollowEntry[] | undefined) || [];
}

export async function getFollows(platform?: string): Promise<FollowEntry[]> {
  const all = await readAll();
  return platform ? all.filter((entry) => entry.platform === platform) : all;
}

export async function addFollow(entry: FollowEntry): Promise<FollowEntry[]> {
  return mergeFollows(await readAll(), [entry]);
}

export async function removeFollow(platform: string, handle: string): Promise<FollowEntry[]> {
  const next = (await readAll()).filter((entry) => !(entry.platform === platform && entry.handle === handle));
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** 导入文本：每行一个账号（txt），或带 handle,priority,name 表头/无表头的 CSV。 */
export async function importFollows(platform: string, text: string): Promise<FollowsImportResult> {
  const entries = parseFollowsText(platform, text);
  if (entries.length === 0) throw new Error("没有解析到有效账号。");
  return applyImport(await readAll(), entries);
}

async function mergeFollows(existing: FollowEntry[], incoming: FollowEntry[]): Promise<FollowEntry[]> {
  await chrome.storage.local.set({ [KEY]: applyImport(existing, incoming).entries });
  return readAll();
}

/** 纯函数：按 平台+账号 合并去重，新值仅在原值缺失时补充元数据，总量封顶。 */
export function applyImport(existing: FollowEntry[], incoming: FollowEntry[]): FollowsImportResult & { entries: FollowEntry[] } {
  const byKey = new Map<string, FollowEntry>();
  for (const entry of existing) byKey.set(keyOf(entry), entry);
  let added = 0;
  let updated = 0;
  for (const raw of incoming) {
    const entry = normalizeFollow(raw);
    if (!entry) continue;
    const current = byKey.get(keyOf(entry));
    if (!current) {
      added += 1;
      byKey.set(keyOf(entry), entry);
    } else {
      const merged: FollowEntry = { ...current };
      let changed = false;
      if (entry.displayName && !merged.displayName) { merged.displayName = entry.displayName; changed = true; }
      if (entry.priority !== undefined && merged.priority !== entry.priority) { merged.priority = entry.priority; changed = true; }
      if (changed) {
        updated += 1;
        byKey.set(keyOf(entry), merged);
      }
    }
  }
  const entries = [...byKey.values()].sort(compareFollows).slice(0, MAX_FOLLOWS);
  return { added, updated, total: entries.length, entries };
}

export function parseFollowsText(platform: string, text: string): FollowEntry[] {
  const entries: FollowEntry[] = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const isCsv = lines.length > 0 && lines.some((line) => (line.match(/,/g) || []).length >= 1);
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("#")) continue;
    if (isCsv) {
      const cells = line.split(",").map((cell) => cell.trim());
      if (index === 0 && /handle|用户名|账号/i.test(cells[0])) continue; // 表头
      const handle = (cells[0] || "").replace(/^@/, "");
      if (!handle || /[, ]/.test(handle)) continue;
      entries.push({
        platform,
        handle,
        priority: cells[1] && /^\d+$/.test(cells[1]) ? Number(cells[1]) : undefined,
        displayName: cells[2] || undefined
      });
    } else {
      const handle = line.split(/[\s,，]/)[0].replace(/^@/, "");
      if (handle) entries.push({ platform, handle });
    }
  }
  return entries;
}

export function normalizeFollow(entry: FollowEntry): FollowEntry | null {
  const handle = String(entry.handle || "").trim().replace(/^@/, "");
  const platform = String(entry.platform || "").trim().toLowerCase();
  if (!handle || !platform || /\s/.test(handle)) return null;
  const result: FollowEntry = { platform, handle };
  if (entry.displayName?.trim()) result.displayName = entry.displayName.trim();
  if (typeof entry.priority === "number" && Number.isFinite(entry.priority)) result.priority = entry.priority;
  return result;
}

function keyOf(entry: FollowEntry): string {
  return `${entry.platform}\n${entry.handle}`;
}

function compareFollows(a: FollowEntry, b: FollowEntry): number {
  const priorityDiff = (b.priority || 0) - (a.priority || 0);
  if (priorityDiff !== 0) return priorityDiff;
  return a.handle.localeCompare(b.handle);
}
