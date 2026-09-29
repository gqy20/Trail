export type FeedPostMetrics = Record<string, number>;

export type FeedPost = {
  /** 复合主键：`平台:原站内容id`，例如 `twitter:1783612345678901234`。 */
  id: string;
  platform: string;
  handle: string;
  author?: string;
  title?: string;
  text: string;
  url: string;
  /** 原帖发布时间（ISO），不是抓取时间。 */
  created_at: string;
  fetched_at: string;
  is_repost?: boolean;
  metrics?: FeedPostMetrics;
  media?: string[];
};

export type FeedPostsFile = { schema: 1; updated_at: string; posts: FeedPost[] };

export type FeedMetaChannel = { lastPublishAt: string; postCount: number };

export type FeedMetaFile = { schema: 1; updated_at: string; channels: Record<string, FeedMetaChannel> };

export type FeedPublisherConfig = {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  /** posts.json 历史封顶条数。 */
  maxPosts: number;
  /** 单个 RSS 文件包含的最大条数。 */
  itemsPerFeed: number;
  /** 自定义 Pages 根地址；缺省使用 https://{owner}.github.io/{repo}/。 */
  pagesBaseUrl?: string;
  /** 采集轮次成功暂存后自动发布。 */
  autoPublish?: boolean;
  /** 订阅源不收录转推/转发。 */
  excludeRetweets?: boolean;
};

export type FeedPublishState = {
  lastPublishAt?: string;
  totalPosts?: number;
  lastNewPosts?: number;
  lastFiles?: string[];
  lastError?: string;
  /** 非错误的运行提示，例如暂存触顶丢弃。 */
  lastNotice?: string;
};

export type FeedPublisherSnapshot = {
  config: FeedPublisherConfig | null;
  stagedCount: number;
  state: FeedPublishState;
};

export type FeedPublishResult = {
  publishedAt: string;
  files: string[];
  totalPosts: number;
  newPosts: number;
};

export type FeedRepoProbe = { repoPrivate: boolean; defaultBranch: string };

export const FEED_POSTS_PATH = "data/posts.json";
export const FEED_META_PATH = "data/meta.json";
export const FEED_ALL_RSS_PATH = "rss/all.xml";

export const PLATFORM_LABELS: Record<string, string> = {
  twitter: "X / Twitter",
  xhs: "小红书"
};
