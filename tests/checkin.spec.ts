import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { parseBrowserToolYaml } from "../src/browser-tools/loader";
import { isCheckinDue, localClock } from "../src/checkin/schedule";
import type { BrowserToolDefinition, BrowserToolRunResult } from "../src/browser-tools/contracts";

const ablesci = parseBrowserToolYaml(readFileSync("browser-tools/ablesci/tool.yml", "utf8"));
const glados = parseBrowserToolYaml(readFileSync("browser-tools/glados/tool.yml", "utf8"));
const rocks = parseBrowserToolYaml(readFileSync("browser-tools/glados/rocks.yml", "utf8"));

async function fixture(page: Page, definition: BrowserToolDefinition, html: string) {
  await page.route("**/*", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: html }));
  await page.goto(definition.checkin!.entry_url);
  await page.evaluate(() => {
    (window as any).toolListeners = [];
    (window as any).chrome = { runtime: {
      onMessage: { addListener: (fn: unknown) => (window as any).toolListeners.push(fn) },
      sendMessage: async () => ({ recorded: false })
    } };
  });
  await page.addScriptTag({ content: readFileSync("dist/content.js", "utf8") });
}

function run(page: Page, definition: BrowserToolDefinition): Promise<BrowserToolRunResult> {
  return page.evaluate((definition) => new Promise((resolve) => {
    (window as any).toolListeners.forEach((listener: Function) => listener({ type: "EXECUTE_BROWSER_TOOL", definition, parameters: {} }, {}, resolve));
  }), definition) as Promise<BrowserToolRunResult>;
}

const account = '<div class="fly-signin"><cite id="user-point-now">82</cite><cite id="sign-count">1</cite>';

test("科研通：成功后隐藏按钮，再次运行不会重复点击", async ({ page }) => {
  await fixture(page, ablesci, `${account}<div class="sign-no"><button class="btn-sign" onclick="window.clicks=(window.clicks||0)+1;this.parentElement.style.display='none';document.querySelector('#message').textContent='签到成功，获得10积分'">签到</button></div></div><div id="message" class="layui-layer-content"></div>`);
  const first = await run(page, ablesci);
  expect(first.outcome).toBe("success");
  expect(first.data.account[0].points).toBe(82);
  expect((await run(page, ablesci)).outcome).toBe("already_done");
  expect(await page.evaluate(() => (window as any).clicks)).toBe(1);
});

test("科研通：新页面已签到时无需按钮或弹窗", async ({ page }) => {
  await fixture(page, ablesci, `${account}</div>`);
  expect((await run(page, ablesci)).outcome).toBe("already_done");
});

test("科研通：登录页暂停，不误报成功", async ({ page }) => {
  await fixture(page, ablesci, '<form><input type="password"><button>登录</button></form>');
  const result = await run(page, ablesci);
  expect(result.status).toBe("paused");
  expect(result.outcome).toBeUndefined();
});

test("科研通：错误弹窗不算成功", async ({ page }) => {
  const fast = structuredClone(ablesci);
  function shorten(steps: any[]) { for (const step of steps) { if (step.action === "wait_for") step.timeout_ms = 50; if (step.then) shorten(step.then); if (step.else) shorten(step.else); } }
  shorten(fast.workflow);
  await fixture(page, fast, `${account}<button class="btn-sign">签到</button></div><div class="layui-layer-content">发生错误</div>`);
  expect((await run(page, fast)).status).toBe("failed");
});

