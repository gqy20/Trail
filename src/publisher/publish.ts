import { fetchGitHubContent, probeGitHubRepo, putGitHubContent } from "./github";
import { buildFeedMetaFile, buildFeedPostsFile, mergeFeedPosts, normalizeFeedPost } from "./merge";
import { planFeedFiles } from "./rss";
import { clearStagedPosts, getStagedPosts, requireFeedConfig } from "./storage";
import type { FeedPost, FeedPublishResult, FeedRepoProbe } from "./types";
import { FEED_META_PATH, FEED_POSTS_PATH } from "./types";

export async function probeFeedRepo(): Promise<FeedRepoProbe> {
  return probeGitHubRepo(await requireFeedConfig());
}

export async function publishFeed(): Promise<FeedPublishResult> {
  const config = await requireFeedConfig();
  const staged = await getStagedPosts();
  if (staged.length === 0) throw new Error("没有待发布的新记录，先运行采集或导入数据。");

  const currentFile = await fetchGitHubContent(config, FEED_POSTS_PATH);
  const existing = currentFile ? parseRemotePosts(currentFile.content) : [];

  const { posts, newCount } = mergeFeedPosts(existing, staged, config.maxPosts);
  const publishedAt = new Date().toISOString();
  const written: string[] = [];

  await putGitHubContent(
    config,
    FEED_POSTS_PATH,
    `${JSON.stringify(buildFeedPostsFile(posts, publishedAt), null, 2)}\n`,
    `trail: 发布 ${newCount} 条新记录，共 ${posts.length} 条`,
    currentFile?.sha
  );
  written.push(FEED_POSTS_PATH);

  const currentMeta = await fetchGitHubContent(config, FEED_META_PATH);
  await putGitHubContent(
    config,
    FEED_META_PATH,
    `${JSON.stringify(buildFeedMetaFile(posts, publishedAt), null, 2)}\n`,
    "trail: 更新发布元数据",
    currentMeta?.sha
  );
  written.push(FEED_META_PATH);

  for (const file of planFeedFiles(posts, config)) {
    const current = await fetchGitHubContent(config, file.path);
    await putGitHubContent(config, file.path, file.content, `trail: 更新 ${file.path}`, current?.sha);
    written.push(file.path);
  }

  await clearStagedPosts();
  return { publishedAt, files: written, totalPosts: posts.length, newPosts: newCount };
}

function parseRemotePosts(content: string): FeedPost[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("远端 data/posts.json 不是合法 JSON，请先检查仓库内容。");
  }
  const posts = (parsed as { posts?: unknown[] }).posts;
  if (!Array.isArray(posts)) return [];
  return posts
    .map((post) => normalizeFeedPost(post))
    .filter((post): post is FeedPost => post !== null);
}
