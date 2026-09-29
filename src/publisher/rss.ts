import type { FeedPost, FeedPublisherConfig } from "./types";
import { FEED_ALL_RSS_PATH, PLATFORM_LABELS } from "./types";

const TITLE_LIMIT = 90;

export function escapeXmlText(value: string): string {
  return value.replace(/[<>&'"]/g, (ch) => {
    switch (ch) {
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "&": return "&amp;";
      case "'": return "&apos;";
      default: return "&quot;";
    }
  });
}

/** CDATA 内容中的 `]]>` 需要拆分转义，否则会提前闭合。 */
export function toCdata(text: string): string {
  return `<![CDATA[${text.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
}

/** RSS pubDate 要求 RFC 822；toUTCString 输出即合法形态。 */
export function toRfc822(iso: string): string {
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toUTCString() : "";
}

export function handleSlug(handle: string): string {
  return encodeURIComponent(handle.trim());
}

export function feedPathFor(platform: string, handle: string): string {
  return `rss/${encodeURIComponent(platform.trim().toLowerCase())}/${handleSlug(handle)}.xml`;
}

export function pagesUrl(config: Pick<FeedPublisherConfig, "owner" | "repo" | "pagesBaseUrl">): string {
  if (config.pagesBaseUrl) {
    return config.pagesBaseUrl.endsWith("/") ? config.pagesBaseUrl : `${config.pagesBaseUrl}/`;
  }
  return `https://${config.owner}.github.io/${config.repo}/`;
}

export type FeedGroup = { platform: string; handle: string; path: string; title: string; posts: FeedPost[] };

export function groupFeedPosts(posts: FeedPost[]): FeedGroup[] {
  const groups = new Map<string, FeedPost[]>();
  for (const post of posts) {
    const key = `${post.platform}\n${post.handle}`;
    let bucket = groups.get(key);
    if (!bucket) {
      bucket = [];
      groups.set(key, bucket);
    }
    bucket.push(post);
  }
  return [...groups.entries()]
    .map(([key, bucket]) => {
      const [platform, handle] = key.split("\n");
      const label = PLATFORM_LABELS[platform] || platform;
      return {
        platform,
        handle,
        path: feedPathFor(platform, handle),
        title: `${handle} · ${label}`,
        posts: bucket
      };
    })
    .sort((a, b) => postKeyTime(b) - postKeyTime(a));
}

function postKeyTime(group: FeedGroup): number {
  const time = Date.parse(group.posts[0]?.created_at || "");
  return Number.isFinite(time) ? time : 0;
}

function composeItemTitle(post: FeedPost): string {
  const source = post.author || `@${post.handle}`;
  const firstLine = (post.title || post.text || "").split("\n").find((line) => line.trim()) || "(无正文)";
  const combined = `${source}：${firstLine.trim()}`;
  return combined.length > TITLE_LIMIT ? `${combined.slice(0, TITLE_LIMIT)}…` : combined;
}

function renderItemDescription(post: FeedPost): string {
  const parts: string[] = [];
  if (post.title) parts.push(`<strong>${escapeXmlText(post.title)}</strong>`);
  const text = escapeXmlText(post.text).replace(/\r?\n/g, "<br />");
  if (text) parts.push(`<p>${text}</p>`);
  for (const url of post.media || []) {
    parts.push(`<img src="${escapeXmlText(url)}" loading="lazy" />`);
  }
  parts.push(`<p><a href="${escapeXmlText(post.url)}">原文</a>${post.is_repost ? " · 转发" : ""}</p>`);
  return parts.join("");
}

export function buildFeedXml(options: {
  title: string;
  link: string;
  description: string;
  selfPath: string;
  posts: FeedPost[];
  itemsPerFeed: number;
}): string {
  const selfUrl = `${options.link}${options.selfPath}`;
  const items = options.posts.slice(0, Math.max(1, Math.floor(options.itemsPerFeed)));
  const latest = items[0]?.created_at || new Date().toISOString();
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    `    <title>${escapeXmlText(options.title)}</title>`,
    `    <link>${escapeXmlText(options.link)}</link>`,
    `    <description>${escapeXmlText(options.description)}</description>`,
    `    <atom:link href="${escapeXmlText(selfUrl)}" rel="self" type="application/rss+xml" />`,
    `    <lastBuildDate>${toRfc822(latest)}</lastBuildDate>`,
    "    <generator>Trail Feed Publisher</generator>"
  ];
  for (const post of items) {
    const pubDate = toRfc822(post.created_at);
    lines.push(
      "    <item>",
      `      <title>${escapeXmlText(composeItemTitle(post))}</title>`,
      `      <link>${escapeXmlText(post.url)}</link>`,
      `      <guid isPermaLink="false">${escapeXmlText(post.id)}</guid>`,
      ...(pubDate ? [`      <pubDate>${pubDate}</pubDate>`] : []),
      `      <category>${escapeXmlText(post.platform)}</category>`,
      `      <description>${toCdata(renderItemDescription(post))}</description>`,
      "    </item>"
    );
  }
  lines.push("  </channel>", "</rss>", "");
  return lines.join("\n");
}

export type FeedFilePlan = { path: string; content: string };

/** 计算本轮需要写出的全部 RSS 文件：合并源 + 每个平台/账号一个源。 */
export function planFeedFiles(posts: FeedPost[], config: FeedPublisherConfig): FeedFilePlan[] {
  const base = pagesUrl(config);
  const files: FeedFilePlan[] = [
    {
      path: FEED_ALL_RSS_PATH,
      content: buildFeedXml({
        title: "Trail Feed",
        link: base,
        description: "Trail 采集聚合订阅源",
        selfPath: FEED_ALL_RSS_PATH,
        posts,
        itemsPerFeed: config.itemsPerFeed
      })
    }
  ];
  for (const group of groupFeedPosts(posts)) {
    files.push({
      path: group.path,
      content: buildFeedXml({
        title: group.title,
        link: base,
        description: `${group.title} 采集订阅源`,
        selfPath: group.path,
        posts: group.posts,
        itemsPerFeed: config.itemsPerFeed
      })
    });
  }
  return files;
}
