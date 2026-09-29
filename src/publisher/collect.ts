import type { BrowserToolDefinition, BrowserToolRunResult } from "../browser-tools/contracts";
import { normalizeFeedPost } from "./merge";
import { getFeedPublisherSnapshot, stageFeedPosts } from "./storage";
import type { FeedPost } from "./types";

const METRIC_KEYS = ["likes", "retweets", "replies", "views", "collects", "comments"] as const;

/**
 * 把采集工具输出的扁平记录收敛为 FeedPost 形态：
 * id 补平台前缀、互动数归入 metrics、缺失 URL 按平台规则兜底。
 * 批量运行时记录带 `_query`（输入的账号），优先作为订阅源分组账号。
 */
export function recordsToFeedPosts(
  records: Array<Record<string, unknown>>,
  platform: string,
  fallbackHandle?: string,
  options: { excludeRetweets?: boolean } = {}
): FeedPost[] {
  const posts: FeedPost[] = [];
  for (const record of records) {
    const nativeId = String(record.id ?? "").trim();
    if (!nativeId) continue;
    const handle = String(record._query ?? record.handle ?? fallbackHandle ?? "").trim().replace(/^@/, "");
    const text = typeof record.text === "string" ? record.text : "";
    const isRepost = record.is_repost === true || text.startsWith("RT @");
    if (options.excludeRetweets && isRepost) continue;
    const metrics: Record<string, number> = {};
    for (const key of METRIC_KEYS) {
      const value = record[key];
      if (typeof value === "number" && Number.isFinite(value)) metrics[key] = value;
    }
    const post = normalizeFeedPost({
      id: nativeId.includes(":") ? nativeId : `${platform}:${nativeId}`,
      platform,
      handle,
      author: record.author,
      title: record.title,
      text,
      url: record.url || (handle ? buildPostUrl(platform, handle, nativeId) : undefined),
      created_at: record.created_at,
      fetched_at: record.fetched_at || new Date().toISOString(),
      is_repost: isRepost || undefined,
      metrics: Object.keys(metrics).length > 0 ? metrics : undefined,
      media: record.media
    });
    if (post) posts.push(post);
  }
  return posts;
}

function buildPostUrl(platform: string, handle: string, nativeId: string): string | undefined {
  if (platform === "twitter") return `https://x.com/${handle}/status/${nativeId}`;
  if (platform === "xhs") return `https://www.xiaohongshu.com/explore/${nativeId}`;
  return undefined;
}

/**
 * 工具声明了 feed 段时，成功或部分完成的运行会把该集合的记录
 * 自动暂存到订阅源。失败/暂停的运行不暂存，保持人工可见。
 * 返回暂存数与触顶丢弃数。
 */
export async function stageFeedFromRun(
  definition: BrowserToolDefinition,
  result: BrowserToolRunResult
): Promise<{ staged: number; dropped: number }> {
  const feed = definition.feed;
  if (!feed) return { staged: 0, dropped: 0 };
  if (result.status === "failed" || result.status === "paused") return { staged: 0, dropped: 0 };
  const records = result.data[feed.collection];
  if (!records || records.length === 0) return { staged: 0, dropped: 0 };
  const { config } = await getFeedPublisherSnapshot();
  const posts = recordsToFeedPosts(records, feed.platform, undefined, { excludeRetweets: config?.excludeRetweets });
  if (posts.length === 0) return { staged: 0, dropped: 0 };
  const { kept, dropped } = await stageFeedPosts(posts);
  return { staged: kept, dropped };
}
