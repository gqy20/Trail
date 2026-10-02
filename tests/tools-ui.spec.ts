import { test, expect, chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("工作区：规则预览、参数归属和窄屏布局", async ({}, testInfo) => {
  test.setTimeout(60_000);
  const extension = resolve("dist");
  const context = await chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    channel: "chromium",
    executablePath: process.env.TRAIL_TEST_CHROMIUM,
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    viewport: { width: 420, height: 860 }
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(worker.url()).host}/entries/tools.html`);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "IMPORT_BUNDLED_BROWSER_TOOLS" }));
    await page.reload();
    await page.getByRole("button", { name: "网页工具", exact: true }).click();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(page.locator("#workspace-tool option")).toHaveCount(5);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.locator(".settings-view .yaml-settings input[type=number]")).toHaveCount(0);
    await page.locator(".yaml-settings summary").click();
    await page.locator(".yaml-editor").fill("schema_version: 999");
    await expect(page.locator(".yaml-settings .error-text")).toBeVisible();
    await expect(page.getByRole("button", { name: "添加工具", exact: true })).toBeDisabled();
    const yaml = readFileSync("browser-tools/cnki/tool.yml", "utf8").replace("parameters:", "parameters:\n  test_limit:\n    type: number\n    label: 额外提取上限\n    default: 5");
    await page.locator(".yaml-editor").fill(yaml);
    await expect(page.locator(".rule-preview")).toContainText("将替换");
    await expect(page.getByRole("button", { name: "替换为自定义规则" })).toBeEnabled();
    await page.getByRole("button", { name: "替换为自定义规则" }).click();
    await expect(page.locator(".catalog-notice")).toContainText("已导入");
    await page.getByRole("button", { name: "网页工具", exact: true }).click();
    await expect(page.locator(".run-parameters")).toBeVisible();
    await page.locator(".run-parameters summary").click();
    await expect(page.getByLabel("额外提取上限", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "只提取当前结果页", exact: true })).toBeVisible();
    await page.evaluate(async () => {
      await chrome.storage.local.set({ "trail.logs.v1": [{ ts: Date.now(), scope: "collector", level: "info", event: "collector.done", message: "采集结束", data: { count: 80 } }] });
      await chrome.runtime.sendMessage({ type: "IMPORT_FOLLOWS", platform: "twitter", text: "handle,name\nkarpathy,Andrej Karpathy\nsama,Sam Altman" });
      await chrome.storage.local.set({ "trail.collectors.v1": { "twitter-timeline": { enabled: false, intervalHours: 4, status: "ok", lastAttemptAt: Date.now(), message: "完成：80 条记录" } } });
    });
    for (const width of [360, 420, 760]) {
      await page.setViewportSize({ width, height: 860 });
      for (const name of ["研究路径", "签到", "日志", "账号采集", "网页工具", "文献队列", "设置"]) {
        if (name === "文献队列") await page.getByRole("button", { name: "日志", exact: true }).click();
        if (name === "文献队列") { await page.getByRole("button", { name: "文献队列", exact: true }).click(); continue; }
        await page.getByRole("button", { name, exact: true }).click();
        const overflow = await page.evaluate(() => [...document.querySelectorAll("*")].filter((element) => element.getBoundingClientRect().right > innerWidth + 1).map((element) => `${element.tagName}.${element.className}`).slice(-8));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} at ${width}px: ${overflow.join(", ")}`).toBe(true);
      }
    }
    await page.getByRole("button", { name: "账号采集", exact: true }).click();
    const collectorTitle = page.locator(".collector-title-row").first();
    await expect(collectorTitle).toContainText("完成：80 条记录");
    const titleBox = await collectorTitle.locator("strong").boundingBox();
    const resultBox = await collectorTitle.locator("span").boundingBox();
    expect(Math.abs(titleBox!.y - resultBox!.y)).toBeLessThan(8);
    await page.screenshot({ path: testInfo.outputPath("collectors-760.png"), fullPage: true });
    await page.setViewportSize({ width: 420, height: 860 });
    await page.getByRole("button", { name: "账号采集", exact: true }).click();
    await expect(page.locator(".feed-config-grid input[type=checkbox]").first()).toHaveCSS("width", "14px");
    const autoInterval = page.locator(".feed-config-inline .collector-interval");
    await expect(autoInterval).toBeVisible();
    await expect(autoInterval).toBeDisabled();
    // 发布选项内联在同一块中（窄屏可换行，无横向溢出已由上方 scrollWidth 检查覆盖）
    await page.locator(".feed-config-inline input[type=checkbox]").first().check();
    await expect(autoInterval).toBeEnabled();
    await expect(page.locator(".repository-heading").getByRole("button", { name: "保存", exact: true })).toBeVisible();
    await expect(page.locator(".repository-heading").getByRole("button", { name: "测试连接", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "保存", exact: true })).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await expect(page.locator(".token-field input")).toHaveAttribute("type", "password");
    await page.getByRole("button", { name: "显示", exact: true }).click();
    await expect(page.locator(".token-field input")).toHaveAttribute("type", "text");
    await page.screenshot({ path: testInfo.outputPath("publisher-420.png"), fullPage: true });
    await page.getByRole("button", { name: "账号采集", exact: true }).click();
    await expect(page.getByRole("button", { name: "导入账号", exact: true })).toHaveCount(2);
    await expect(page.locator(".account-manager[data-open=true]")).toHaveCount(0);
    await expect(page.locator(".account-manager .account-disclosure").first()).toContainText("2 个");
    const accounts = page.locator(".account-manager").first();
    await accounts.locator(".account-disclosure").click();
    const downloadPromise = page.waitForEvent("download");
    await accounts.getByRole("button", { name: "导出账号", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("twitter-accounts.csv");
    expect(readFileSync((await download.path())!, "utf8")).toContain('"karpathy","","Andrej Karpathy"');
    await accounts.getByRole("button", { name: "批量删除", exact: true }).click();
    await accounts.getByLabel("选择 karpathy", { exact: true }).check();
    page.once("dialog", (dialog) => void dialog.accept());
    await accounts.getByRole("button", { name: "删除已选（1）", exact: true }).click();
    await expect(accounts.locator(".account-disclosure")).toContainText("1 个");
    await expect(accounts.locator(".collector-chip")).toContainText("Sam Altman");
    const autoCollect = page.locator(".collector-schedule input[type=checkbox]").first();
    await autoCollect.click();
    await expect(autoCollect).toBeChecked();
    await expect(page.getByText("已开启。", { exact: true })).toHaveCount(0);
    await autoCollect.click();
    await expect(autoCollect).not.toBeChecked();
    await expect(page.getByText("已关闭。", { exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("collectors-420.png"), fullPage: true });
    await page.getByRole("button", { name: "日志", exact: true }).click();
    await expect(page.locator(".log-entry summary")).toContainText("采集结束");
    await expect(page.locator(".log-event")).toBeHidden();
    await page.locator(".log-entry summary").click();
    await expect(page.locator(".log-event")).toContainText("collector.done");
    await page.screenshot({ path: testInfo.outputPath("logs-420.png"), fullPage: true });
    const checkinYaml = readFileSync("browser-tools/glados/tool.yml", "utf8");
    await page.evaluate((yaml) => chrome.runtime.sendMessage({ type: "IMPORT_BROWSER_TOOL", yaml }), checkinYaml);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "RESTORE_BUNDLED_BROWSER_TOOL", toolId: "glados-checkin" }));
    const checkins = await page.evaluate(() => chrome.runtime.sendMessage({ type: "GET_CHECKIN_STATE" }));
    expect(checkins.items).toHaveLength(3);
    const manager = await page.evaluate(() => chrome.runtime.sendMessage({ type: "GET_BROWSER_TOOL_STATE" }));
    expect(manager.backups[0].source.backupOf).toBe("glados-checkin");
    expect(manager.tools.some((tool: { source?: { backupOf?: string } }) => tool.source?.backupOf)).toBe(false);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "CONFIGURE_COLLECTOR", toolId: "twitter-timeline", enabled: true, intervalHours: 4 }));
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "刷新页面状态" }).click();
    const collectorSwitch = page.getByRole("switch", { name: "启用X 用户时间线采集", exact: true });
    await collectorSwitch.click();
    await expect(collectorSwitch).toHaveAttribute("aria-checked", "false");
    const stoppedJob = await page.evaluate(async () => (await chrome.storage.local.get("trail.collectors.v1"))["trail.collectors.v1"]["twitter-timeline"]);
    expect(stoppedJob.enabled).toBe(false);
    await page.getByRole("button", { name: "网页工具", exact: true }).click();
    await expect(page.locator("#workspace-tool option[value=twitter-timeline]")).toHaveCount(0);
    await page.getByRole("button", { name: "账号采集", exact: true }).click();
    await expect(page.locator(".collector-panel")).toHaveCount(1);
    const rejectedRun = await page.evaluate(() => chrome.runtime.sendMessage({ type: "RUN_STORED_BROWSER_TOOL", toolId: "twitter-timeline", parameters: {}, userInitiated: true }));
    expect(rejectedRun.error).toContain("已停用");
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "IMPORT_BUNDLED_BROWSER_TOOLS" }));
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(collectorSwitch).toHaveAttribute("aria-checked", "false");
    await collectorSwitch.click();
    await expect(collectorSwitch).toHaveAttribute("aria-checked", "true");
    const enabledState = await page.evaluate(() => chrome.runtime.sendMessage({ type: "GET_COLLECTOR_STATE" }));
    expect(enabledState.items.find((item: { toolId: string }) => item.toolId === "twitter-timeline").job.enabled).toBe(false);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "CONFIGURE_CHECKIN", toolId: "glados-checkin", enabled: true, time: "23:59" }));
    const checkinSwitch = page.getByRole("switch", { name: "启用GLaDOS One 每日签到", exact: true });
    await checkinSwitch.click();
    await expect(checkinSwitch).toHaveAttribute("aria-checked", "false");
    expect((await page.evaluate(() => chrome.runtime.sendMessage({ type: "GET_CHECKIN_STATE" }))).items).toHaveLength(2);
    await checkinSwitch.click();
    const reenabledCheckin = await page.evaluate(() => chrome.runtime.sendMessage({ type: "GET_CHECKIN_STATE" }));
    expect(reenabledCheckin.items.find((item: { toolId: string }) => item.toolId === "glados-checkin").job.enabled).toBe(false);
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
