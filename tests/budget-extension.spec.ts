import { test, expect, chromium } from "@playwright/test";
import { resolve } from "node:path";

test("扩展预算：平台配置、额度暂停、普通检索不扣费、详情预算不触发登录冷却", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const extension = resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    executablePath: process.env.TRAIL_TEST_CHROMIUM, channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 420, height: 860 }
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/entries/tools.html`);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "IMPORT_BUNDLED_BROWSER_TOOLS" }));
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator(".budget-settings summary").click();
    await expect(page.getByLabel("X浏览量预算小时", { exact: true })).toHaveValue("6");
    await page.getByLabel("X浏览量预算小时", { exact: true }).fill("2");
    await page.getByLabel("X主页次数上限", { exact: true }).fill("3");
    await page.locator(".budget-row").first().getByRole("button", { name: "保存预算", exact: true }).click();
    await expect(page.locator(".budget-row").first()).toContainText("120 分钟");
    await expect(page.getByLabel("小红书浏览量预算小时", { exact: true })).toHaveValue("6");
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator(".budget-settings summary").click();
    await expect(page.getByLabel("X浏览量预算小时", { exact: true })).toHaveValue("2");
    await expect(page.getByLabel("X主页次数上限", { exact: true })).toHaveValue("3");
    await expect(page.getByLabel("小红书主页次数上限", { exact: true })).toHaveValue("0");
    await page.getByLabel("X主页次数上限", { exact: true }).fill("0");
    await page.locator(".budget-row").first().getByRole("button", { name: "保存预算", exact: true }).click();
    for (const width of [360, 420, 760]) {
      await page.setViewportSize({ width, height: 860 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    const source = await context.newPage();
    await source.route("https://x.com/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: '<meta charset="utf-8"><article><h1>预算测试结果</h1><a href="https://x.com/detail">详情</a></article>' }));
    await source.goto("https://x.com/home");
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: "https://x.com/home" }))[0].id!);
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ "trail.activityBudget.v2": { twitter: Array.from({ length: 60 }, () => ({ kind: "profile", at: Date.now() - 60_000 })) } });
    });
    const denied = await page.evaluate((tabId) => chrome.runtime.sendMessage({ type: "RUN_BROWSER_TOOL_BATCH", toolId: "twitter-timeline", tabId, keywords: ["someone"], parameters: {}, userInitiated: true }), tabId);
    expect(denied.status).toBe("paused");
    expect(denied.error).toContain("今日访问额度已满");
    expect(denied.error).toContain("主页 60");
    expect(denied.error).toContain("点继续");
    const singleDenied = await page.evaluate((tabId) => chrome.runtime.sendMessage({ type: "RUN_STORED_BROWSER_TOOL", toolId: "twitter-timeline", tabId, parameters: { username: "someone" }, userInitiated: true }), tabId);
    expect(singleDenied.status).toBe("paused");
    expect(singleDenied.error).toContain("今日访问额度已满");
    const plainYaml = `schema_version: 1
id: budget-search
name: 预算测试检索
version: '1.0.0'
match:
  domains: [x.com]
batch:
  navigation: { type: query_parameter, parameter: q }
  max_keywords: 5
workflow:
  - action: extract
    collection: literature
    selector: article
    fields:
      title: { selector: h1, attribute: text }
      url: { selector: a, attribute: href }
`;
    await page.evaluate((yaml) => chrome.runtime.sendMessage({ type: "IMPORT_BROWSER_TOOL", yaml }), plainYaml);
    const plain = await page.evaluate((tabId) => chrome.runtime.sendMessage({ type: "RUN_BROWSER_TOOL_BATCH", toolId: "budget-search", tabId, keywords: ["test"], parameters: {}, userInitiated: true }), tabId);
    expect(plain.status).toBe("completed");
    expect(plain.data.literature[0].title).toBe("预算测试结果");
    expect((await page.evaluate(() => chrome.runtime.sendMessage({ type: "GET_ACTIVITY_BUDGET" }))).find((state: { platform: string }) => state.platform === "twitter").used).toBe(120);
    const feedYaml = plainYaml.replace("budget-search", "budget-detail") + `feed: { collection: literature, platform: twitter, entry_url: 'https://x.com/home' }
detail_extract:
  collection: literature
  url_field: url
  max_items: 1
  fields:
    title: { selector: h1, attribute: text }
`;
    await page.evaluate((yaml) => chrome.runtime.sendMessage({ type: "IMPORT_BROWSER_TOOL", yaml }), feedYaml);
    await worker.evaluate(async () => chrome.storage.local.set({ "trail.activityBudget.v2": { twitter: Array.from({ length: 59 }, () => ({ kind: "profile", at: Date.now() - 60_000 })) } }));
    const detail = await page.evaluate((tabId) => chrome.runtime.sendMessage({ type: "RUN_BROWSER_TOOL_BATCH", toolId: "budget-detail", tabId, keywords: ["test"], parameters: {}, userInitiated: true }), tabId);
    expect(detail.status).toBe("paused");
    expect(detail.error).toContain("今日访问额度已满");
    expect(detail.warnings.join(" ")).not.toContain("15 分钟");
    const progress = await page.evaluate(() => chrome.runtime.sendMessage({ type: "GET_BATCH_RUN_STATE" }));
    expect(progress.nextIndex).toBe(0);
    const logs = await page.evaluate(() => chrome.runtime.sendMessage({ type: "GET_TRAIL_LOGS" }));
    expect(logs).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: "budget.config.changed", data: expect.objectContaining({ platform: "twitter" }) }),
      expect.objectContaining({ event: "activity.result", data: expect.objectContaining({ platform: "twitter", durationMs: expect.any(Number) }) }),
      expect.objectContaining({ event: "budget.denied", data: expect.objectContaining({ platform: "twitter", kind: "detail" }) })
    ]));
    await page.getByRole("button", { name: "日志", exact: true }).click();
    await page.getByLabel("日志平台", { exact: true }).selectOption("twitter");
    await expect(page.locator(".logs-list")).toContainText("访问预算不足");
    const downloadPromise = page.waitForEvent("download");
    await page.locator(".logs-toolbar").getByRole("button", { name: "导出", exact: true }).click();
    expect((await downloadPromise).suggestedFilename()).toMatch(/\.json$/);

  } finally { await context.close(); }
});
