import { test, expect } from "@playwright/test";
import { formatLogEntriesText, redactLogData, trimLogEntries, type LogEntry } from "../src/logging/logger";

function entry(overrides: Partial<LogEntry> = {}): LogEntry {
  return { ts: 1_000, level: "info", scope: "batch", event: "keyword.done", message: "完成输入", ...overrides };
}

test("trimLogEntries 保留最新记录", () => {
  const entries = Array.from({ length: 10 }, (_, index) => entry({ ts: index }));
  const trimmed = trimLogEntries(entries, 4);
  expect(trimmed.map((item) => item.ts)).toEqual([6, 7, 8, 9]);
  expect(trimmedLogSafety(1)).toHaveLength(1);
  function trimmedLogSafety(max: number) {
    return trimLogEntries([entry()], max);
  }
});

test("redactLogData 脱敏敏感键并截断超长值", () => {
  const redacted = redactLogData({
    token: "github_pat_secret",
    ct0: "csrf-value",
    Authorization: "Bearer xxx",
    passwordHint: "x",
    keyword: "DrJimFan",
    longText: "a".repeat(600),
    nested: { ok: 1 }
  });
  expect(redacted.token).toBe("[已脱敏]");
  expect(redacted.ct0).toBe("[已脱敏]");
  expect(redacted.Authorization).toBe("[已脱敏]");
  expect(redacted.passwordHint).toBe("[已脱敏]");
  expect(redacted.keyword).toBe("DrJimFan");
  expect(String(redacted.longText).length).toBeLessThanOrEqual(401);
  expect(String(redacted.longText).endsWith("…")).toBe(true);
  expect(redacted.nested).toEqual({ ok: 1 });
});

test("formatLogEntriesText 每行一条且包含关键字段", () => {
  const text = formatLogEntriesText([
    entry({ ts: Date.parse("2026-09-29T10:30:00Z"), level: "warn", scope: "graphql", event: "fetch.rateLimited", message: "触发 429 限流", data: { operation: "UserTweets", status: 429 } })
  ]);
  expect(text).toContain("[warn]");
  expect(text).toContain("[graphql]");
  expect(text).toContain("fetch.rateLimited");
  expect(text).toContain("触发 429 限流");
  expect(text).toContain("\"operation\":\"UserTweets\"");
  expect(text.split("\n")).toHaveLength(1);
});