for (const [name, definition] of [["One", glados], ["Rocks", rocks]] as const) {
  // 新版前端（button.ckb）：点击后按钮进入 is-done 态，结果文案随站点语言变化，
  // 判定只看状态迁移——用内嵌脚本模拟点击后按钮翻转为已签。
  test(`GLaDOS ${name}: 点击后进入 is-done 判成功`, async ({ page }) => {
    const html = `<div id="root"><div class="checkin-stats-grid"><div><div>Points</div><div>99</div></div><div><div>Streak</div><div>1</div></div><div><div>Days Left</div><div>22</div></div><div><div>Plan</div><div>Pro</div></div></div><button class="ckb">Checkin</button></div><script>document.querySelector("button.ckb").addEventListener("click", function handle() { this.removeEventListener("click", handle); this.classList.add("is-done"); this.disabled = true; this.textContent = "Checkin! Got 11 Points"; });</script>`;
    await fixture(page, definition, html);
    const result = await run(page, definition);
    expect(result.outcome).toBe("success");
    expect(result.status).toBe("completed");
    const record = result.data?.account?.[0] as Record<string, unknown> | undefined;
    expect(record?.points).toBe(99);
    expect(record?.days).toBe(1);
    expect(record?.days_left).toBe(22);
    expect(record?.plan).toBe("Pro");
    expect(record?.result).toBe("Checkin! Got 11 Points");
  });

  test(`GLaDOS ${name}: 加载即已签态判 already_done（中文文案）`, async ({ page }) => {
    await fixture(page, definition, `<div id="root"><div class="checkin-stats-grid"><div><div>Points</div><div>107</div></div><div><div>Streak</div><div>2</div></div><div><div>Days Left</div><div>27</div></div><div><div>Plan</div><div>Pro</div></div></div><button class="ckb is-done" disabled>今日已签到</button></div>`);
    const result = await run(page, definition);
    expect(result.outcome).toBe("already_done");
    expect(result.status).toBe("completed");
  });

  test(`GLaDOS ${name}: 点击后未进入已签态转人工`, async ({ page }) => {
    // 按钮存在但点击无反应（如需要验证），等待超时后应转 pause 而非误报成功。
    const fast = structuredClone(definition);
    function shorten(steps: any[]) { for (const step of steps) { if (step.action === "wait_for") step.timeout_ms = 50; if (step.then) shorten(step.then); if (step.else) shorten(step.else); } }
    shorten(fast.workflow);
    await fixture(page, fast, `<div id="root"><div class="checkin-stats-grid"><div><div>Points</div><div>99</div></div></div><button class="ckb">Checkin</button></div>`);
    const result = await run(page, fast);
    expect(result.outcome).toBeUndefined();
    expect(result.status).toBe("paused");
  });
}

test("显式 finish 穿透 repeat，后续动作不会执行", async ({ page }) => {
  const definition = { ...ablesci, workflow: [
    { action: "repeat", max: 3, steps: [{ action: "finish", outcome: "already_done", message: "已完成" }] },
    { action: "click", selector: "#never" }
  ] } as BrowserToolDefinition;
  await fixture(page, definition, "<body>fixture</body>");
  expect((await run(page, definition)).outcome).toBe("already_done");
});

test("签到流程没有业务结果时失败；普通采集仍可完成", async ({ page }) => {
  const definition: BrowserToolDefinition = { ...ablesci, workflow: [{ action: "wait_for", selector: "body" }] };
  await fixture(page, definition, "<body>fixture</body>");
  expect((await run(page, definition)).status).toBe("failed");
  delete definition.checkin;
  expect((await run(page, definition)).status).toBe("completed");
});

test("调度按时区跨天补跑、去重、限制重试和等待人工处理", () => {
  const now = Date.parse("2026-09-14T01:05:00Z");
  const job = { enabled: true, time: "09:00", status: "idle" as const };
  expect(localClock(now, "Asia/Shanghai")).toEqual({ day: "2026-09-14", time: "09:05" });
  expect(isCheckinDue(job, "Asia/Shanghai", now)).toBe(true);
  expect(isCheckinDue({ ...job, time: "10:00" }, "Asia/Shanghai", now)).toBe(false);
  expect(isCheckinDue({ ...job, enabled: false }, "Asia/Shanghai", now)).toBe(false);
  expect(isCheckinDue({ ...job, status: "running" }, "Asia/Shanghai", now)).toBe(false);
  expect(isCheckinDue({ ...job, status: "needs_user" }, "Asia/Shanghai", now)).toBe(false);
  expect(isCheckinDue({ ...job, lastSuccessDay: "2026-09-14" }, "Asia/Shanghai", now)).toBe(false);
  expect(isCheckinDue({ ...job, lastSuccessDay: "2026-09-13" }, "Asia/Shanghai", now)).toBe(true);
  expect(isCheckinDue({ ...job, attemptDay: "2026-09-14", attempts: 3 }, "Asia/Shanghai", now)).toBe(false);
  expect(isCheckinDue({ ...job, lastAttemptAt: now - 60_000 }, "Asia/Shanghai", now)).toBe(false);
  expect(isCheckinDue({ ...job, lastAttemptAt: now - 31 * 60_000 }, "Asia/Shanghai", now)).toBe(true);
});

test("工具入口必须匹配域名和 HTTPS；非法结果拒绝导入", () => {
  const yaml = readFileSync("browser-tools/ablesci/tool.yml", "utf8");
  expect(() => parseBrowserToolYaml(yaml.replace("entry_url: https://www.ablesci.com/", "entry_url: https://evil.example/"))).toThrow();
  expect(() => parseBrowserToolYaml(yaml.replace("entry_url: https:", "entry_url: http:"))).toThrow();
  expect(() => parseBrowserToolYaml(yaml.replace("outcome: success", "outcome: arbitrary"))).toThrow();
  expect(glados.id).not.toBe(rocks.id);
  expect(glados.checkin!.entry_url).not.toBe(rocks.checkin!.entry_url);
});
