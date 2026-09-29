import { test, expect } from "@playwright/test";
import { buildFeedPostsFile, buildFeedMetaFile, mergeFeedPosts, normalizeFeedPost } from "../src/publisher/merge";
import { buildFeedXml, feedPathFor, planFeedFiles, toCdata, toRfc822 } from "../src/publisher/rss";
import { fromBase64Utf8, toBase64Utf8 } from "../src/publisher/github";
import type { FeedPost, FeedPublisherConfig } from "../src/publisher/types";

function samplePost(overrides: Partial<FeedPost>): FeedPost {
  return {
    id: "twitter:100",
    platform: "twitter",
    handle: "example",
    text: "hello",
    url: "https://x.com/example/status/100",
    created_at: "2026-09-01T08:00:00.000Z",
    fetched_at: "2026-09-29T08:00:00.000Z",
    ...overrides
  };
}

test("normalizeFeedPost 校验必填字段并收敛可选字段", () => {
  expect(normalizeFeedPost(null)).toBeNull();
  expect(normalizeFeedPost({ id: "无冒号分隔" })).toBeNull();
  expect(normalizeFeedPost({ id: "twitter:1", platform: "Twitter", handle: "a", url: "javascript:alert(1)", created_at: "2026-09-01T00:00:00Z", fetched_at: "2026-09-01T00:00:00Z" })).toBeNull();
  expect(normalizeFeedPost({ id: "twitter:1", platform: "Twitter", handle: "a", text: "t", url: "https://x.com/a/status/1", created_at: "昨天", fetched_at: "2026-09-01T00:00:00Z" })).toBeNull();

  const post = normalizeFeedPost({
    id: " twitter:1 ",
    platform: "Twitter",
    handle: " a ",
    text: "正文",
    url: "https://x.com/a/status/1",
    created_at: "2026-09-01T00:00:00.000Z",
    fetched_at: "2026-09-02T00:00:00.000Z",
    author: "  A  ",
    metrics: { likes: 3, bad: "x" },
    media: ["https://img/1.png", "not-url", 42]
  });
  expect(post).not.toBeNull();
  expect(post!.platform).toBe("twitter");
  expect(post!.handle).toBe("a");
  expect(post!.author).toBe("A");
  expect(post!.metrics).toEqual({ likes: 3 });
  expect(post!.media).toEqual(["https://img/1.png"]);
});

test("mergeFeedPosts 同 id 覆盖、按时间倒序并封顶", () => {
  const old = samplePost({ id: "twitter:1", created_at: "2026-09-01T00:00:00.000Z", metrics: { likes: 1 } });
  const fresh = samplePost({ id: "twitter:2", created_at: "2026-09-20T00:00:00.000Z" });
  const updated = samplePost({ id: "twitter:1", created_at: "2026-09-01T00:00:00.000Z", metrics: { likes: 99 } });

  const first = mergeFeedPosts([old], [fresh], 100);
  expect(first.posts.map((post) => post.id)).toEqual(["twitter:2", "twitter:1"]);
  expect(first.newCount).toBe(1);

  const second = mergeFeedPosts(first.posts, [updated], 100);
  expect(second.newCount).toBe(0);
  expect(second.posts.find((post) => post.id === "twitter:1")?.metrics?.likes).toBe(99);

  const capped = mergeFeedPosts([], [old, fresh], 1);
  expect(capped.posts.map((post) => post.id)).toEqual(["twitter:2"]);
});

test("RSS 日期与 CDATA 转义", () => {
  expect(toRfc822("2026-09-29T08:00:00.000Z")).toBe("Tue, 29 Sep 2026 08:00:00 GMT");
  expect(toRfc822("not-a-date")).toBe("");
  expect(toCdata("a]]>b")).toBe("<![CDATA[a]]]]><![CDATA[>b]]>");
});

test("账号路径做 URL 编码，中文账号安全", () => {
  expect(feedPathFor("twitter", "jack")).toBe("rss/twitter/jack.xml");
  expect(feedPathFor("xhs", "示例博主")).toBe("rss/xhs/%E7%A4%BA%E4%BE%8B%E5%8D%9A%E4%B8%BB.xml");
});

test("buildFeedXml 输出合法条目并转义标题", () => {
  const post = samplePost({
    id: "twitter:100",
    handle: "example",
    author: "A & B <team>",
    text: "line1\nline2",
    created_at: "2026-09-29T08:00:00.000Z"
  });
  const xml = buildFeedXml({
    title: "Trail Feed",
    link: "https://gqy20.github.io/feed/",
    description: "测试",
    selfPath: "rss/all.xml",
    posts: [post],
    itemsPerFeed: 10
  });
  expect(xml).toContain('<guid isPermaLink="false">twitter:100</guid>');
  expect(xml).toContain("<pubDate>Tue, 29 Sep 2026 08:00:00 GMT</pubDate>");
  expect(xml).toContain("<title>A &amp; B &lt;team&gt;：line1</title>");
  expect(xml).toContain('href="https://gqy20.github.io/feed/rss/all.xml"');
  expect(xml).toContain("<![CDATA[<p>line1<br />line2</p>");
  // 仅保留有限条目
  const many = Array.from({ length: 30 }, (_, index) =>
    samplePost({ id: `twitter:${index}`, created_at: new Date(Date.parse("2026-09-29T08:00:00Z") - index * 1000).toISOString() })
  );
  const limited = buildFeedXml({ title: "t", link: "https://x/", description: "d", selfPath: "rss/all.xml", posts: many, itemsPerFeed: 5 });
  expect(limited.match(/<item>/g)?.length).toBe(5);
});

test("planFeedFiles 生成合并源与按账号分组源", () => {
  const config: FeedPublisherConfig = {
    owner: "gqy20", repo: "feed", branch: "main", token: "t",
    maxPosts: 5000, itemsPerFeed: 50
  };
  const files = planFeedFiles(
    [
      samplePost({ id: "twitter:1", handle: "jack" }),
      samplePost({ id: "xhs:2", platform: "xhs", handle: "示例博主", url: "https://www.xiaohongshu.com/explore/2" })
    ],
    config
  );
  const paths = files.map((file) => file.path);
  expect(paths).toContain("rss/all.xml");
  expect(paths).toContain("rss/twitter/jack.xml");
  expect(paths).toContain("rss/xhs/%E7%A4%BA%E4%BE%8B%E5%8D%9A%E4%B8%BB.xml");
});

test("posts 与 meta 文件结构", () => {
  const posts = [samplePost({ id: "twitter:1" }), samplePost({ id: "xhs:2", platform: "xhs" })];
  const postsFile = buildFeedPostsFile(posts, "2026-09-29T00:00:00.000Z");
  expect(postsFile.schema).toBe(1);
  expect(postsFile.posts).toHaveLength(2);
  const meta = buildFeedMetaFile(posts, "2026-09-29T00:00:00.000Z");
  expect(meta.channels.twitter?.postCount).toBe(1);
  expect(meta.channels.xhs?.postCount).toBe(1);
});

test("UTF-8 base64 往返（中文内容不损坏）", () => {
  const text = "中文内容🎉 with ]]> and newlines\n";
  expect(fromBase64Utf8(toBase64Utf8(text))).toBe(text);
});
