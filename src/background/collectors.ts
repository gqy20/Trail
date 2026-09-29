import { getStoredBrowserTool, getStoredBrowserTools } from "../browser-tools/storage";
import { parseBrowserToolYaml } from "../browser-tools/loader";
import { matchesBrowserTool } from "../browser-tools/matcher";
import { executeAuthorizedCollectorBatch, importBundledBrowserTools } from "./browserTools";
import { clampIntervalHours, isCollectorDue } from "../collector/schedule";
import { getFollows } from "../collector/follows";
import type { CollectorJob, CollectorState } from "../collector/types";
import { logError, logInfo, logWarn } from "../logging/logger";

const KEY = "trail.collectors.v1";
const ALARM = "trail.collectors.tick";
/** 批量采集的最长执行时间；超时按待人工处理保留现场。 */
const RUN_TIMEOUT_MS = 20 * 60_000;
const STALE_RUNNING_MS = 30 * 60_000;

const defaultJob = (): CollectorJob => ({ enabled: false, intervalHours: 4, status: "idle" });
let writes: Promise<unknown> = Promise.resolve();
let runs: Promise<unknown> = Promise.resolve();
let initialization: Promise<void> = Promise.resolve();

async function readJobs(): Promise<Record<string, CollectorJob>> {
  return ((await chrome.storage.local.get(KEY))[KEY] as Record<string, CollectorJob> | undefined) || {};
}

function patchJob(id: string, patch: Partial<CollectorJob>): Promise<void> {
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
  if (!tool) throw new Error("未找到采集工具，请同步内置工具库。");
  const definition = parseBrowserToolYaml(tool.yaml);
  if (!definition.feed || !definition.batch) throw new Error("此工具不支持定时采集。");
  if (!definition.feed.entry_url) throw new Error("工具未声明 feed.entry_url，无法定时采集。");
  return { ...tool, definition };
}

