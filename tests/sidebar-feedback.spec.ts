import { test, expect, chromium } from "@playwright/test";
import { resolve } from "node:path";

test("侧边栏反馈：错误归属、保存提示收起及未保存状态", async ({}, testInfo) => {
  const extension = resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium", executablePath: process.env.TRAIL_TEST_CHROMIUM, headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`], viewport: { width: 420, height: 860 }
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/entries/tools.html`);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "IMPORT_BUNDLED_BROWSER_TOOLS" }));
    await page.getByRole("button", { name: "签到", exact: true }).click();
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      const runtime = chrome.runtime as unknown as { sendMessage: (message: { type: string }) => Promise<unknown> };
      let fail = true;
      runtime.sendMessage = (message) => {
        if (message.type === "CONFIGURE_CHECKIN" && fail) { fail = false; return Promise.reject(new Error("本地测试：配置保存失败")); }
        return original(message);
      };
    });
    const cards = page.locator(".checkin-card");
    await cards.first().getByRole("checkbox").click();
    await expect(cards.first().getByRole("alert")).toContainText("配置保存失败");
    await expect(cards.nth(1).getByRole("alert")).toHaveCount(0);
    await cards.first().getByRole("checkbox").click();
    await expect(cards.first().getByRole("alert")).toHaveCount(0);
    await expect(cards.first().getByText("已保存", { exact: true })).toBeVisible();
    await expect(cards.first().getByText("已保存", { exact: true })).toHaveCount(0, { timeout: 6000 });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator(".budget-settings summary").click();
    const row = page.locator(".budget-row").first();
    await page.getByLabel("X浏览量预算小时", { exact: true }).fill("3");
    await expect(row.getByText("未保存", { exact: true })).toBeVisible();
    await row.getByRole("button", { name: "保存预算", exact: true }).click();
    await expect(row.getByText("未保存", { exact: true })).toHaveCount(0);
    await expect(row.getByText("已保存", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      const runtime = chrome.runtime as unknown as { sendMessage: (message: { type: string }) => Promise<unknown> };
      runtime.sendMessage = (message) => message.type === "GET_BROWSER_TOOL_STATE"
        ? new Promise((_, reject) => setTimeout(() => { document.documentElement.dataset.testErrorDelivered = "true"; reject(new Error("本地测试：读取工具失败")); }, 500)) : original(message);
    });
    await page.getByRole("button", { name: "刷新页面状态" }).click();
    await page.getByRole("button", { name: "账号采集", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-test-error-delivered", "true");
    await expect(page.getByText("本地测试：读取工具失败", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "采集与发布", exact: true })).toBeVisible();
  } finally { await context.close(); }
});
