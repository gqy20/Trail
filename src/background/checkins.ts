import { getStoredBrowserTool, getStoredBrowserTools } from "../browser-tools/storage";
import { parseBrowserToolYaml } from "../browser-tools/loader";
import { matchesBrowserTool } from "../browser-tools/matcher";
import { executeAuthorizedCheckin, importBundledBrowserTools } from "./browserTools";
import { isCheckinDue, localClock } from "../checkin/schedule";
import type { CheckinJob, CheckinState } from "../checkin/types";

const KEY = "trail.checkins.v1";
const ALARM = "trail.checkins.tick";
const defaultJob = (): CheckinJob => ({ enabled: false, time: "09:00", status: "idle" });
let writes: Promise<unknown> = Promise.resolve();
let runs: Promise<unknown> = Promise.resolve();
let initialization: Promise<void> = Promise.resolve();

async function readJobs(): Promise<Record<string, CheckinJob>> {
  return ((await chrome.storage.local.get(KEY))[KEY] as Record<string, CheckinJob> | undefined) || {};
}

function patchJob(id: string, patch: Partial<CheckinJob>): Promise<void> {
  const next = writes.then(async () => {
    const jobs = await readJobs();
    jobs[id] = { ...defaultJob(), ...jobs[id], ...patch };
    await chrome.storage.local.set({ [KEY]: jobs });
  });
  writes = next.catch(() => undefined);
  return next;
}

async function toolFor(id: string) {
  const tool = await getStoredBrowserTool(id);
  if (!tool || tool.source?.backupOf || tool.enabled === false) throw new Error("签到工具已停用或未安装。");
  const definition = parseBrowserToolYaml(tool.yaml);
  if (!definition.checkin) throw new Error("此工具不支持签到。");
  return { ...tool, definition };
}

