import { test, expect, chromium } from "@playwright/test";
import { resolve } from "node:path";

/** 采集面板的内联进度：运行中显示当前账号与记录数，暂停后续传，停止后收尾消失。 */
test("采集面板：内联进度、暂停与停止", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const extension = resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium",
    executablePath: process.env.TRAIL_TEST_CHROMIUM,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 760, height: 860 }
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/entries/tools.html`);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "IMPORT_BUNDLED_BROWSER_TOOLS" }));
    await page.evaluate(async () => {
      await chrome.runtime.sendMessage({ type: "IMPORT_FOLLOWS", platform: "twitter", text: "handle,name\nkarpathy,Andrej Karpathy\nsama,Sam Altman\nylecun,Yann LeCun" });
      await chrome.storage.session.set({ "trail.browserToolBatchRun.v1.twitter-timeline": {
        runId: "browser_tool_batch_test",
        toolId: "twitter-timeline",
        toolName: "X 用户时间线采集",
        keywords: ["karpathy", "sama", "ylecun"],
        nextIndex: 1,
        completedKeywords: 1,
        parameters: {},
        status: "running",
        startedAt: Date.now() - 60_000,
        updatedAt: Date.now(),
        lastPageUrl: "https://x.com/sama",
        lastPageTitle: "X",
        data: { tweets: Array.from({ length: 12 }, (_, i) => ({ id: String(i) })) }
      } });
    });
    await page.reload();
    await page.getByRole("button", { name: "账号采集", exact: true }).click();

    const panel = page.locator(".collector-panel").first();
    const progress = panel.locator(".collector-progress");
    await expect(progress).toBeVisible();
    await expect(progress).toContainText("正在采集");
    await expect(progress).toContainText("第 2/3 个：Sam Altman · 已采 12 条");
    await expect(progress.locator(".collector-progress-track")).toHaveAttribute("aria-valuenow", "1");

    await panel.getByRole("button", { name: "暂停", exact: true }).click();
    await expect(panel).toContainText("已请求暂停");

    await page.evaluate(async () => {
      const key = "trail.browserToolBatchRun.v1.twitter-timeline";
      const state = (await chrome.storage.session.get(key))[key] as Record<string, unknown>;
      await chrome.storage.session.set({ [key]: { ...state, status: "paused", pendingControl: undefined } });
    });
    await expect(progress).toContainText("已暂停");
    await expect(progress).toContainText("点继续从中断处接着采");
    await expect(panel.getByRole("button", { name: "继续", exact: true })).toBeVisible();

    page.once("dialog", (dialog) => void dialog.accept());
    await panel.getByRole("button", { name: "停止", exact: true }).click();
    await expect(progress).toHaveCount(0);
  } finally {
    await context.close();
  }
});
