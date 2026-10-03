import { commitGitHubFiles, fetchGitHubContent, probeGitHubRepo } from "./github";
import { buildFeedMetaFile, buildFeedPostsFile, mergeFeedPosts, normalizeFeedPost } from "./merge";
import { planFeedFiles } from "./rss";
import { getStagedPosts, patchFeedState, removeStagedPosts, requireFeedConfig, saveFeedConnection } from "./storage";
import { getFollows } from "../collector/follows";
import type { FeedFollowsFile, FeedPost, FeedPublishResult, FeedRepoProbe } from "./types";
import { FEED_FOLLOWS_PATH, FEED_META_PATH, FEED_POSTS_PATH } from "./types";

export async function probeFeedRepo(): Promise<FeedRepoProbe> {
  const config = await requireFeedConfig();
  try {
    const probe = await probeGitHubRepo(config);
    await saveFeedConnection(config, { status: "connected", checkedAt: new Date().toISOString(), ...probe });
    return probe;
  } catch (error) {
    await saveFeedConnection(config, { status: "failed", checkedAt: new Date().toISOString() });
    throw error;
  }
}

export async function publishFeed(): Promise<FeedPublishResult> {
  const config = await requireFeedConfig();
  const staged = await getStagedPosts();
  if (staged.length === 0) throw new Error("没有待发布的新记录，先运行采集或导入数据。");
  // 记下本次提交覆盖的暂存 id：提交成功后只清理这些，发布期间新落下的暂存留给下一轮。
  const committedIds = new Set(staged.map((post) => post.id));

  const currentFile = await fetchGitHubContent(config, FEED_POSTS_PATH);
  const existing = currentFile ? parseRemotePosts(currentFile.content) : [];

  const { posts, newCount } = mergeFeedPosts(existing, staged, config.maxPosts);
  const publishedAt = new Date().toISOString();

  // 旧记录 author 补全：从 follows 的显示名映射，解决 531 条缺 author 的存量数据。
  const follows = await getFollows();
  const nameByHandle = new Map(follows.map((f) => [`${f.platform}:${f.handle}`, f.displayName || f.handle]));
  for (const post of posts) {
    if (!post.author || !post.author.trim()) {
      const name = nameByHandle.get(`${post.platform}:${post.handle}`);
      if (name) post.author = name;
    }
  }

  // 单提交包含本轮完整一致状态：数据、元数据、关注列表与全部 RSS。
  const followsFile = await buildFollowsFile(publishedAt);
  const files = [
    { path: FEED_POSTS_PATH, content: `${JSON.stringify(buildFeedPostsFile(posts, publishedAt), null, 2)}\n` },
    { path: FEED_META_PATH, content: `${JSON.stringify(buildFeedMetaFile(posts, publishedAt), null, 2)}\n` },
    { path: FEED_FOLLOWS_PATH, content: `${JSON.stringify(followsFile, null, 2)}\n` },
    ...planFeedFiles(posts, config)
  ];
  await commitGitHubFiles(config, files, `trail: 发布 ${newCount} 条新记录，共 ${posts.length} 条`);

  await removeStagedPosts([...committedIds]);
  await patchFeedState({
    lastPublishAt: publishedAt,
    totalPosts: posts.length,
    lastNewPosts: newCount,
    lastFiles: files.map((file) => file.path),
    lastError: undefined
  }).catch(() => undefined);
  return { publishedAt, files: files.map((file) => file.path), totalPosts: posts.length, newPosts: newCount };
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

/** 每次发布都写入当前关注列表（权威来源，含显示名和优先级）。 */
async function buildFollowsFile(publishedAt: string): Promise<FeedFollowsFile> {
  const follows = await getFollows();
  return {
    schema: 1,
    updated_at: publishedAt,
    accounts: follows.map((entry) => ({
      platform: entry.platform,
      handle: entry.handle,
      ...(entry.displayName ? { name: entry.displayName } : {}),
      ...(entry.avatar ? { avatar: entry.avatar } : {}),
      ...(entry.priority !== undefined ? { priority: entry.priority } : {})
    }))
  };
}
