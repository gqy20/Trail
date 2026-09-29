import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseBrowserToolYaml } from "../src/browser-tools/loader";
import { applyImport, normalizeFollow, parseFollowsText } from "../src/collector/follows";
import { clampIntervalHours, isCollectorDue } from "../src/collector/schedule";
import { pruneAndCheck } from "../src/collector/budget";
import { pickRotation } from "../src/collector/rotation";
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
