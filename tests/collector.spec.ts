import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseBrowserToolYaml } from "../src/browser-tools/loader";
import { applyImport, normalizeFollow, parseFollowsText, parsePastedAccounts } from "../src/collector/follows";
import { clampIntervalHours, isCollectorDue } from "../src/collector/schedule";
import { pruneAndCheck } from "../src/collector/budget";
import { pickRotation } from "../src/collector/rotation";
import { resolveParameterDefaults } from "../src/browser-tools/template";
import { filterSinceRecords, sinceThreshold } from "../src/collector/watermarks";
import type { CollectorJob, FollowEntry } from "../src/collector/types";

function job(overrides: Partial<CollectorJob> = {}): CollectorJob {
  return { enabled: true, intervalHours: 4, status: "idle", ...overrides };
}

test("applyImport 按 平台+账号 合并、保留原元数据并封顶", () => {
  const existing: FollowEntry[] = [
    { platform: "twitter", handle: "karpathy", displayName: "Andrej" },
    { platform: "twitter", handle: "ylecun" }
  ];
  const result = applyImport(existing, [
    { platform: "twitter", handle: "karpathy", displayName: "会被忽略" },  // 已有 displayName 不覆盖
    { platform: "twitter", handle: "sama", priority: 3 },                  // 新增
    { platform: "xhs", handle: "示例博主" },                                // 其他平台互不影响
    { platform: "twitter", handle: "bad handle" }                           // 非法被丢弃
  ]);
  expect(result.added).toBe(2);
  expect(result.updated).toBe(0);
  expect(result.total).toBe(4);
  const karpathy = result.entries.find((entry) => entry.handle === "karpathy")!;
  expect(karpathy.displayName).toBe("Andrej");
  expect(result.entries.some((entry) => entry.handle === "bad handle")).toBe(false);
});

test("parseFollowsText 支持 txt 与带表头的 csv", () => {
  expect(parseFollowsText("twitter", "@karpathy\n# 注释\nrasbt\n")).toEqual([
    { platform: "twitter", handle: "karpathy" },
    { platform: "twitter", handle: "rasbt" }
  ]);
  const csv = parseFollowsText("twitter", "handle,priority,name\nkarpathy,3,Andrej\nylecun\n");
  expect(csv).toEqual([
    { platform: "twitter", handle: "karpathy", priority: 3, displayName: "Andrej" },
    { platform: "twitter", handle: "ylecun" }
  ]);
});

test("normalizeFollow 规范化 @ 前缀与空白", () => {
  expect(normalizeFollow({ platform: " Twitter ", handle: " @Jack " })).toEqual({ platform: "twitter", handle: "Jack" });
  expect(normalizeFollow({ platform: "twitter", handle: "a b" })).toBeNull();
});

test("parsePastedAccounts 粘贴批量解析：多行/链接/ID/去重/不可识别", () => {
  // 推特：@前缀、裸 handle、主页链接混排，去重
  const tw = parsePastedAccounts("twitter", "@karpathy\nrasbt, https://x.com/swyx @karpathy");
  expect(tw.handles).toEqual(["karpathy", "rasbt", "swyx"]);
  expect(tw.unresolvable).toHaveLength(0);
  // 推特：带状态路径的链接取第一段
  expect(parsePastedAccounts("twitter", "https://x.com/dotey/status/123456").handles).toEqual(["dotey"]);
  // 小红书：24 位 ID、含查询参数的主页链接、去重
  const id = "5d7ece920000000001018707";
  const xhs = parsePastedAccounts("xhs", `${id}\nhttps://www.xiaohongshu.com/user/profile/${id}?xsec_token=AB&xsec_source=pc_user，${id.toUpperCase()}`);
  expect(xhs.handles).toEqual([id]);
  expect(xhs.unresolvable).toHaveLength(0);
  // 小红书：昵称与短 ID 无法识别，单独返回
  const bad = parsePastedAccounts("xhs", "歸藏 12345");
  expect(bad.handles).toHaveLength(0);
  expect(bad.unresolvable).toEqual(["歸藏", "12345"]);
});

