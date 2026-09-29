import { normalizeFeedPost } from "./merge";
import type { FeedPost, FeedPublisherConfig, FeedPublisherSnapshot, FeedPublishState } from "./types";

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
    maxPosts: clamp(input.maxPosts, 100, 20000, 5000),
    itemsPerFeed: clamp(input.itemsPerFeed, 10, 500, 150),
    pagesBaseUrl,
    autoPublish: input.autoPublish === true,
    excludeRetweets: input.excludeRetweets === true
  };
}

export async function saveFeedConfig(input: FeedPublisherConfig): Promise<void> {
  const store = await readStore();
  await writeStore({ ...store, config: normalizeFeedConfig(input) });
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

export async function clearStagedPosts(): Promise<void> {
  const store = await readStore();
  await writeStore({ ...store, staged: [] });
}

export async function patchFeedState(patch: FeedPublishState): Promise<void> {
  const store = await readStore();
  await writeStore({ ...store, state: { ...store.state, ...patch } });
}
