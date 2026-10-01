/**
 * 本地已采集 ID 索引：按平台永久存储已成功采集并补全详情的内容 ID。
 * 发布清空暂存后索引保留，用于：
 * 1. 详情补全前快速判断"已采过"→ 跳过，不浪费详情访问预算
 * 2. 本地去重核对，不依赖远端 GitHub
 */

const KEY_PREFIX = "trail.collectedIds.";
const MAX_IDS_PER_PLATFORM = 10000;

async function readIds(platform: string): Promise<Set<string>> {
  const result = await chrome.storage.local.get(KEY_PREFIX + platform);
  const ids = (result[KEY_PREFIX + platform] as string[] | undefined) || [];
  return new Set(ids);
}

async function writeIds(platform: string, ids: Set<string>): Promise<void> {
  // FIFO 截断：超过上限时保留最新的（假设近期核对频率更高）。
  const arr = [...ids].slice(-MAX_IDS_PER_PLATFORM);
  await chrome.storage.local.set({ [KEY_PREFIX + platform]: arr });
}

/** 批量记录已采集的 ID（追加，去重）。 */
export async function recordCollectedIds(platform: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const existing = await readIds(platform);
  for (const id of ids) existing.add(id);
  await writeIds(platform, existing);
}

/** 检查哪些 ID 已采集过，返回未采集的（需要补全详情的）。 */
export async function filterUncollected(platform: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const existing = await readIds(platform);
  return ids.filter((id) => !existing.has(id));
}

/** 检查单个 ID 是否已采集。 */
export async function isCollected(platform: string, id: string): Promise<boolean> {
  return (await readIds(platform)).has(id);
}
