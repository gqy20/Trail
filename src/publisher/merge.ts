import type { FeedMetaChannel, FeedMetaFile, FeedPost, FeedPostsFile } from "./types";

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T/;
const URL_PREFIX = /^https?:\/\//;
const MAX_MEDIA = 12;

/** 校验并收敛一条外部输入；不合格返回 null，由调用方决定丢弃还是报错。 */
export function normalizeFeedPost(input: unknown): FeedPost | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;
  const id = typeof raw.id === "string" ? raw.id.trim() : "";
  const platform = typeof raw.platform === "string" ? raw.platform.trim().toLowerCase() : "";
  const handle = typeof raw.handle === "string" ? raw.handle.trim() : "";
  const text = typeof raw.text === "string" ? raw.text : "";
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const createdAt = typeof raw.created_at === "string" ? raw.created_at : "";
  const fetchedAt = typeof raw.fetched_at === "string" ? raw.fetched_at : "";
  if (!id || !id.includes(":") || /\s/.test(id)) return null;
  if (!platform || !handle || !URL_PREFIX.test(url)) return null;
  if (!ISO_PREFIX.test(createdAt) || !ISO_PREFIX.test(fetchedAt)) return null;

  const post: FeedPost = { id, platform, handle, text, url, created_at: createdAt, fetched_at: fetchedAt };
  if (typeof raw.author === "string" && raw.author.trim()) post.author = raw.author.trim();
  if (typeof raw.title === "string" && raw.title.trim()) post.title = raw.title.trim();
  if (raw.is_repost === true) post.is_repost = true;

  if (raw.metrics && typeof raw.metrics === "object") {
    const metrics: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw.metrics as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) metrics[key] = value;
    }
    if (Object.keys(metrics).length > 0) post.metrics = metrics;
  }

  if (Array.isArray(raw.media)) {
    const media = raw.media.filter((item): item is string => typeof item === "string" && URL_PREFIX.test(item));
    if (media.length > 0) post.media = media.slice(0, MAX_MEDIA);
  }
  return post;
}

function postTime(post: FeedPost): number {
  const created = Date.parse(post.created_at);
  if (Number.isFinite(created)) return created;
  const fetched = Date.parse(post.fetched_at);
  return Number.isFinite(fetched) ? fetched : 0;
}

/**
 * 合并远端历史与新抓取记录：同 id 以新数据覆盖（更新互动数等），
 * 按 created_at 倒序，并按 maxPosts 封顶裁剪最旧记录。
 */
export function mergeFeedPosts(
  existing: unknown[],
  incoming: unknown[],
  maxPosts: number
): { posts: FeedPost[]; newCount: number } {
  const byId = new Map<string, FeedPost>();
  for (const input of existing) {
    const post = normalizeFeedPost(input);
    if (post) byId.set(post.id, post);
  }
  let newCount = 0;
  for (const input of incoming) {
    const post = normalizeFeedPost(input);
    if (!post) continue;
    if (!byId.has(post.id)) newCount += 1;
    byId.set(post.id, post);
  }
  const cap = Math.max(1, Math.floor(maxPosts));
  const posts = [...byId.values()].sort((a, b) => postTime(b) - postTime(a)).slice(0, cap);
  return { posts, newCount };
}

export function buildFeedPostsFile(posts: FeedPost[], updatedAt = new Date().toISOString()): FeedPostsFile {
  return { schema: 1, updated_at: updatedAt, posts };
}

export function buildFeedMetaFile(posts: FeedPost[], publishedAt = new Date().toISOString()): FeedMetaFile {
  const channels: Record<string, FeedMetaChannel> = {};
  for (const post of posts) {
    const channel = (channels[post.platform] ||= { lastPublishAt: publishedAt, postCount: 0 });
    channel.postCount += 1;
  }
  return { schema: 1, updated_at: publishedAt, channels };
}
