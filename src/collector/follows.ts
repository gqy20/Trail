import type { FollowEntry, FollowsImportResult } from "./types";
import { parseCsv } from "../literature-queue/csv";

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
  return removeFollows(platform, [handle]);
}

export async function removeFollows(platform: string, handles: string[]): Promise<FollowEntry[]> {
  const selected = new Set(handles);
  const next = (await readAll()).filter((entry) => entry.platform !== platform || !selected.has(entry.handle));
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

/** 采集时从平台实时数据刷新用户资料（显示名 + 头像），覆盖旧值。 */
export async function updateFollowProfile(platform: string, handle: string, profile: { displayName?: string; avatar?: string }): Promise<void> {
  const all = await readAll();
  const entry = all.find((e) => e.platform === platform && e.handle === handle);
  if (!entry) return;
  if (profile.displayName?.trim()) entry.displayName = profile.displayName.trim();
  if (profile.avatar?.trim()) entry.avatar = profile.avatar.trim();
  await chrome.storage.local.set({ [KEY]: all });
}

export function exportFollowsCsv(entries: FollowEntry[]): string {
  const cell = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  return ["handle,priority,name", ...entries.map((entry) => [entry.handle, entry.priority, entry.displayName].map(cell).join(","))].join("\r\n");
}

/** 导入文本：每行一个账号（txt），或带 handle,priority,name 表头/无表头的 CSV。 */
export async function importFollows(platform: string, text: string): Promise<FollowsImportResult> {
  const entries = parseFollowsText(platform, text);
  if (entries.length === 0) throw new Error("没有解析到有效账号。");
  const result = applyImport(await readAll(), entries);
  // applyImport 是纯函数，这里必须落盘——此前漏掉导致导入计数正常但刷新即丢。
  await chrome.storage.local.set({ [KEY]: result.entries });
  return result;
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
  const rows = isCsv ? parseCsv(text).filter((row) => row.some((cell) => cell.trim())) : lines.map((line) => [line]);
  const header = rows[0]?.map((cell) => cell.trim().toLowerCase()) || [];
  const hasHeader = /handle|用户名|账号/i.test(header[0] || "");
  const priorityIndex = hasHeader ? header.indexOf("priority") : 1;
  const nameIndex = hasHeader ? header.findIndex((cell) => cell === "name" || cell === "displayname") : 2;
  for (const [index, row] of rows.entries()) {
    const line = row[0]?.trim() || "";
    if (line.startsWith("#")) continue;
    if (isCsv) {
      const cells = row.map((cell) => cell.trim());
      if (index === 0 && hasHeader) continue;
      const handle = (cells[0] || "").replace(/^@/, "");
      if (!handle || /[, ]/.test(handle)) continue;
      entries.push({
        platform,
        handle,
        priority: cells[priorityIndex] && /^\d+$/.test(cells[priorityIndex]) ? Number(cells[priorityIndex]) : undefined,
        displayName: cells[nameIndex] || undefined
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