async function hash(source: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getCollectorState(): Promise<CollectorState> {
  await initialization;
  const [tools, jobs] = await Promise.all([getStoredBrowserTools(), readJobs()]);
  const items = [];
  for (const tool of tools.filter((item) => item.definition.feed && item.definition.batch)) {
    const feed = tool.definition.feed!;
    const follows = await getFollows(feed.platform);
    items.push({
      toolId: tool.id,
      name: tool.definition.name,
      platform: feed.platform,
      entryUrl: feed.entry_url || `https://${tool.definition.match.domains[0]}/`,
      intervalSupported: Boolean(feed.entry_url),
      followsCount: follows.length,
      job: jobs[tool.id] || defaultJob()
    });
  }
  return { items };
}

export async function configureCollector(toolId: string, enabled: boolean, intervalHours: number): Promise<CollectorState> {
  await initialization;
  if (typeof enabled !== "boolean") throw new Error("采集开关参数无效。");
  const interval = clampIntervalHours(intervalHours);
  const tool = await toolFor(toolId);
  const follows = await getFollows(tool.definition.feed!.platform);
  if (enabled && follows.length === 0) throw new Error("关注列表为空，先导入账号再开启定时采集。");
  await patchJob(toolId, { enabled, intervalHours: interval, approvedHash: enabled ? await hash(tool.yaml) : undefined });
  await ensureAlarm();
  return getCollectorState();
}

export function runCollector(toolId: string, automatic = false): Promise<CollectorState> {
  const next = runs.then(() => runOne(toolId, automatic));
  runs = next.catch(() => undefined);
  return next;
}

async function runOne(toolId: string, automatic: boolean): Promise<CollectorState> {
  await initialization;
  const tool = await toolFor(toolId);
  const feed = tool.definition.feed!;
  const job = (await readJobs())[toolId] || defaultJob();
  const now = Date.now();
  if (job.status === "running") return getCollectorState();
  if (automatic) {
    if (!isCollectorDue(job, now)) return getCollectorState();
    if (job.approvedHash !== await hash(tool.yaml)) {
      await patchJob(toolId, { enabled: false, status: "needs_user", message: "工具规则已更新，请检查后重新开启定时采集。" });
      logWarn("collector", "collector.ruleChanged", "规则版本与开启时不一致，自动采集已暂停", { toolId });
      return getCollectorState();
    }
  }
  const follows = await getFollows(feed.platform);
  if (follows.length === 0) {
    await patchJob(toolId, { status: "failed", message: "关注列表为空。" });
    return getCollectorState();
  }

  const day = new Date(now).toLocaleDateString("sv-SE");
  await patchJob(toolId, {
    status: "running", message: `正在采集 ${follows.length} 个账号…`, lastAttemptAt: now,
    attemptDay: day, attempts: job.attemptDay === day ? (job.attempts || 0) + 1 : 1, result: undefined
  });
  logInfo("collector", "collector.start", automatic ? "定时采集开始" : "手动采集开始", { toolId, accounts: follows.length, automatic });

  let tabId: number | undefined;
  let dispatched = false;
  try {
    const tab = await chrome.tabs.create({ url: feed.entry_url, active: false });
    if (tab.id === undefined) throw new Error("无法打开采集页面。");
    tabId = tab.id;
    await patchJob(toolId, { tabId });
    await waitForPage(tabId);
    const loaded = await chrome.tabs.get(tabId);
    if (!loaded.url || !matchesBrowserTool(tool.definition, loaded.url)) {
      await patchJob(toolId, { status: "needs_user", message: "页面跳转到了登录或验证入口，请打开处理后重试。" });
      return getCollectorState();
    }
    dispatched = true;
    const result = await withTimeout(executeAuthorizedCollectorBatch(toolId, follows.map((entry) => entry.handle), tabId), RUN_TIMEOUT_MS);
    const records = Object.values(result.data).reduce((total, list) => total + list.length, 0);
    if (result.status === "paused") {
      await patchJob(toolId, { status: "needs_user", result, message: result.error || "需要登录或验证，请打开页面处理后重试。" });
      logWarn("collector", "collector.paused", "采集转待人工处理", { toolId });
      return getCollectorState();
    }
    const ok = result.status === "completed" || result.status === "partial";
    await patchJob(toolId, {
      status: ok ? "ok" : "failed",
      result,
      lastSuccessAt: ok ? Date.now() : job.lastSuccessAt,
      message: ok
        ? `完成 ${result.status === "partial" ? "（部分）" : ""}：${records} 条记录`
        : result.error || "采集失败。"
    });
    logInfo("collector", "collector.done", "采集结束", { toolId, status: result.status, records });
    await chrome.tabs.remove(tabId).catch(() => undefined);
    await patchJob(toolId, { tabId: undefined });
  } catch (error) {
    await patchJob(toolId, {
      status: dispatched ? "needs_user" : "failed",
      message: error instanceof Error ? error.message : "采集失败。"
    });
    logError("collector", "collector.fail", "采集执行失败", { toolId, detail: error instanceof Error ? error.message : "未知错误" });
    if (!dispatched && tabId !== undefined) {
      await chrome.tabs.remove(tabId).catch(() => undefined);
      await patchJob(toolId, { tabId: undefined });
    }
  }
  return getCollectorState();
}

export async function openCollectorPage(toolId: string): Promise<void> {
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
  await chrome.tabs.create({ url: tool.definition.feed!.entry_url, active: true });
}

async function ensureAlarm(): Promise<void> {
  const enabled = Object.values(await readJobs()).some((job) => job.enabled);
  if (!enabled) { await chrome.alarms.clear(ALARM); return; }
  if (!await chrome.alarms.get(ALARM)) await chrome.alarms.create(ALARM, { periodInMinutes: 5 });
}

async function tick(): Promise<void> {
  const state = await getCollectorState();
  for (const item of state.items) {
    if (item.job.status === "running" && Date.now() - (item.job.lastAttemptAt || 0) > STALE_RUNNING_MS) {
      await patchJob(item.toolId, { status: "needs_user", message: "上次采集中断，结果尚未确认，请检查后重试。" });
    } else if (isCollectorDue(item.job, Date.now())) {
      await runCollector(item.toolId, true);
    }
  }
}

export function registerCollectors(): void {
  const report = (error: unknown) => console.error("Trail 采集调度失败", error instanceof Error ? error.message : "未知错误");
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) void tick().catch(report); });
  chrome.runtime.onStartup.addListener(() => { void initialization.then(ensureAlarm).then(tick).catch(report); });
  initialization = (async () => {
    await importBundledBrowserTools();
    for (const [id, job] of Object.entries(await readJobs())) {
      if (job.status === "running") await patchJob(id, { status: "needs_user", message: "后台重启，上次采集结果不明，请检查后重试。" });
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
    timer = setTimeout(() => reject(new Error("采集执行超时，请检查页面后重试。")), ms);
  })]).finally(() => clearTimeout(timer));
}
