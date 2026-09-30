import { test, expect, chromium } from "@playwright/test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { parseBrowserToolYaml } from "../src/browser-tools/loader";

test("隔离扩展：侧边栏、独立账户、并发去重、定时授权及规则变更", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const extension = resolve("dist");
  const opened: string[] = [];
  // Deliberately public, test-only localhost certificate. No production credential.
  const server = createServer({ key: readFileSync("tests/fixtures/localhost-test.key"), cert: readFileSync("tests/fixtures/localhost-test.crt") }, (req, res) => {
    if (req.url?.includes("favicon")) { res.writeHead(204).end(); return; }
    opened.push(req.url || "");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    if (req.url === "/ablesci") res.end('<div class="fly-signin"><cite id="user-point-now">82</cite><cite id="sign-count">1</cite></div>');
    else res.end('<div id="root"><div class="checkin-stats-grid"><div><div>Points</div><div>99</div></div><div><div>Streak</div><div>1</div></div><div><div>Days left</div><div>22</div></div></div><button class="checkin-cute-btn is-done" disabled><span class="checkin-btn-label">Today\'s observation logged. Return tomorrow for more points.</span></button></div>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const launch = () => chromium.launchPersistentContext(testInfo.outputPath("profile"), {
    executablePath: process.env.TRAIL_TEST_CHROMIUM,
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--ignore-certificate-errors"],
    viewport: { width: 420, height: 860 }
  });
  let context = await launch();
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const extensionId = new URL(worker.url()).host;
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/entries/tools.html`);
    const request = (message: object) => page.evaluate((m) => (window as any).chrome.runtime.sendMessage(m), message);
    await expect.poll(async () => (await request({ type: "GET_CHECKIN_STATE" }))?.items?.length).toBe(3);
    const builtinCnki = readFileSync("browser-tools/cnki/tool.yml", "utf8");
    const customCnki = builtinCnki.replace("version: 0.3.0", "version: 0.1.0") + "\n# local customization\n";
    const cnkiId = parseBrowserToolYaml(customCnki).id;
    await request({ type: "IMPORT_BROWSER_TOOL", yaml: customCnki });
    const sync = await request({ type: "IMPORT_BUNDLED_BROWSER_TOOLS" });
    expect(sync.unchanged).toBe(6);
    expect(sync.customPreserved).toBe(1);
    expect(sync.updated).toBe(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "刷新页面状态" }).click();
    await expect(page.getByText("网页运行 · 自定义 v0.1.0 · 内置 v0.3.0 可用", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("versions.png"), fullPage: true });
    await page.getByRole("button", { name: "切换为内置", exact: true }).click();
    await expect(page.getByText("已切换到内置版本，原自定义规则已另存为备份。", { exact: true })).toBeVisible();
    const manager = await request({ type: "GET_BROWSER_TOOL_STATE" });
    expect(manager.tools.find((t: any) => t.id === cnkiId).source.type).toBe("bundled");
    expect(manager.tools.find((t: any) => t.id === cnkiId).definition.version).toBe("0.3.0");
    expect(manager.backups.find((t: any) => t.id.startsWith(`${cnkiId}.backup-`)).yaml).toContain("# local customization");
    expect(manager.tools.some((t: any) => t.source?.backupOf)).toBe(false);
    for (const [file, path, domain] of [["glados/tool.yml", "one", "glados.one"], ["glados/rocks.yml", "rocks", "glados.rocks"], ["ablesci/tool.yml", "ablesci", "www.ablesci.com"]]) {
      const yaml = readFileSync(`browser-tools/${file}`, "utf8")
        .replace(`domains: [${domain}]`, "domains: [127.0.0.1]")
        .replace(/entry_url: .*/, `entry_url: ${origin}/${path}`);
      parseBrowserToolYaml(yaml);
      await request({ type: "IMPORT_BROWSER_TOOL", yaml });
    }
    await page.getByRole("button", { name: "签到", exact: true }).click();
    await expect(page.getByRole("heading", { name: "每日签到", exact: true, level: 1 })).toBeVisible();
    await expect(page.locator(".checkin-card")).toHaveCount(3);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    // Concurrent manual requests are serialized and the second request rechecks today's state.
    const [first, second] = await Promise.all([
      request({ type: "RUN_CHECKIN", toolId: "glados-checkin" }),
      request({ type: "RUN_CHECKIN", toolId: "glados-checkin" })
    ]);
    expect(first.items.find((i: any) => i.toolId === "glados-checkin").job.status, JSON.stringify({ first, opened })).toBe("already_done");
    expect(second.items.find((i: any) => i.toolId === "glados-rocks-checkin").job.status).toBe("idle");
    expect(opened.filter((h) => h === "/one")).toHaveLength(1);
    await request({ type: "RUN_CHECKIN", toolId: "glados-rocks-checkin" });
    expect(opened.filter((h) => h === "/rocks")).toHaveLength(1);

    // Explicit enablement authorizes only this exact tool revision.
    await request({ type: "CONFIGURE_CHECKIN", toolId: "ablesci-checkin", enabled: true, time: "00:00" });
    await page.evaluate(() => (window as any).chrome.alarms.create("trail.checkins.tick", { when: Date.now() + 100 }));
    await expect.poll(async () => (await request({ type: "GET_CHECKIN_STATE" })).items.find((i: any) => i.toolId === "ablesci-checkin").job.status, { timeout: 40_000 }).toBe("already_done");
    expect(opened.filter((h) => h === "/ablesci")).toHaveLength(1);

    await request({ type: "CONFIGURE_CHECKIN", toolId: "glados-checkin", enabled: true, time: "00:00" });
    await page.evaluate(async () => {
      const storage = (window as any).chrome.storage.local;
      const data = await storage.get(["trail.browserTools", "trail.checkins.v1"]);
      data["trail.browserTools"].find((t: any) => t.id === "glados-checkin").yaml += "\n# changed rule revision\n";
      const job = data["trail.checkins.v1"]["glados-checkin"];
      delete job.lastSuccessDay;
      delete job.lastAttemptAt;
      job.attempts = 0;
      await storage.set(data);
      await (window as any).chrome.alarms.create("trail.checkins.tick", { when: Date.now() + 100 });
    });
    await expect.poll(async () => (await request({ type: "GET_CHECKIN_STATE" })).items.find((i: any) => i.toolId === "glados-checkin").job.enabled, { timeout: 40_000 }).toBe(false);
    expect(opened.filter((h) => h === "/one")).toHaveLength(1);
    await expect(page.getByText("工具规则已更新，请检查后重新开启自动签到。")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("checkins.png"), fullPage: true });
    // Simulate an interrupted manual run, then restart the actual extension worker.
    await page.evaluate(async () => {
      const storage = (window as any).chrome.storage.local;
      const data = await storage.get("trail.checkins.v1");
      data["trail.checkins.v1"]["glados-checkin"].status = "running";
      data["trail.checkins.v1"]["glados-checkin"].enabled = false;
      data["trail.checkins.v1"]["glados-checkin"].lastAttemptAt = Date.now();
      await storage.set(data);
    });
    await context.close();
    context = await launch();
    const restarted = await context.newPage();
    await restarted.goto(`chrome-extension://${extensionId}/entries/tools.html`);
    const state = await restarted.evaluate(() => (window as any).chrome.runtime.sendMessage({ type: "GET_CHECKIN_STATE" }));
    const interrupted = state.items.find((i: any) => i.toolId === "glados-checkin").job;
    expect(interrupted.status).toBe("needs_user");
    expect(interrupted.message).toContain("后台重启");
  } finally { await context.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
