import { normalizeFeedPost } from "./merge";
import type { FeedConnectionState, FeedPost, FeedPublisherConfig, FeedPublisherSnapshot, FeedPublishState } from "./types";

const STORE_KEY = "trail.feedPublisher.v1";
const MAX_STAGED_POSTS = 2000;

type FeedStore = {
  config?: FeedPublisherConfig;
  staged?: FeedPost[];
  state?: FeedPublishState;
};

async function readStore(): Promise<FeedStore> {
  const result = await chrome.storage.local.get(STORE_KEY);
  return (result[STORE_KEY] as FeedStore | undefined) || {};
}

async function writeStore(store: FeedStore): Promise<void> {
  await chrome.storage.local.set({ [STORE_KEY]: store });
}

export async function getFeedPublisherSnapshot(): Promise<FeedPublisherSnapshot> {
  const store = await readStore();
  // 一次性迁移：旧默认封顶 5000 上滚到新默认 20000（用户显式设过其他值则不动）。
  if (store.config?.maxPosts === 5000) {
    store.config = { ...store.config, maxPosts: 20000 };
    await writeStore(store);
  }
  return {
    config: store.config || null,
    stagedCount: store.staged?.length || 0,
    state: store.state || {}
  };
}

export function normalizeFeedConfig(input: FeedPublisherConfig): FeedPublisherConfig {
  const owner = input.owner.trim();
  const repo = input.repo.trim();
  const branch = (input.branch || "main").trim() || "main";
  const token = input.token.trim();
  const missing: string[] = [];
  if (!owner) missing.push("owner");
  if (!repo) missing.push("仓库");
  if (!token) missing.push("token");
  if (missing.length > 0) throw new Error(`${missing.join("、")}不能为空。`);
  const pagesBaseUrl = input.pagesBaseUrl?.trim() || undefined;
  if (pagesBaseUrl && !/^https?:\/\//.test(pagesBaseUrl)) throw new Error("Pages 地址必须以 http(s):// 开头。");
  const clamp = (value: number, min: number, max: number, fallback: number) =>
    Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback;
  return {
    owner,
    repo,
    branch,
    token,
    maxPosts: clamp(input.maxPosts, 100, 50000, 20000),
    itemsPerFeed: clamp(input.itemsPerFeed, 10, 5000, 2000),
    pagesBaseUrl,
    autoPublish: input.autoPublish === true,
    excludeRetweets: input.excludeRetweets === true
  };
}

export async function saveFeedConfig(input: FeedPublisherConfig): Promise<void> {
  const store = await readStore();
  const config = normalizeFeedConfig(input);
  const unchanged = store.config && sameFeedConnectionConfig(store.config, config);
  await writeStore({ ...store, config, state: { ...store.state, connection: unchanged ? store.state?.connection : undefined } });
}

export async function requireFeedConfig(): Promise<FeedPublisherConfig> {
  const store = await readStore();
  if (!store.config) throw new Error("尚未配置订阅源发布，请先在订阅源页填写 GitHub 仓库和 token。");
  return store.config;
}

/** 暂存待发布记录；同 id 覆盖，总量封顶后丢弃最旧。返回保留数与丢弃数。 */
export async function stageFeedPosts(posts: unknown[]): Promise<{ kept: number; dropped: number }> {
  const store = await readStore();
  const byId = new Map<string, FeedPost>();
  for (const post of store.staged || []) byId.set(post.id, post);
  for (const input of posts) {
    const post = normalizeFeedPost(input);
    if (post) byId.set(post.id, post);
  }
  const ordered = [...byId.values()].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const kept = ordered.slice(0, MAX_STAGED_POSTS);
  await writeStore({ ...store, staged: kept });
  return { kept: kept.length, dropped: ordered.length - kept.length };
}

export async function getStagedPosts(): Promise<FeedPost[]> {
  return (await readStore()).staged || [];
}

/** 只移除指定 id 的暂存记录：发布按本次提交内容精确清理，并发暂存不受影响。 */
export async function removeStagedPosts(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const remove = new Set(ids);
  const store = await readStore();
  const staged = store.staged || [];
  const kept = staged.filter((post) => !remove.has(post.id));
  if (kept.length === staged.length) return 0;
  await writeStore({ ...store, staged: kept });
  return staged.length - kept.length;
}

export async function clearStagedPosts(): Promise<void> {
  const store = await readStore();
  await writeStore({ ...store, staged: [] });
}

export async function patchFeedState(patch: FeedPublishState): Promise<void> {
  const store = await readStore();
  await writeStore({ ...store, state: { ...store.state, ...patch } });
}

/** 只将测试结果关联到仍在使用的仓库/凭据，避免旧请求给新配置亮绿灯。 */
export function sameFeedConnectionConfig(a: FeedPublisherConfig, b: FeedPublisherConfig): boolean {
  return (["owner", "repo", "branch", "token"] as const).every((key) => a[key].trim() === b[key].trim());
}
export async function saveFeedConnection(config: FeedPublisherConfig, connection: FeedConnectionState): Promise<void> {
  const store = await readStore();
  if (!store.config || !sameFeedConnectionConfig(store.config, config)) return;
  await writeStore({ ...store, state: { ...store.state, connection } });
}
