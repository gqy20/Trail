import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseBrowserToolYaml } from "../src/browser-tools/loader";
import { extractGraphqlCursor, extractGraphqlRecords, readJsonPath } from "../src/browser-tools/graphql";
import { resolveTemplate } from "../src/browser-tools/template";
import { applyBrowserToolTransforms } from "../src/browser-tools/transforms";
import { recordsToFeedPosts } from "../src/publisher/collect";

function sampleTimelinePayload(): unknown {
  return {
    data: {
      user: {
        result: {
          rest_id: "123",
          timeline_v2: {
            timeline: {
              instructions: [
                { type: "TimelinePinEntry", entry: { content: { entryType: "TimelineTimelineItem", tweet_results: { result: { rest_id: "999", legacy: { full_text: "置顶推文" } } } } } },
                {
                  type: "TimelineAddEntries",
                  entries: [
                    {
                      entryId: "tweet-1",
                      content: {
                        entryType: "TimelineTimelineItem",
                        tweet_results: {
                          result: {
                            __typename: "Tweet",
                            rest_id: "1783612345678901234",
                            legacy: {
                              full_text: "第一条推文",
                              created_at: "Tue Sep 29 08:00:00 +0000 2026",
                              favorite_count: 12,
                              retweet_count: 3,
                              reply_count: 2,
                              extended_entities: { media: [{ media_url_https: "https://pbs.twimg.com/a.jpg" }, { media_url_https: "https://pbs.twimg.com/b.jpg" }] }
                            },
                            views: { count: "1024" },
                            core: { user_results: { result: { legacy: { screen_name: "jack", name: "Jack" } } } }
                          }
                        },
                        itemContent: { itemType: "TimelineTweet" }
                      }
                    },
                    { entryId: "cursor-bottom", content: { entryType: "TimelineTimelineCursor", cursorType: "Bottom", value: "DAABCgABG" } },
                    {
                      entryId: "module-1",
                      content: {
                        entryType: "TimelineTimelineModule",
                        items: [
                          { item: { itemContent: { tweet_results: { result: { rest_id: "555", __typename: "TweetWithVisibilityResults", tweet: { rest_id: "555", legacy: { full_text: "嵌套在模块里的推文", created_at: "Mon Sep 28 10:00:00 +0000 2026" } } } } } } }
                        ]
                      }
                    }
                  ]
                }
              ]
            }
          }
        }
      }
    }
  };
}

test("readJsonPath 支持嵌套、数组下标与缺失路径", () => {
  const payload = sampleTimelinePayload();
  expect(readJsonPath(payload, "data.user.result.rest_id")).toBe("123");
  expect(readJsonPath(payload, "data.user.result.timeline_v2.timeline.instructions.1.entries.0.content.entryType")).toBe("TimelineTimelineItem");
  expect(readJsonPath(payload, "data.missing.path")).toBeUndefined();
  expect(readJsonPath(payload, "")).toBeUndefined();
});

test("extractGraphqlRecords 递归命中嵌套推文并支持备选路径与数组子路径", () => {
  const records = extractGraphqlRecords(sampleTimelinePayload(), {
    collection: "tweets",
    walk: { has: "tweet_results.result" },
    dedupe_by: "id",
    fields: {
      id: { path: "tweet_results.result.rest_id" },
      text: {
        path: "tweet_results.result.note_tweet.note_tweet_results.result.text",
        fallback_paths: ["tweet_results.result.tweet.legacy.full_text", "tweet_results.result.legacy.full_text"]
      },
      likes: { path: "tweet_results.result.legacy.favorite_count", optional: true },
      views: { path: "tweet_results.result.views.count", transforms: ["parse_number"], optional: true },
      media: { path: "tweet_results.result.legacy.extended_entities.media", item_path: "media_url_https", optional: true }
    }
  });
  const ids = records.map((record) => record.id);
  expect(ids).toContain("1783612345678901234");
  expect(ids).toContain("555");
  expect(ids).toContain("999");
  const main = records.find((record) => record.id === "1783612345678901234")!;
  expect(main.text).toBe("第一条推文");
  expect(main.likes).toBe(12);
  expect(main.views).toBe(1024);
  expect(main.media).toEqual(["https://pbs.twimg.com/a.jpg", "https://pbs.twimg.com/b.jpg"]);
  const nested = records.find((record) => record.id === "555")!;
  expect(nested.text).toBe("嵌套在模块里的推文");
});

