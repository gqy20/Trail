import { test, expect, chromium } from "@playwright/test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

test("侧栏入口与研究记录：默认页面、分组录制、切换标签实时刷新、生成文档", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const extension = resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    executablePath: process.env.TRAIL_TEST_CHROMIUM, channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 420, height: 860 }
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/entries/tools.html`);
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await expect(page.getByRole("heading", { name: "研究路径", exact: true })).toBeVisible();
    expect(await worker.evaluate(() => chrome.runtime.getManifest().action?.default_popup)).toBeUndefined();
    await expect.poll(() => worker.evaluate(async () => (await chrome.sidePanel.getPanelBehavior()).openPanelOnActionClick)).toBe(true);
    expect(await worker.evaluate(async () => (await chrome.sidePanel.getOptions({})).path)).toBe("entries/tools.html");

    const source = await context.newPage();
    await source.route("http://trail.test/**", (route) => route.fulfill({ body: '<meta charset="utf-8"><title>研究资料 A</title><p>资料</p>', contentType: "text/html; charset=utf-8" }));
    await source.goto("http://trail.test/a");
    await source.bringToFront();
    await expect(page.locator(".research-recorder .source-title").filter({ hasText: "研究资料 A" })).toBeVisible();
    const secondSource = await context.newPage();
    await secondSource.route("http://trail.test/**", (route) => route.fulfill({ body: '<meta charset="utf-8"><title>研究资料 B</title>', contentType: "text/html; charset=utf-8" }));
    await secondSource.goto("http://trail.test/second");
    const excludedSource = await context.newPage();
    await excludedSource.route("http://trail.test/**", (route) => route.fulfill({ body: '<meta charset="utf-8"><title>不选的资料</title>', contentType: "text/html; charset=utf-8" }));
    await excludedSource.goto("http://trail.test/excluded");
    await expect(page.getByLabel("选择网页 研究资料 B", { exact: true })).toBeVisible();
    await page.getByLabel("全选网页", { exact: true }).check();
    await expect(page.getByLabel("选择网页 不选的资料", { exact: true })).toBeChecked();
    await page.getByLabel("全选网页", { exact: true }).uncheck();
    await expect(page.getByRole("button", { name: "新建分组并记录", exact: true })).toBeDisabled();
    await page.getByLabel("选择网页 研究资料 A", { exact: true }).check();
    await page.getByLabel("选择网页 研究资料 B", { exact: true }).check();
    await expect(page.getByLabel("选择网页 不选的资料", { exact: true })).not.toBeChecked();
    expect(await page.locator(".research-recorder .source-list").evaluate((list) => list.scrollWidth <= list.clientWidth)).toBe(true);
    const rejected = await page.evaluate(() => chrome.runtime.sendMessage({ type: "START_NEW_GROUP_RECORDING", name: "空选择", tabIds: [] }));
    expect(rejected.error).toContain("选择");
    await page.getByLabel("记录名称", { exact: true }).fill("边栏研究测试");
    // DOM 点击保持资料标签处于活动状态，模拟侧栏内点击。
    await page.getByRole("button", { name: "新建分组并记录（2）", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.locator(".recording-title strong")).toHaveText("边栏研究测试");
    await expect(page.locator(".recording-badge")).toHaveText("记录中");
    const recorded = await worker.evaluate(async () => (await chrome.storage.local.get("trail.activeSession"))["trail.activeSession"]);
    expect(recorded.tabs.map((tab: { url: string }) => tab.url).sort()).toEqual(["http://trail.test/a", "http://trail.test/second"]);
    const grouped = await worker.evaluate(async (id: number) => (await chrome.tabs.query({ groupId: id })).map((tab) => tab.url), recorded.groupId);
    expect(grouped.sort()).toEqual(["http://trail.test/a", "http://trail.test/second"]);
    await source.goto("http://trail.test/b");
    await expect.poll(() => page.locator(".recording-title .muted").textContent()).toContain("3 个来源");
    const pageCount = context.pages().length;
    await page.getByRole("button", { name: "生成文档", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
    await expect(page.getByRole("heading", { name: "记录摘要", exact: true })).toBeVisible();
    expect(context.pages()).toHaveLength(pageCount);
    await expect(page.getByRole("heading", { name: "边栏研究测试", exact: true })).toBeVisible();
    const fullDocument = context.waitForEvent("page");
    await page.getByRole("button", { name: "展开文档", exact: true }).click();
    const documentPage = await fullDocument;
    await documentPage.waitForURL(/entries\/research\.html\?sessionId=/);
    await page.getByRole("button", { name: "返回记录", exact: true }).click();
    await expect(page.locator(".research-recorder .session-card").first()).toContainText("边栏研究测试");
    await expect(page.locator(".interaction-settings[open]")).toHaveCount(0);
    await worker.evaluate(async () => {
      const all = (await chrome.storage.local.get("trail.sessions"))["trail.sessions"];
      await chrome.storage.local.set({ "trail.sessions": [...all, ...[1, 2, 3].map((index) => ({ ...all[0], id: `history-${index}`, name: `历史测试 ${index}`, startedAt: Date.now() - index * 60_000, markdown: `# 历史测试 ${index}`, events: index === 1 ? [{ id: "clip-1", type: "text_copied", selectedText: "唯一关注片段", timestamp: Date.now() }] : [] }))] });
    });
    await expect(page.locator(".recent-records .record-row")).toHaveCount(3);
    await page.getByRole("button", { name: "全部记录 · 4", exact: true }).click();
    await expect(page.getByRole("heading", { name: "全部记录", exact: true })).toBeVisible();
    await expect(page.locator(".record-list-item")).toHaveCount(4);
    for (const width of [360, 420, 760]) {
      await page.setViewportSize({ width, height: 860 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 420, height: 860 });
    await page.screenshot({ path: testInfo.outputPath("record-history.png"), fullPage: true });
    await page.getByLabel("搜索研究记录").fill("唯一关注片段");
    await expect(page.locator(".record-list-item")).toHaveCount(1);
    await page.locator(".record-list .record-row").click();
    await expect(page.locator(".record-clips")).toContainText("唯一关注片段");
    await page.getByRole("button", { name: "重命名 历史测试 1", exact: true }).click();
    await page.getByLabel("记录新名称").fill("重新命名的记录");
    await page.getByRole("button", { name: "保存名称", exact: true }).click();
    await expect(page.getByRole("heading", { name: "重新命名的记录", exact: true })).toBeVisible();
    for (const width of [360, 420, 760]) {
      await page.setViewportSize({ width, height: 860 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 420, height: 860 });
    await page.screenshot({ path: testInfo.outputPath("record-summary.png"), fullPage: true });
    const exportDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出 Markdown", exact: true }).click();
    const downloaded = await exportDownload;
    expect(readFileSync((await downloaded.path())!, "utf8")).toBe("# 历史测试 1");
    await page.getByRole("button", { name: "返回记录", exact: true }).click();
    await expect(page.getByLabel("搜索研究记录")).toHaveValue("唯一关注片段");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "删除 重新命名的记录", exact: true }).click();
    await expect(page.locator(".record-list-item")).toHaveCount(0);
    await page.getByLabel("搜索研究记录").fill("");
    await expect(page.locator(".record-list-item")).toHaveCount(3);
    await page.locator(".record-history-heading").getByRole("button", { name: "研究路径", exact: true }).click();
    for (const width of [360, 420, 760]) {
      await page.setViewportSize({ width, height: 860 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 420, height: 860 });
    await page.screenshot({ path: testInfo.outputPath("research-sidebar.png"), fullPage: true });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