async function hash(source: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getCheckinState(): Promise<CheckinState> {
  await initialization;
  const [tools, jobs] = await Promise.all([getStoredBrowserTools(), readJobs()]);
  return { items: tools.filter((tool) => !tool.source?.backupOf && tool.enabled !== false && tool.definition.checkin).map((tool) => ({
    toolId: tool.id, name: tool.definition.name,
    entryUrl: tool.definition.checkin!.entry_url, timezone: tool.definition.checkin!.timezone,
    job: jobs[tool.id] || defaultJob()
  })) };
}

export async function configureCheckin(toolId: string, enabled: boolean, time: string): Promise<CheckinState> {
  await initialization;
  if (typeof enabled !== "boolean" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("签到时间格式应为 HH:mm。");
  const tool = await toolFor(toolId);
  await patchJob(toolId, { enabled, time, approvedHash: enabled ? await hash(tool.yaml) : undefined });
  await ensureAlarm();
  return getCheckinState();
}

export function runCheckin(toolId: string, automatic = false): Promise<CheckinState> {
  const next = runs.then(() => runOne(toolId, automatic));
  runs = next.catch(() => undefined);
  return next;
}

async function runOne(toolId: string, automatic: boolean): Promise<CheckinState> {
  await initialization;
  const tool = await toolFor(toolId);
  const config = tool.definition.checkin!;
  const job = (await readJobs())[toolId] || defaultJob();
  const now = Date.now();
  const day = localClock(now, config.timezone).day;
  if (job.status === "running") return getCheckinState();
  if (automatic) {
    if (!isCheckinDue(job, config.timezone, now)) return getCheckinState();
    if (job.approvedHash !== await hash(tool.yaml)) {
      await patchJob(toolId, { enabled: false, status: "needs_user", message: "工具规则已更新，请检查后重新开启自动签到。" });
      return getCheckinState();
    }
  }
  // Manual retry also respects a previously confirmed result for this day.
  if (job.lastSuccessDay === day) return getCheckinState();
  await patchJob(toolId, {
    status: "running", message: "正在检查签到状态…", lastAttemptAt: now,
    attemptDay: day, attempts: job.attemptDay === day ? (job.attempts || 0) + 1 : 1,
    result: undefined
  });
  let tabId: number | undefined;
  let dispatched = false;
  try {
    // Always own the working tab. Never navigate or close an unrelated user tab.
    const tab = await chrome.tabs.create({ url: config.entry_url, active: false });
    if (tab.id === undefined) throw new Error("无法打开签到页面。");
    tabId = tab.id;
    await patchJob(toolId, { tabId });
    await waitForPage(tabId);
    const loaded = await chrome.tabs.get(tabId);
    if (!loaded.url || !matchesBrowserTool(tool.definition, loaded.url)) {
      await patchJob(toolId, { status: "needs_user", message: "页面跳转到了登录或验证入口，请打开处理后重试。" });
      return getCheckinState();
    }
    dispatched = true;
    const result = await withTimeout(executeAuthorizedCheckin(tool, tabId), 70_000);
    if (result.status === "completed" && result.outcome) {
      await patchJob(toolId, {
        status: result.outcome, message: result.message, result,
        lastSuccessDay: localClock(Date.now(), config.timezone).day, tabId: undefined
      });
      await chrome.tabs.remove(tabId).catch(() => undefined);
    } else {
      await patchJob(toolId, {
        status: "needs_user", result,
        message: result.error || result.warnings.at(-1) || "未能确认签到结果，请打开页面检查后重试。"
      });
    }
  } catch (error) {
    await patchJob(toolId, {
      status: dispatched ? "needs_user" : "failed",
      message: error instanceof Error ? error.message : "签到失败。"
    });
    if (!dispatched && tabId !== undefined) {
      await chrome.tabs.remove(tabId).catch(() => undefined);
      await patchJob(toolId, { tabId: undefined });
    }
  }
  return getCheckinState();
}

export async function openCheckinPage(toolId: string): Promise<void> {
  const tool = await toolFor(toolId);
  const job = (await readJobs())[toolId];
  if (job?.tabId !== undefined) {
    const tab = await chrome.tabs.get(job.tabId).catch(() => undefined);
    if (tab?.url && matchesBrowserTool(tool.definition, tab.url)) {
      await chrome.tabs.update(job.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
  }
  await chrome.tabs.create({ url: tool.definition.checkin!.entry_url, active: true });
}

async function ensureAlarm(): Promise<void> {
  const enabled = Object.values(await readJobs()).some((job) => job.enabled);
  if (!enabled) { await chrome.alarms.clear(ALARM); return; }
  if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 5 });
}

async function tick(): Promise<void> {
  const state = await getCheckinState();
  for (const item of state.items) {
    if (item.job.status === "running" && Date.now() - (item.job.lastAttemptAt || 0) > 180_000) {
      await patchJob(item.toolId, { status: "needs_user", message: "上次执行中断，结果尚未确认，请打开页面检查后重试。" });
    } else if (isCheckinDue(item.job, item.timezone, Date.now())) {
      await runCheckin(item.toolId, true);
    }
  }
}

export function registerCheckins(): void {
  const report = (error: unknown) => console.error("Trail 签到调度失败", error instanceof Error ? error.message : "未知错误");
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void tick().catch(report); });
  chrome.runtime.onStartup.addListener(() => { void initialization.then(ensureAlarm).then(tick).catch(report); });
  // Reconstruct alarms after a service-worker restart or extension update.
  initialization = (async () => {
    // Sync before considering a saved authorization, including extension updates.
    await importBundledBrowserTools();
    for (const [id, job] of Object.entries(await readJobs())) {
      if (job.status === "running") await patchJob(id, { status: "needs_user", message: "后台重启，上次执行结果不明，请检查页面后重试。" });
    }
    await ensureAlarm();
  })();
  void initialization.then(tick).catch(report);
}

async function waitForPage(tabId: number): Promise<void> {
  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("页面加载超时，稍后会有限重试。");
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("执行超时，结果不明，请检查页面后重试。")), ms);
  })]).finally(() => clearTimeout(timer));
}
