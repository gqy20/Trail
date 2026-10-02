import { test, expect, chromium } from "@playwright/test";
import { resolve } from "node:path";

test("仓库反馈：测试结果持久化，配置变更与失败取消绿点", async ({}, testInfo) => {
  const extension = resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium", executablePath: process.env.TRAIL_TEST_CHROMIUM, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 420, height: 860 }
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    // Local response only: never contact GitHub or use real credentials.
    await worker.evaluate(() => { globalThis.fetch = async () => new Response(JSON.stringify({ private: false, default_branch: "main" }), { status: 200 }); });
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/entries/tools.html`);
    await page.getByRole("button", { name: "账号采集", exact: true }).click();
    await page.getByLabel("所有者", { exact: true }).fill("trail-test");
    await page.getByLabel("Token", { exact: false }).fill("local-test-token");
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    const status = page.locator(".repository-connection");
    await expect(status).toHaveText("已连接");
    await expect(status).toHaveClass(/connected/);
    await expect(status).toHaveAttribute("title", /公共仓库 · 默认分支 main/);
    await expect(page.locator(".feed-view")).not.toContainText("配置已保存。连接成功");
    await page.reload();
    await page.getByRole("button", { name: "账号采集", exact: true }).click();
    await expect(status).toHaveText("已连接");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.locator(".repository-save-notice")).toHaveText("已保存");
    await expect(status).toHaveText("已连接");
    for (const width of [360, 420, 760]) {
      await page.setViewportSize({ width, height: 860 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
    await page.getByLabel("仓库", { exact: true }).fill("another-feed");
    await expect(status).toHaveText("待重新测试");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(status).toHaveText("未测试");
    await worker.evaluate(() => { globalThis.fetch = async () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }); });
    await page.getByRole("button", { name: "测试连接", exact: true }).click();
    await expect(status).toHaveText("连接失败");
    await expect(status).not.toHaveClass(/connected/);
    await expect(page.locator(".feed-view [role=alert]")).toBeVisible();
  } finally { await context.close(); }
});