test("isCollectorDue 间隔、运行中、待处理与重试上限", () => {
  const now = Date.now();
  expect(isCollectorDue(job({ lastSuccessAt: now - 3 * 3_600_000 }), now)).toBe(false);   // 不足间隔
  expect(isCollectorDue(job({ lastSuccessAt: now - 5 * 3_600_000 }), now)).toBe(true);    // 超过间隔
  expect(isCollectorDue(job({ lastSuccessAt: now - 5 * 3_600_000, status: "running" }), now)).toBe(false);
  expect(isCollectorDue(job({ lastSuccessAt: now - 5 * 3_600_000, status: "needs_user" }), now)).toBe(false);
  expect(isCollectorDue(job({ enabled: false, lastSuccessAt: 0 }), now)).toBe(false);
  // 首次启用：立即到期
  expect(isCollectorDue(job({}), now)).toBe(true);
  // 重试限流：同日第 3 次后不再到期
  const day = new Date(now).toLocaleDateString("sv-SE");
  expect(isCollectorDue(job({ attemptDay: day, attempts: 3, lastAttemptAt: now }), now)).toBe(false);
  expect(clampIntervalHours(0)).toBe(1);
  expect(clampIntervalHours(100)).toBe(48);
  expect(clampIntervalHours(6)).toBe(6);
});

test("twitter/timeline.yml 声明采集入口并通过校验", () => {
  const definition = parseBrowserToolYaml(readFileSync("browser-tools/twitter/timeline.yml", "utf8"));
  expect(definition.feed).toMatchObject({ collection: "tweets", platform: "twitter", entry_url: "https://x.com/home" });
});

test("pruneAndCheck 滚动窗口裁剪与限额判定", () => {
  const now = Date.now();
  const day = 24 * 60 * 60_000;
  const timestamps = [now - day - 1000, now - day + 1000, now - 3600_000, now - 60_000];
  const check = pruneAndCheck(timestamps, now, 3);
  expect(check.used).toBe(3); // 最旧一条过期裁掉
  expect(check.kept).toHaveLength(3);
  expect(check.allowed).toBe(false); // 3 + 1 > 3
  expect(pruneAndCheck(check.kept, now, 4).allowed).toBe(true);
});

test("pickRotation 循环切片与回绕", () => {
  const items = ["a", "b", "c", "d", "e"];
  expect(pickRotation(items, 0, 2)).toEqual(["a", "b"]);
  expect(pickRotation(items, 4, 2)).toEqual(["e", "a"]); // 回绕
  expect(pickRotation(items, 7, 3)).toEqual(["c", "d", "e"]); // 游标取模
  expect(pickRotation(items, 0, 8)).toEqual(items); // 超总量取全部
  expect(pickRotation([], 3, 2)).toEqual([]);
});

test("filterSinceRecords 首次回填窗口、增量水位线与无日期记录", () => {
  const now = Date.parse("2026-09-29T12:00:00.000Z");
  const day = 24 * 60 * 60_000;
  const records = [
    { id: "1", created_at: new Date(now - 1 * 3_600_000).toISOString() },  // 1 小时前
    { id: "2", created_at: new Date(now - 3 * day).toISOString() },        // 3 天前
    { id: "3", created_at: new Date(now - 9 * day).toISOString() },        // 9 天前（超回填窗口）
    { id: "4" }                                                            // 无时间，宽松模式保留由去重兜底
  ];
  // 首次（无水位线）：7 天回填窗口
  const first = filterSinceRecords(records, "created_at", undefined, 7, now);
  expect(first.kept.map((r) => r.id)).toEqual(["1", "2", "4"]);
  expect(first.newestIso).toBe(records[0].created_at);
  // 增量：水位线 = 3 天前那条 → 1 小时安全缓冲内的（含等于水位线的）保留
  const second = filterSinceRecords(records, "created_at", records[1].created_at, 7, now);
  expect(second.kept.map((r) => r.id)).toEqual(["1", "2", "4"]);
  // 全部旧于水位线 − 缓冲
  const none = filterSinceRecords([records[2]], "created_at", records[1].created_at, 7, now);
  expect(none.kept).toHaveLength(0);
  expect(none.newestIso).toBeUndefined();
  // 严格模式（required，详情补全后仍无日期）：无日期与日期不可解析的记录都丢弃
  const strictRecords = [
    records[0],
    { id: "5", created_at: "不是日期" },
    { id: "6" }
  ];
  const strict = filterSinceRecords(strictRecords, "created_at", records[1].created_at, 7, now, false);
  expect(strict.kept.map((r) => r.id)).toEqual(["1"]);
});