test("extractGraphqlCursor 读取 Bottom 游标", () => {
  const cursor = extractGraphqlCursor(sampleTimelinePayload(), { match_key: "cursorType", match_value: "Bottom", value_path: "value" });
  expect(cursor).toBe("DAABCgABG");
  expect(extractGraphqlCursor({ a: 1 }, { match_key: "cursorType", match_value: "Bottom", value_path: "value" })).toBeNull();
});

test("parse_date 转换 Twitter 时间为 ISO", () => {
  expect(applyBrowserToolTransforms("Tue Sep 29 08:00:00 +0000 2026", ["parse_date"])).toBe("2026-09-29T08:00:00.000Z");
  expect(applyBrowserToolTransforms("not a date", ["parse_date"])).toBe("not a date");
});

test("resolveTemplate 支持 values 存储域", () => {
  const definition = parseBrowserToolYaml(readFileSync("browser-tools/glados/tool.yml", "utf8"));
  expect(resolveTemplate("{{ values.user_id }}", definition, {}, { user_id: "12345" })).toBe("12345");
  expect(() => resolveTemplate("{{ values.missing }}", definition, {}, {})).toThrow("模板变量不存在");
});

test("recordsToFeedPosts 补平台前缀、优先 _query、归组互动数并兜底 URL", () => {
  const posts = recordsToFeedPosts(
    [
      {
        _query: "watched_account",
        handle: "someone_else",
        id: "1783612345678901234",
        text: "正文内容",
        created_at: "2026-09-29T08:00:00.000Z",
        likes: 12,
        retweets: 3,
        views: "1024"
      },
      { id: "555", handle: "jack", text: "RT @news 转发内容", created_at: "2026-09-28T10:00:00.000Z" },
      { handle: "no_id", text: "没有 id 的记录应被丢弃", created_at: "2026-09-28T10:00:00.000Z" }
    ],
    "twitter"
  );
  expect(posts).toHaveLength(2);
  const [first, second] = posts;
  expect(first.id).toBe("twitter:1783612345678901234");
  expect(first.handle).toBe("watched_account");
  expect(first.url).toBe("https://x.com/watched_account/status/1783612345678901234");
  expect(first.metrics).toEqual({ likes: 12, retweets: 3 });
  expect(first.is_repost).toBeUndefined();
  expect(second.is_repost).toBe(true);
  expect(second.url).toBe("https://x.com/jack/status/555");
});

test("recordsToFeedPosts 支持排除转推", () => {
  const records = [
    { id: "1", handle: "a", text: "原创内容", created_at: "2026-09-29T08:00:00.000Z" },
    { id: "2", handle: "a", text: "RT @b 转发内容", created_at: "2026-09-29T07:00:00.000Z" },
    { id: "3", handle: "a", text: "标记转推", is_repost: true, created_at: "2026-09-29T06:00:00.000Z" }
  ];
  expect(recordsToFeedPosts(records, "twitter")).toHaveLength(3);
  const filtered = recordsToFeedPosts(records, "twitter", undefined, { excludeRetweets: true });
  expect(filtered).toHaveLength(1);
  expect(filtered[0].id).toBe("twitter:1");
});

test("twitter/timeline.yml 通过加载器校验并保留 graphql 与 feed 声明", () => {
  const definition = parseBrowserToolYaml(readFileSync("browser-tools/twitter/timeline.yml", "utf8"));
  expect(definition.id).toBe("twitter-timeline");
  expect(definition.feed).toEqual({ collection: "tweets", platform: "twitter" });
  expect(definition.batch?.navigation).toMatchObject({ type: "fixed_url", url: "https://x.com/{{ parameters.username }}", input_parameter: "username" });
  expect(definition.batch?.delay_between_keywords_ms).toBe("{{ parameters.delay_between_users_ms }}");
  expect(definition.parameters?.tweets_per_user?.presentation).toMatchObject({ placement: "primary", style: "sentence" });
  expect(definition.parameters?.delay_between_users_ms?.default).toBe(3000);
  const steps = definition.workflow.filter((step) => step.action === "graphql_fetch");
  expect(steps).toHaveLength(2);
  const [userLookup, tweets] = steps as Array<Extract<typeof steps[number], { action: "graphql_fetch" }>>;
  expect(userLookup.operation).toBe("UserByScreenName");
  expect(userLookup.store).toEqual({ user_id: "data.user.result.rest_id" });
  expect(tweets.operation).toBe("UserTweets");
  expect(tweets.extract?.dedupe_by).toBe("id");
  expect(tweets.cursor).toEqual({ match_key: "cursorType", match_value: "Bottom", value_path: "value" });
  expect(Object.keys(tweets.features || {}).length).toBeGreaterThan(30);
});

