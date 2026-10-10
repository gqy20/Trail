import { test, expect, chromium } from "@playwright/test";
import { resolve } from "node:path";
import { normalizeFeedConfig } from "../src/publisher/storage";

const config = { owner: "trail-schedule-test", repo: "feed", branch: "main", token: "isolated-test-only", maxPosts: 20000, itemsPerFeed: 2000, autoPublish: true };

test("兜底间隔：默认、范围边界及无效值", () => {
  expect(normalizeFeedConfig(config).autoPublishHours).toBe(12);
  for (const hours of [1, 3, 168]) expect(normalizeFeedConfig({ ...config, autoPublishHours: hours }).autoPublishHours).toBe(hours);
  for (const hours of [0, -1, 169, NaN, Infinity]) expect(normalizeFeedConfig({ ...config, autoPublishHours: hours }).autoPublishHours).toBe(12);
  expect(normalizeFeedConfig({ ...config, autoPublishHours: 3.8 }).autoPublishHours).toBe(3);
});

test("隔离扩展：兜底间隔持久化、修改生效、不重复重排、关闭与恢复", async ({}, testInfo) => {
  const extension = resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium", executablePath: process.env.TRAIL_TEST_CHROMIUM, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/entries/tools.html`);
    const save = (autoPublishHours: number, autoPublish = true) => page.evaluate((value) => chrome.runtime.sendMessage({ type: "SAVE_FEED_CONFIG", config: value }), { ...config, autoPublishHours, autoPublish });
    const alarm = () => worker.evaluate(() => chrome.alarms.get("trail.feed.publishInterval"));
    // An existing legacy 12-hour alarm must be replaced when saving a new interval.
    await worker.evaluate(() => chrome.alarms.create("trail.feed.publishInterval", { periodInMinutes: 720 }));
    expect((await save(3)).config.autoPublishHours).toBe(3);
    expect((await alarm())?.periodInMinutes).toBe(180);
    const before = (await alarm())!.scheduledTime;
    await save(3);
    expect((await alarm())!.scheduledTime).toBe(before);
    await save(1);
    expect((await alarm())?.periodInMinutes).toBe(60);
    await page.reload();
    await page.getByRole("button", { name: "账号采集", exact: true }).click();
    await expect(page.getByLabel("兜底发布间隔", { exact: true })).toHaveValue("1");
    await page.getByLabel("兜底发布间隔", { exact: true }).fill("4");
    await page.locator(".repository-heading").getByRole("button", { name: "保存", exact: true }).click();
    await expect.poll(async () => (await alarm())?.periodInMinutes).toBe(240);
    await save(4, false);
    expect(await alarm()).toBeUndefined();
    expect((await page.evaluate(() => chrome.runtime.sendMessage({ type: "GET_FEED_STATE" }))).config.autoPublishHours).toBe(4);
    await save(4);
    expect((await alarm())?.periodInMinutes).toBe(240);
  } finally { await context.close(); }
});