test("sinceThreshold 翻页深度界线：水位线优先，首次用回填窗口", () => {
  const now = Date.parse("2026-10-02T08:00:00.000Z");
  const hour = 60 * 60_000;
  // 首次（无水位线）：lookback 7 天
  expect(sinceThreshold(undefined, 7, now)).toBe(now - 7 * 24 * hour);
  // 增量：水位线 − 1 小时安全缓冲（比 lookback 更靠近现在，翻页更早停）
  const watermark = new Date(now - 6 * hour).toISOString();
  expect(sinceThreshold(watermark, 7, now)).toBe(now - 7 * hour);
  // 翻到界线之前的旧内容即应停止（含等于界线的时刻）
  expect(Date.parse("2026-10-02T01:00:00.000Z") <= sinceThreshold(watermark, 7, now)).toBe(true);
  expect(Date.parse("2026-10-02T07:00:00.000Z") <= sinceThreshold(watermark, 7, now)).toBe(false);
  // lookback 下限 1 天，防 0/负值
  expect(sinceThreshold(undefined, 0, now)).toBe(now - 24 * hour);
});

test("xhs/twitter YAML 声明增量采集（根级 since 可解析）", () => {
  const xhs = parseBrowserToolYaml(readFileSync("browser-tools/xhs/notes.yml", "utf8"));
  expect(xhs.since).toMatchObject({ field: "created_at", lookback_days: 7, required: true });
  expect(xhs.detail_extract?.max_items).toBe(10);
  expect(xhs.detail_extract?.state_fields?.created_at).toMatchObject({ path: "note.noteDetailMap.{{ id }}.note.time" });
  const twitter = parseBrowserToolYaml(readFileSync("browser-tools/twitter/timeline.yml", "utf8"));
  expect(twitter.since).toMatchObject({ field: "created_at" });
});

test("since 声明位置：feed 下等价解析，根级+feed 双声明报错", () => {
  const base = readFileSync("browser-tools/twitter/timeline.yml", "utf8");
  const rootBlock = "since:\n  field: created_at\n  lookback_days: 7\n";
  if (!base.includes(rootBlock)) throw new Error("测试前提：twitter yml 应有根级 since 块");
  const nested = base.replace(rootBlock, "").replace("feed:\n", "feed:\n  since:\n    field: created_at\n    lookback_days: 7\n");
  expect(parseBrowserToolYaml(nested).since).toMatchObject({ field: "created_at", lookback_days: 7 });
  expect(() => parseBrowserToolYaml(base.replace("feed:\n", `feed:\n  since:\n    field: created_at\n`))).toThrow("不能同时声明");
});

test("resolveParameterDefaults 填充默认值不校验必填", () => {
  const definition = parseBrowserToolYaml(readFileSync("browser-tools/twitter/timeline.yml", "utf8"));
  const resolved = resolveParameterDefaults(definition, {});
  expect(resolved.delay_between_users_ms).toBe(3000);
  expect(resolved.tweets_per_user).toBe(30);
  expect(resolved.username).toBeUndefined(); // 必填参数由批量循环按关键词注入，不在此处
});