test("loader 拒绝非法 graphql 声明", () => {
  const base = {
    schema_version: 1,
    id: "bad-graphql",
    name: "测试",
    version: "1",
    match: { domains: ["x.com"] },
    workflow: []
  };
  expect(() => parseBrowserToolYaml(toYaml({ ...base, workflow: [{ action: "graphql_fetch", operation: "not valid!" }] }))).toThrow();
  expect(() => parseBrowserToolYaml(toYaml({ ...base, workflow: [{ action: "graphql_fetch", operation: "UserTweets", extract: { collection: "tweets", fields: { id: { path: "a b" } } } }] }))).toThrow();
  expect(() => parseBrowserToolYaml(toYaml({ ...base, feed: { collection: "tweets", platform: "Twitter!" } }))).toThrow();
});

function toYaml(value: Record<string, unknown>): string {
  // 足够本测试使用的最小 YAML 序列化（扁平 + 一层嵌套数组/对象）。
  const lines: string[] = [];
  const render = (prefix: string, entryKey: string, entryValue: unknown, indent: number) => {
    const pad = " ".repeat(indent);
    if (Array.isArray(entryValue)) {
      lines.push(`${pad}${entryKey}:`);
      for (const item of entryValue) {
        if (item && typeof item === "object") {
          const sub = Object.entries(item as Record<string, unknown>);
          sub.forEach(([key, value], index) => render(`${index === 0 ? "- " : ""}`, index === 0 ? key : key, value, indent + 2));
        } else {
          lines.push(`${pad}- ${JSON.stringify(item)}`);
        }
      }
      return;
    }
    if (entryValue && typeof entryValue === "object") {
      lines.push(`${pad}${entryKey}:`);
      for (const [key, value] of Object.entries(entryValue as Record<string, unknown>)) render(prefix, key, value, indent + 2);
      return;
    }
    lines.push(`${pad}${entryKey}: ${JSON.stringify(entryValue)}`);
  };
  for (const [key, value] of Object.entries(value)) render("", key, value, 0);
  return lines.join("\n");
}

test("xhs/notes.yml 通过校验并保留风控节奏声明", () => {
  const definition = parseBrowserToolYaml(readFileSync("browser-tools/xhs/notes.yml", "utf8"));
  expect(definition.id).toBe("xhs-notes");
  expect(definition.feed).toMatchObject({ collection: "notes", platform: "xhs", entry_url: "https://www.xiaohongshu.com" });
  expect(definition.batch?.delay_between_keywords_ms).toBe("{{ parameters.delay_between_users_ms }}" as unknown || 15000 || undefined);
  expect(definition.detail_extract).toBeDefined();
  expect(definition.detail_extract?.delay_ms).toBe(5000);
  expect(definition.detail_extract?.max_items).toBe(8);
  expect(definition.detail_extract?.url_field).toBe("url");
  expect(definition.detail_extract?.blockers?.some((b) => b.url_contains === "error_code=3000")).toBe(true);
  // match 转换保留为对象形态
  const extract = definition.workflow.find((step) => step.action === "repeat") as { steps: Array<{ fields: Record<string, { transforms: unknown[] }> }> };
  const idTransforms = extract.steps[0].fields.id.transforms;
  expect(Array.isArray(idTransforms) && typeof idTransforms[0] === "object" && "match" in (idTransforms[0] as object)).toBe(true);
  // pause_if_present 支持 url_contains
  const pause = definition.workflow[0] as { url_contains?: string };
  expect(pause.url_contains).toBe("/login");
});
