import type {
  BrowserToolManagerState,
  BrowserToolExecutionProgress,
  BrowserToolNativeExportDefinition,
  BrowserToolRunResult,
  GetBrowserToolNativeExportCountMessage,
  RunBrowserToolNativeExportBatchMessage,
  ExecuteBrowserToolMessage,
  StoredBrowserTool
} from "../browser-tools/contracts";
import { importBundledBrowserTools, getBundledToolVersions } from "../browser-tools/bundled";
import { parseBrowserToolYaml } from "../browser-tools/loader";
import { matchesBrowserTool } from "../browser-tools/matcher";
import { resolveParameterDefaults, resolveTemplate } from "../browser-tools/template";
import { logDebug, logInfo, logWarn } from "../logging/logger";
import { stageAndMaybePublish } from "./feed";
import { getFollows, updateFollowProfile } from "../collector/follows";
import { filterUncollected, recordCollectedIds } from "../collector/collectedIndex";
import { getBudgetUsage, budgetPauseReason, recordActivity, releaseActivity } from "../collector/budget";
import { filterSinceRecords, getWatermark, setWatermark } from "../collector/watermarks";
import {
  deleteStoredBrowserTool,
  getBrowserToolRuns,
  getStoredBrowserTool,
  getStoredBrowserTools,
  saveBrowserToolRun,
  saveStoredBrowserTool
} from "../browser-tools/storage";
import {
  advanceBatchRun,
  clearBatchRunState,
  clearControlRequest,
  consumeControlRequest,
  getAllBatchRunStates,
  getBatchRunState,
  isTransientBatchError,
  peekControlRequest,
  requestPauseBatchRun,
  requestStopBatchRun,
  saveBatchRunState,
  type BatchRunState
} from "./runControl";

export function validateBrowserToolYaml(source: string) {
  return parseBrowserToolYaml(source);
}

export async function importBrowserTool(yaml: string): Promise<StoredBrowserTool> {
  const definition = parseBrowserToolYaml(yaml);
  const current = await getStoredBrowserTool(definition.id);
  const now = Date.now();
  const tool: StoredBrowserTool = {
    id: definition.id,
    enabled: current?.enabled !== false,
    yaml,
    definition,
    importedAt: current?.importedAt || now,
    updatedAt: now,
    source: { type: "user" }
  };
  await saveStoredBrowserTool(tool);
  return tool;
}

export { importBundledBrowserTools };

export async function removeBrowserTool(toolId: string): Promise<void> {
  await deleteStoredBrowserTool(toolId);
}

export async function getBrowserToolManagerState(tabId?: number): Promise<BrowserToolManagerState> {
  const [tools, recentRuns, targetTab] = await Promise.all([
    getStoredBrowserTools(),
    getBrowserToolRuns(),
    getTargetTab(tabId).catch(() => undefined)
  ]);
  const pageUrl = targetTab?.url;
  const activeTools = tools.filter((tool) => !tool.source?.backupOf);

  return {
    tools: activeTools,
    backups: tools.filter((tool) => tool.source?.backupOf),
    bundledVersions: getBundledToolVersions(),
    recentRuns,
    targetTab:
      targetTab?.id !== undefined && pageUrl
        ? { id: targetTab.id, title: targetTab.title || pageUrl, url: pageUrl }
        : undefined,
    matchedToolIds: pageUrl ? activeTools.filter((tool) => tool.enabled !== false && matchesBrowserTool(tool.definition, pageUrl)).map((tool) => tool.id) : []
  };
}

export async function runStoredBrowserTool(input: {
  toolId: string;
  parameters: Record<string, unknown>;
  tabId?: number;
  userInitiated?: boolean;
}): Promise<BrowserToolRunResult> {
  const tool = await getStoredBrowserTool(input.toolId);
  if (!tool || tool.source?.backupOf || tool.enabled === false) throw new Error(`工具已停用或不可运行：${input.toolId}`);
  return runBrowserTool({ ...input, yaml: tool.yaml });
}

export async function runStoredBrowserToolBatch(input: {
  toolId: string;
  keywords: string[];
  parameters: Record<string, unknown>;
  tabId?: number;
  userInitiated?: boolean;
  nativeExport?: { definitionId: string; maxRecords: number };
}): Promise<BrowserToolRunResult> {
  const tool = await getStoredBrowserTool(input.toolId);
  if (!tool || tool.source?.backupOf || tool.enabled === false) throw new Error(`工具已停用或不可运行：${input.toolId}`);
  const definition = parseBrowserToolYaml(tool.yaml);
  if (!definition.batch) throw new Error(`工具 ${definition.id} 没有声明批量检索能力。`);
  assertUserInitiated(definition, input.userInitiated);

  const maxKeywords = definition.batch.max_keywords || 25;
  const keywords = normalizeKeywords(input.keywords);
  if (keywords.length === 0) throw new Error("至少需要一个有效检索词。");
  if (keywords.length > maxKeywords) throw new Error(`检索词不能超过 ${maxKeywords} 个，当前为 ${keywords.length} 个。`);

  const tab = await getTargetTab(input.tabId);
  if (tab.id === undefined || !tab.url) throw new Error("没有找到可运行批量检索的网页标签页。");
  if (!matchesBrowserTool(definition, tab.url)) throw new Error(`工具 ${definition.id} 不适用于当前页面。`);

  return startBatchRun(definition, keywords, input.parameters, tab.id, input.nativeExport);
}

/** 调度器专用入口：用户开启定时采集时已锁定规则版本，不再要求 userInitiated。 */
export async function executeAuthorizedCollectorBatch(
  toolId: string,
  keywords: string[],
  tabId: number
): Promise<BrowserToolRunResult> {
  const tool = await getStoredBrowserTool(toolId);
  if (!tool) throw new Error(`没有找到 Browser Tool：${toolId}`);
  const definition = parseBrowserToolYaml(tool.yaml);
  if (!definition.feed || !definition.batch) throw new Error("此工具未声明采集能力。");
  const normalized = normalizeKeywords(keywords);
  const maxKeywords = definition.batch.max_keywords || 25;
  if (normalized.length === 0) throw new Error("关注列表为空。");
  if (normalized.length > maxKeywords) throw new Error(`关注账号超过工具上限 ${maxKeywords}。`);
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !matchesBrowserTool(definition, tab.url)) throw new Error("采集标签页不匹配工具域名。");
  return startBatchRun(definition, normalized, {}, tabId);
}

async function startBatchRun(
  definition: ReturnType<typeof parseBrowserToolYaml>,
  keywords: string[],
  parameters: Record<string, unknown>,
  tabId: number,
  nativeExport?: { definitionId: string; maxRecords: number }
): Promise<BrowserToolRunResult> {
  await clearBatchRunState(definition.id);
  clearControlRequest();
  // 界面批量入口已解析默认值，定时调度授权入口传空参数——这里统一补齐，
  // 否则 YAML 中引用 parameters 的模板（如用户间隔）在后台解析时报变量不存在。
  const resolvedParameters = resolveParameterDefaults(definition, parameters);
  const state: BatchRunState = {
    runId: `browser_tool_batch_${createBackgroundRunId()}`,
    toolId: definition.id,
    toolName: definition.name,
    keywords,
    nextIndex: 0,
    completedKeywords: 0,
    parameters: resolvedParameters,
    tabId,
    status: "running",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    lastPageUrl: "",
    lastPageTitle: definition.name,
    data: {}
  };
  await saveBatchRunState(state);
  return continueBatchRun(definition, state, tabId, nativeExport);
}

/** 从暂停状态恢复批量运行；由 Trail 界面的”继续”触发。 */
export async function resumeBrowserToolBatch(input: { tabId?: number; userInitiated?: boolean }): Promise<BrowserToolRunResult> {
  const states = await getAllBatchRunStates();
  const state = states.find((s) => s.status === "paused") || null;
  if (!state) throw new Error("没有可继续的批量运行。");
  if (state.status !== "paused") throw new Error(`当前运行状态为 ${state.status}，不能继续。`);
  const tool = await getStoredBrowserTool(state.toolId);
  if (!tool) throw new Error(`没有找到 Browser Tool：${state.toolId}`);
  const definition = parseBrowserToolYaml(tool.yaml);
  assertUserInitiated(definition, input.userInitiated);

  let tab: chrome.tabs.Tab | undefined;
  if (state.tabId !== undefined) tab = await chrome.tabs.get(state.tabId).catch(() => undefined);
  if (!tab || !tab.url || !matchesBrowserTool(definition, tab.url)) tab = await getTargetTab(input.tabId);
  if (!tab.id || !tab.url || !matchesBrowserTool(definition, tab.url)) {
    throw new Error("继续运行需要打开一个匹配工具域名的网页标签页。");
  }
  clearControlRequest();
  const resumed: BatchRunState = { ...state, status: "running", tabId: tab.id, updatedAt: Date.now() };
  await saveBatchRunState(resumed);
  logInfo("batch", "batch.resume", "恢复已暂停的批量运行", { toolId: state.toolId, fromIndex: state.nextIndex, remaining: state.keywords.length - state.nextIndex });
  return continueBatchRun(definition, resumed, tab.id);
}

export async function getBrowserToolBatchRunState(): Promise<BatchRunState | null> {
  const states = await getAllBatchRunStates();
  return states[0] || null;
}

export function pauseBrowserToolBatch(): { requested: boolean } {
  return requestPauseBatchRun();
}

/** 停止批量运行：运行中在下一个输入边界收尾；已暂停时立即以现有数据收尾。 */
export async function stopBrowserToolBatch(): Promise<{ requested: boolean; finalized: boolean }> {
  const states = await getAllBatchRunStates();
  const state = states.find((s) => s.status === "running") || states.find((s) => s.status === "paused") || null;
  if (!state) return { requested: false, finalized: false };
  if (state.status === "running") {
    requestStopBatchRun();
    return { requested: true, finalized: false };
  }
  if (state.status !== "paused") return { requested: false, finalized: false };
  const tool = await getStoredBrowserTool(state.toolId);
  if (!tool) throw new Error(`没有找到 Browser Tool：${state.toolId}`);
  const definition = parseBrowserToolYaml(tool.yaml);
  await finalizeBatchRun(definition, { ...state, status: "stopped", pendingControl: undefined }, "partial", `已手动停止：完成 ${state.completedKeywords}/${state.keywords.length} 个输入。`);
  return { requested: true, finalized: true };
}

/**
 * 批量主循环。每个输入完成前先消费暂停/停止请求；
 * 进度写入 session 存储以支撑暂停恢复与中断检测。
 */
async function continueBatchRun(
  definition: ReturnType<typeof parseBrowserToolYaml>,
  initial: BatchRunState,
  tabId: number,
  nativeExport?: { definitionId: string; maxRecords: number }
): Promise<BrowserToolRunResult> {
  const startedAt = initial.startedAt;
  const batch = definition.batch;
  if (!batch) throw new Error(`工具 ${definition.id} 没有声明批量检索能力。`);
  const progressId = `browser_tool_progress_${createBackgroundRunId()}`;
  const warnings: string[] = [];
  const nativeExports: NonNullable<BrowserToolRunResult["nativeExports"]> = [];
  let state = initial;
  let failed = false;
  const transientRetries = new Map<number, number>();
  const cooldownRetries = new Map<number, number>();
  const runStartedAt = Date.now();
  const displayNames = definition.feed ? new Map((await getFollows(definition.feed.platform)).filter((entry) => entry.displayName).map((entry) => [entry.handle, entry.displayName!])) : undefined;
  logInfo("batch", "batch.start", "批量运行开始", { toolId: definition.id, runId: initial.runId, total: initial.keywords.length, fromIndex: initial.nextIndex });

  const heartbeat = setInterval(() => {
    state = { ...state, updatedAt: Date.now() };
    void saveBatchRunState(state).catch(() => undefined);
  }, 30_000);

  try {
    while (state.nextIndex < state.keywords.length) {
      const persisted = state.pendingControl;
      const control = consumeControlRequest();
      const stopRequested = control.stop || persisted === 'stop';
      const pauseRequested = control.pause || persisted === 'pause';
      if (stopRequested) {
        logInfo("batch", "batch.control", "收到停止请求，在当前输入边界收尾", { completed: state.completedKeywords, total: state.keywords.length });
        return await finalizeBatchRun(definition, { ...state, status: "stopped", pendingControl: undefined }, "partial",
          `已手动停止：完成 ${state.completedKeywords}/${state.keywords.length} 个输入。`, warnings);
      }
      if (pauseRequested) {
        logInfo("batch", "batch.control", "收到暂停请求，在当前输入边界挂起", { completed: state.completedKeywords, total: state.keywords.length });
        return await finalizeBatchRun(definition, { ...state, status: "paused", pendingControl: undefined }, "paused",
          `已暂停：完成 ${state.completedKeywords}/${state.keywords.length} 个输入，可稍后继续。`, warnings);
      }

      const keyword = state.keywords[state.nextIndex];
      const index = state.nextIndex;
      try {
        emitProgress({
          type: "BROWSER_TOOL_PROGRESS_UPDATE",
          progressId,
          toolId: definition.id,
          scope: "keyword",
          label: "正在处理检索式",
          itemLabel: "条",
          current: index + 1,
          total: state.keywords.length,
          recordCount: countBatchRecords(state)
        });
        const currentTab = await chrome.tabs.get(tabId);
        if (!currentTab.url) throw new Error("目标标签页没有有效 URL。");
        const navigation = batch.navigation;
        const nextUrl = navigation.type === "query_parameter"
          ? buildBatchUrl(currentTab.url, navigation.parameter, keyword)
          : resolveBatchFixedUrl(navigation.url, definition, state.parameters, keyword);
        if (!matchesBrowserTool(definition, nextUrl)) throw new Error(`工具 ${definition.id} 的批量导航地址不在适用范围内。`);
        if (definition.feed) {
          const budget = await recordActivity(definition.feed.platform, "profile");
          if (!budget.allowed) {
            logWarn("batch", "budget.exhausted", "平台采集预算不足", { platform: budget.platform, used: budget.used, limit: budget.limit });
            return await finalizeBatchRun(definition, { ...state, status: "paused", pendingControl: undefined }, "paused", budgetPauseReason(budget), warnings);
          }
          const wait = await sleepInterruptible(budget.delayMs);
          if (wait !== "done") {
            await releaseActivity(budget, "profile");
            return await finalizeBatchRun(definition, { ...state, status: wait === "stop" ? "stopped" : "paused", pendingControl: undefined }, wait === "stop" ? "partial" : "paused", "等待访问间隔时已" + (wait === "stop" ? "停止" : "暂停") + "，进度已保存。", warnings);
          }
        }
        const runParameters = navigation.type === "fixed_url"
          ? { ...state.parameters, [navigation.input_parameter]: keyword }
          : state.parameters;
        await navigateTab(tabId, nextUrl);
        const readyTab = await chrome.tabs.get(tabId);
        const raw = await executeBrowserToolOnTab(definition, runParameters, readyTab, progressId);
        const result = await enrichWithDetails(definition, tabId, await applySinceFilter(definition, keyword, raw));

        if (result.status === "paused") {
          if (result.pauseReason === "budget") {
            warnings.push(...result.warnings);
            return await finalizeBatchRun(definition, { ...state, status: "paused", pendingControl: undefined, lastPageUrl: result.pageUrl, lastPageTitle: result.pageTitle }, "paused", result.error || "平台预算不足，进度已保存。", warnings);
          }
          // 软封锁自动冷却：15 分钟后自动重试一次（可被停止打断），再失败转人工。
          if ((cooldownRetries.get(index) || 0) < 2) {
            cooldownRetries.set(index, (cooldownRetries.get(index) || 0) + 1);
            const reason = result.error || "需要登录或验证";
            logWarn("batch", "cooldown.start", "软封锁，15 分钟后自动重试一次", { platform: definition.feed?.platform, toolId: definition.id, runId: state.runId, keyword, detail: reason });
            warnings.push("[" + keyword + "] " + reason + "；15 分钟后自动重试。");
            const cooled = await sleepInterruptible(15 * 60_000);
            if (cooled === "stop") {
              return await finalizeBatchRun(definition, { ...state, status: "stopped", pendingControl: undefined }, "partial", "已手动停止：完成 " + state.completedKeywords + "/" + state.keywords.length + " 个输入。", warnings);
            }
            if (cooled === "pause") {
              return await finalizeBatchRun(definition, { ...state, status: "paused", pendingControl: undefined }, "paused", "冷却期间收到暂停请求：完成 " + state.completedKeywords + "/" + state.keywords.length + " 个输入。", warnings);
            }
            continue; // 重试当前输入（游标未推进）
          }
          logWarn("batch", "batch.paused", "冷却重试仍被拦截，转人工处理", { platform: definition.feed?.platform, toolId: definition.id, runId: state.runId, keyword, detail: result.error || "登录或验证码" });
          warnings.push("[" + keyword + "] 需要人工处理：" + (result.error || "登录或验证码"));
          const pausedState = { ...state, status: "paused" as const, pendingControl: undefined, updatedAt: Date.now(), lastPageUrl: result.pageUrl, lastPageTitle: result.pageTitle };
          await saveBatchRunState(pausedState);
          return await finalizeBatchRun(definition, { ...pausedState, pendingControl: undefined }, "paused",
            "[" + keyword + "] 冷却重试后仍被拦截，已暂停；请打开页面完成验证后点“继续”重试。", warnings);
        }

        warnings.push(...result.warnings.map((warning) => `[${keyword}] ${warning}`));
        if (result.status !== "completed") {
          const message = result.error || "提取未完整完成";
          if ((transientRetries.get(index) || 0) < 3 && isTransientBatchError(message)) {
            transientRetries.set(index, (transientRetries.get(index) || 0) + 1);
            logWarn("batch", "keyword.retry", "瞬时错误，5 秒后重试当前输入", { keyword, error: message, attempt: transientRetries.get(index) });
            warnings.push(`[${keyword}] ${message}；5 秒后重试。`);
            await sleep(5_000);
            continue;
          }
          // 失败的输入不推进游标（继续/重试时从该输入重新开始），也不计入完成数。
          state = { ...state, lastPageUrl: result.pageUrl, lastPageTitle: result.pageTitle };
          failed = true;
          warnings.push(`[${keyword}] ${message}`);
          break;
        }
        state = {
          ...advanceBatchRun(state, keyword, (() => { const name = displayNames?.get(keyword); return name ? enrichAuthor(result.data, keyword, name) : result.data; })()),
          lastPageUrl: result.pageUrl,
          lastPageTitle: result.pageTitle
        };
        await advanceWatermark(definition, keyword, result.data);
        await refreshFollowProfile(definition, keyword, result.data);
        logDebug("batch", "keyword.done", "完成当前输入", {
          keyword,
          index: index + 1,
          records: Object.values(result.data).reduce((total, records) => total + records.length, 0)
        });
        if (nativeExport) {
          const exportDefinition = definition.native_exports?.find((item) => item.id === nativeExport?.definitionId);
          if (!exportDefinition) throw new Error("工具没有对应的原生导出定义。");
          const exportSummary = await runNativeExportBatches(tabId, definition.id, exportDefinition, nativeExport.maxRecords, keyword, progressId);
          nativeExports.push(exportSummary);
          if (exportSummary.error) warnings.push(`[${keyword}] 原生导出部分完成：${exportSummary.error}`);
        }
        await saveBatchRunState(state);
      } catch (error) {
        const message = error instanceof Error ? error.message : "批量检索失败";
        if ((transientRetries.get(index) || 0) < 3 && isTransientBatchError(message)) {
          transientRetries.set(index, (transientRetries.get(index) || 0) + 1);
          logWarn("batch", "keyword.retry", "瞬时异常，5 秒后重试当前输入", { keyword, error: message, attempt: transientRetries.get(index) });
          warnings.push(`[${keyword}] ${message}；5 秒后重试。`);
          await sleep(5_000);
          continue;
        }
        failed = true;
        warnings.push(`[${keyword}] ${message}`);
        break;
      }

      if (index < state.keywords.length - 1) {
        const rawDelay = batch.delay_between_keywords_ms;
        const delay = typeof rawDelay === "string"
          ? Number(resolveTemplate(rawDelay, definition, state.parameters))
          : rawDelay || 0;
        if (Number.isFinite(delay) && delay > 0) await sleep(delay);
      }
    }
  } finally {
    clearInterval(heartbeat);
  }

  const status: BrowserToolRunResult["status"] = failed
    ? state.completedKeywords > 0
      ? "partial"
      : "failed"
    : "completed";
  const result: BrowserToolRunResult = {
    toolId: definition.id,
    runId: state.runId,
    pageUrl: state.lastPageUrl,
    pageTitle: state.lastPageTitle,
    startedAt,
    finishedAt: Date.now(),
    status,
    data: state.data,
    warnings,
    nativeExports: nativeExports.length > 0 ? nativeExports : undefined,
    error: failed ? `已完成 ${state.completedKeywords}/${state.keywords.length} 个输入。` : undefined
  };
  void stageAndMaybePublish(definition, result).catch(() => undefined);
  await clearBatchRunState(definition.id);
  logInfo("batch", "batch.done", "批量运行结束", {
    toolId: definition.id,
    status,
    completed: state.completedKeywords,
    total: state.keywords.length,
    records: countBatchRecords(state),
    durationMs: Date.now() - runStartedAt
  });
  return persistRunResult(result, `${state.toolName} · 批量`);
}

/** 暂停或停止时的收尾：暂停保留运行状态供继续；停止/失败清理状态并暂存已得数据。 */
async function finalizeBatchRun(
  definition: ReturnType<typeof parseBrowserToolYaml>,
  state: BatchRunState,
  status: BrowserToolRunResult["status"],
  error: string,
  warnings: string[] = []
): Promise<BrowserToolRunResult> {
  if (status === "paused") await saveBatchRunState(state);
  const result: BrowserToolRunResult = {
    toolId: definition.id,
    runId: state.runId,
    pageUrl: state.lastPageUrl,
    pageTitle: state.lastPageTitle,
    startedAt: state.startedAt,
    finishedAt: Date.now(),
    status,
    data: state.data,
    warnings,
    error
  };
  if (status !== "paused") {
    void stageAndMaybePublish(definition, result).catch(() => undefined);
    await clearBatchRunState(definition.id);
  }
  return persistRunResult(result, `${state.toolName} · 批量`);
}

function countBatchRecords(state: BatchRunState): number {
  return Object.values(state.data).reduce((total, records) => total + records.length, 0);
}

/** fixed_url 支持 {{ parameters.x }} 模板；当前批次的输入参数会注入为关键字值。 */
function resolveBatchFixedUrl(
  url: string,
  definition: ReturnType<typeof parseBrowserToolYaml>,
  parameters: Record<string, unknown>,
  keyword: string
): string {
  if (!url.includes("{{")) return url;
  const navigation = definition.batch!.navigation;
  if (navigation.type !== "fixed_url") return url;
  const batchParameters = { ...parameters, [navigation.input_parameter]: keyword };
  return resolveTemplate(url, definition, batchParameters);
}

async function runNativeExportBatches(
  tabId: number,
  toolId: string,
  definition: BrowserToolNativeExportDefinition,
  requestedLimit: number,
  query: string,
  progressId: string
): Promise<NonNullable<BrowserToolRunResult["nativeExports"]>[number]> {
  const countResponse = await chrome.tabs.sendMessage<GetBrowserToolNativeExportCountMessage, { totalRecords?: number; error?: string }>(tabId, {
    type: "GET_BROWSER_TOOL_NATIVE_EXPORT_COUNT",
    definition
  });
  if (countResponse?.error) throw new Error(countResponse.error);
  const totalRecords = Math.max(0, countResponse?.totalRecords || 0);
  const exportLimit = Math.min(totalRecords, Math.max(1, requestedLimit), definition.max_limit);
  const files: string[] = [];
  let exportedRecords = 0;
  let exportError: string | undefined;
  const batchCount = Math.ceil(exportLimit / definition.max_batch);

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const from = batchIndex * definition.max_batch + 1;
    const to = Math.min(exportLimit, from + definition.max_batch - 1);
    emitProgress({
      type: "BROWSER_TOOL_PROGRESS_UPDATE",
      progressId,
      toolId,
      scope: "export",
      label: "正在导出完整记录",
      itemLabel: "批",
      current: batchIndex + 1,
      total: batchCount,
      recordCount: to
    });
    try {
      const downloadPromise = waitForNativeDownloadStart(definition.extension, 60_000);
      const response = await chrome.tabs.sendMessage<RunBrowserToolNativeExportBatchMessage, { started?: boolean; error?: string }>(tabId, {
        type: "RUN_BROWSER_TOOL_NATIVE_EXPORT_BATCH",
        definition,
        from,
        to
      });
      if (response?.error) {
        void downloadPromise.catch(() => undefined);
        throw new Error(response.error);
      }
      const download = await downloadPromise;
      const completed = await waitForNativeDownloadComplete(download.id, 5 * 60_000);
      files.push(completed.filename.split(/[\\/]/).pop() || `export-${batchIndex + 1}.${definition.extension}`);
      exportedRecords = to;
    } catch (error) {
      exportError = error instanceof Error ? error.message : "原生导出失败。";
      break;
    }
  }
  return { query, totalRecords, exportedRecords, files, error: exportError };
}

function waitForNativeDownloadStart(extension: string, timeoutMs: number): Promise<chrome.downloads.DownloadItem> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => finish(undefined, new Error("等待 WoS 导出文件超时。")), timeoutMs);
    const listener = (item: chrome.downloads.DownloadItem) => {
      if (item.filename.toLowerCase().endsWith(`.${extension.toLowerCase()}`)) finish(item);
    };
    const finish = (item?: chrome.downloads.DownloadItem, error?: Error) => {
      globalThis.clearTimeout(timeout);
      chrome.downloads.onCreated.removeListener(listener);
      error ? reject(error) : resolve(item!);
    };
    chrome.downloads.onCreated.addListener(listener);
  });
}

function waitForNativeDownloadComplete(id: number, timeoutMs: number): Promise<chrome.downloads.DownloadItem> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => finish(undefined, new Error("WoS 导出文件下载超时。")), timeoutMs);
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== id || !delta.state?.current) return;
      if (delta.state.current === "complete") void lookup().then((item) => finish(item), (error) => finish(undefined, error));
      if (delta.state.current === "interrupted") finish(undefined, new Error(delta.error?.current || "WoS 导出下载中断。"));
    };
    const lookup = async () => {
      const [item] = await chrome.downloads.search({ id });
      if (!item) throw new Error("找不到 WoS 导出下载记录。");
      return item;
    };
    const finish = (item?: chrome.downloads.DownloadItem, error?: Error) => {
      globalThis.clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(listener);
      error ? reject(error) : resolve(item!);
    };
    chrome.downloads.onChanged.addListener(listener);
    void lookup().then((item) => item.state === "complete" ? finish(item) : undefined).catch(() => undefined);
  });
}

export async function runBrowserTool(input: {
  yaml: string;
  parameters: Record<string, unknown>;
  tabId?: number;
  userInitiated?: boolean;
}): Promise<BrowserToolRunResult> {
  const definition = parseBrowserToolYaml(input.yaml);
  assertUserInitiated(definition, input.userInitiated);

  const tab = await getTargetTab(input.tabId);
  if (tab.id === undefined || !tab.url) throw new Error("没有找到可运行 Browser Tool 的网页标签页。");
  if (!/^https?:/i.test(tab.url)) throw new Error("Browser Tool 只能在普通 HTTP(S) 页面运行。");
  if (!matchesBrowserTool(definition, tab.url)) throw new Error(`工具 ${definition.id} 不适用于当前页面。`);

  if (definition.feed) {
    const budget = await recordActivity(definition.feed.platform, "profile");
    if (!budget.allowed) {
      const now = Date.now();
      return persistRunResult({ toolId: definition.id, runId: createBackgroundRunId(), pageUrl: tab.url, pageTitle: tab.title || tab.url,
        startedAt: now, finishedAt: now, status: "paused", pauseReason: "budget", data: {}, warnings: [],
        error: budgetPauseReason(budget).replace("进度已保存，额度恢复或调整预算后请点继续。", "额度恢复或调整预算后请重新运行。") }, definition.name);
    }
    if (budget.delayMs > 0) await sleep(budget.delayMs);
  }
  const result = await enrichWithDetails(definition, tab.id!, await executeBrowserToolOnTab(definition, input.parameters, tab));
  void stageAndMaybePublish(definition, result).catch(() => undefined);
  return persistRunResult(result, definition.name);
}

// Only the background check-in controller calls this after manual/schedule authorization.
// It is deliberately not exposed as a runtime message or a userInitiated bypass.
export async function executeAuthorizedCheckin(tool: StoredBrowserTool, tabId: number): Promise<BrowserToolRunResult> {
  const definition = parseBrowserToolYaml(tool.yaml);
  if (!definition.checkin) throw new Error("此工具未声明签到能力。");
  const tab = await getTargetTab(tabId);
  const result = await executeBrowserToolOnTab(definition, {}, tab);
  return persistRunResult(result, definition.name);
}

async function executeBrowserToolOnTab(
  definition: ReturnType<typeof parseBrowserToolYaml>,
  parameters: Record<string, unknown>,
  tab: chrome.tabs.Tab,
  progressId?: string
): Promise<BrowserToolRunResult> {
  if (tab.id === undefined || !tab.url) throw new Error("目标标签页不可用。");
  if (!/^https?:/i.test(tab.url)) throw new Error("Browser Tool 只能在普通 HTTP(S) 页面运行。");
  if (!matchesBrowserTool(definition, tab.url)) throw new Error(`工具 ${definition.id} 不适用于当前页面。`);

  const message: ExecuteBrowserToolMessage = {
    type: "EXECUTE_BROWSER_TOOL",
    definition,
    parameters,
    progressId
  };
  const startedAt = Date.now();
  const context = definition.feed ? (await getBudgetUsage([definition.feed.platform]))[0] : undefined;
  try {
    const response = await sendToolMessageWithRetry(tab.id, message);
    if (response && "error" in response && !("status" in response)) throw new Error(response.error);
    const result = response as BrowserToolRunResult;
    const data = { platform: definition.feed?.platform, toolId: definition.id, runId: progressId, kind: "profile", durationMs: Date.now() - startedAt, status: result.status, reason: result.error, records: Object.values(result.data || {}).reduce((sum, rows) => sum + rows.length, 0), config: context?.config, used: context?.used, limit: context?.limit };
    if (result.status === "paused" || result.status === "failed") logWarn("activity", "activity.result", "平台访问暂停或失败", data);
    else logInfo("activity", "activity.result", "平台访问完成", data);
    return result;
  } catch (error) {
    logWarn("activity", "activity.failed", "平台访问异常", { platform: definition.feed?.platform, toolId: definition.id, runId: progressId, kind: "profile", durationMs: Date.now() - startedAt, reason: error instanceof Error ? error.message : String(error), config: context?.config });
    throw error;
  }
}

function emitProgress(progress: BrowserToolExecutionProgress): void {
  void chrome.runtime.sendMessage(progress).catch(() => undefined);
}

async function persistRunResult(result: BrowserToolRunResult, toolName: string): Promise<BrowserToolRunResult> {
  try {
    await saveBrowserToolRun(result, toolName);
    logDebug("run", "run.persisted", "运行结果已写入历史", {
      toolId: result.toolId,
      status: result.status,
      records: Object.values(result.data).reduce((total, records) => total + records.length, 0)
    });
    return result;
  } catch {
    return {
      ...result,
      warnings: [...result.warnings, "运行已完成，但结果未能写入本地历史记录。"]
    };
  }
}

async function sendToolMessageWithRetry(
  tabId: number,
  message: ExecuteBrowserToolMessage
): Promise<BrowserToolRunResult | { error: string }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage<ExecuteBrowserToolMessage, BrowserToolRunResult | { error: string }>(tabId, message);
    } catch (error) {
      lastError = error;
      // A closed response channel may mean the action already ran. Never replay it.
      if (!(error instanceof Error) || !error.message.includes("Receiving end does not exist")) throw error;
      await sleep(350);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法连接目标网页，请刷新后重试。");
}

function buildBatchUrl(pageUrl: string, parameter: string, keyword: string): string {
  const url = new URL(pageUrl);
  url.searchParams.set(parameter, keyword);
  return url.href;
}

function navigateTab(tabId: number, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => finish(new Error("等待检索结果页加载超时。")), 45_000);
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const finish = (error?: Error) => {
      globalThis.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.update(tabId, { url }).catch((error: unknown) => finish(error instanceof Error ? error : new Error("导航失败。")));
  });
}

function normalizeKeywords(values: string[]): string[] {
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function assertUserInitiated(definition: ReturnType<typeof parseBrowserToolYaml>, userInitiated?: boolean): void {
  if (definition.limits?.require_user_activation !== false && userInitiated !== true) {
    throw new Error("该 Browser Tool 必须由用户主动启动。");
  }
}

function createBackgroundRunId(): string {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function sleep(duration: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, duration));
}

async function getTargetTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (tabId !== undefined) return chrome.tabs.get(tabId);
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) throw new Error("没有找到当前活动标签页。");
  return activeTab;
}

/**
 * 详情页补全：主工作流提取卡片后，由后台串行导航详情页，向内容脚本
 * 请求字段提取并合并回记录。条目间隔遵守 detail_extract.delay_ms；
 * 命中阻断器（URL 片段或选择器）时整体转暂停，交还用户处理。
 */
async function enrichWithDetails(
  definition: ReturnType<typeof parseBrowserToolYaml>,
  tabId: number,
  result: BrowserToolRunResult
): Promise<BrowserToolRunResult> {
  const spec = definition.detail_extract;
  if (!spec) return result;
  const records = result.data[spec.collection];
  if (!records || records.length === 0) return result;
  const maxItems = Math.min(spec.max_items || records.length, records.length);
  const delay = spec.delay_ms ?? 0;
  let enriched = 0;

  // 本地已采集 ID 索引：跳过已补全过详情的记录，不浪费预算。
  const platform = definition.feed?.platform;
  const allIds = records.map((r) => String(r.id || "")).filter(Boolean);
  const uncollected = platform ? new Set(await filterUncollected(platform, allIds)) : null;
  const newlyEnrichedIds: string[] = [];

  for (const record of records.slice(0, maxItems)) {
    const url = record[spec.url_field];
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) continue;
    const recordId = String(record.id || "");
    if (uncollected && recordId && !uncollected.has(recordId)) continue;
    if (definition.feed) {
      const detailBudget = await recordActivity(definition.feed.platform, "detail");
      if (!detailBudget.allowed) {
        logWarn("detail", "budget.exhausted", "平台详情预算不足，停止补全", { platform: detailBudget.platform, used: detailBudget.used, limit: detailBudget.limit });
        return { ...result, status: "paused", pauseReason: "budget", error: budgetPauseReason(detailBudget) };
      }
      if (await sleepInterruptible(detailBudget.delayMs) !== "done") { await releaseActivity(detailBudget, "detail"); break; }
    }
    const detailStartedAt = Date.now();
    await navigateTab(tabId, url);
    const tab = await chrome.tabs.get(tabId);
    const urlBlocker = (spec.blockers || []).find((blocker) => blocker.url_contains && (tab.url || "").includes(blocker.url_contains));
    if (urlBlocker) {
      logWarn("activity", "detail.blocked", "详情页触发规则拦截", { platform: definition.feed?.platform, toolId: definition.id, kind: "detail", reason: urlBlocker.reason, durationMs: Date.now() - detailStartedAt });
      return { ...result, status: "paused", error: urlBlocker.reason, warnings: [...result.warnings, urlBlocker.reason] };
    }
    const detail = await extractDetailsOnTab(tabId, spec);
    const detailUsage = definition.feed ? (await getBudgetUsage([definition.feed.platform]))[0] : undefined;
    const detailLog = { platform: definition.feed?.platform, toolId: definition.id, kind: "detail", config: detailUsage?.config, used: detailUsage?.used, durationMs: Date.now() - detailStartedAt, reason: detail.paused?.error || detail.warning };
    if (detail.paused || detail.warning) logWarn("activity", "detail.result", "详情访问暂停或失败", detailLog);
    else logInfo("activity", "detail.result", "详情访问完成", detailLog);
    if (detail.paused) return detail.paused;
    if (detail.warning) {
      result.warnings.push("[详情] " + detail.warning);
      // 排队到下轮补全：记录 ID 存入 localStorage，下次该账号采集时优先重试
      const retryId = String(record.id || "");
      if (retryId && definition.feed) {
        const retryKey = `trail.detailRetry.${definition.feed.platform}.${keywordFromUrl(url)}`;
        try {
          const stored = (await chrome.storage.local.get(retryKey)) as Record<string, string>;
          const existing = JSON.parse(stored[retryKey] || "[]") as string[];
          if (!existing.includes(retryId)) {
            existing.push(retryId);
            await chrome.storage.local.set({ [retryKey]: JSON.stringify(existing.slice(-50)) });
          }
        } catch { /* 存储失败不影响主流程 */ }
      }
      continue;
    }
    Object.assign(record, detail.record || {});
    enriched += 1;
    if (recordId) newlyEnrichedIds.push(recordId);
    const peeked = peekControlRequest();
    if (peeked.pause || peeked.stop) break;
    if (delay > 0 && enriched < maxItems) await sleep(delay);
  }
  // 成功补全的 ID 写入本地索引（跨发布持久，下次直接跳过）。
  if (platform && newlyEnrichedIds.length > 0) {
    await recordCollectedIds(platform, newlyEnrichedIds).catch(() => undefined);
  }
  if (enriched === 0 && records.length > 0 && !peekControlRequest().pause && !peekControlRequest().stop) {
    const reason = "详情补全全部失败（页面可能要求登录或验证），已暂停；完成验证后点继续将从该账号重试。";
    logWarn("detail", "detail.allFailed", "详情补全全部失败，运行转暂停", { platform: definition.feed?.platform, toolId: definition.id, records: records.length });
    return { ...result, status: "paused", error: reason, warnings: [...result.warnings, reason] };
  }
  logInfo("detail", "detail.enrich", "详情页补全完成", { platform: definition.feed?.platform, toolId: definition.id, enriched });
  return result;
}

/** 详情页字段提取 + 阻断检测；命中阻断时返回暂停结果，提取异常返回 warning。 */
async function extractDetailsOnTab(
  tabId: number,
  spec: NonNullable<ReturnType<typeof parseBrowserToolYaml>["detail_extract"]>
): Promise<{ record?: Record<string, unknown>; warning?: string; paused?: BrowserToolRunResult }> {
  const response = await chrome.tabs.sendMessage(tabId, {
    type: "EXTRACT_BROWSER_TOOL_DETAILS",
    fields: spec.fields,
    waitFor: spec.wait_for,
    timeoutMs: spec.timeout_ms,
    blockers: (spec.blockers || []).filter((blocker) => blocker.selector)
  }).catch(() => undefined);
  if (!response || response.error) {
    return { warning: response?.error || "无法在详情页提取字段。" };
  }
  if (response.blocker) {
    return { paused: { status: "paused", error: response.blocker, warnings: [response.blocker] } as BrowserToolRunResult };
  }
  return { record: response.record };
}


/** 批量合并时给记录补充可读的账号名（详情页没提取到 author 时兜底）。 */
function enrichAuthor(
  data: BrowserToolRunResult["data"],
  keyword: string,
  displayName: string
): BrowserToolRunResult["data"] {
  return Object.fromEntries(Object.entries(data).map(([collection, records]) => [
    collection,
    records.map((record) => ({ _query: keyword, author: displayName, ...record }))
  ]));
}

/** 分片睡眠，期间响应暂停/停止请求；返回超时结束或收到的控制请求。 */
function sleepInterruptible(totalMs: number, sliceMs = 5_000): Promise<"done" | "pause" | "stop"> {
  if (totalMs <= 0) return Promise.resolve("done");
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      const peeked = peekControlRequest();
      if (peeked.stop) { clearInterval(timer); resolvePromise("stop"); return; }
      if (peeked.pause) { clearInterval(timer); resolvePromise("pause"); return; }
      if (Date.now() - startedAt >= totalMs) { clearInterval(timer); resolvePromise("done"); }
    }, Math.min(sliceMs, totalMs));
  });
}

/** 增量过滤：按 平台+账号 水位线裁剪 feed 集合（首次用回填窗口），详情补全与暂存都只处理新记录。 */
async function applySinceFilter(
  definition: ReturnType<typeof parseBrowserToolYaml>,
  keyword: string,
  result: BrowserToolRunResult
): Promise<BrowserToolRunResult> {
  const since = definition.since;
  const feed = definition.feed;
  if (!since || !feed) return result;
  const records = result.data[feed.collection];
  if (!records || records.length === 0) return result;
  const watermark = await getWatermark(feed.platform, keyword);
  const { kept, oldestIso } = filterSinceRecords(records, since.field, watermark, since.lookback_days || 7);
  if (kept.length < records.length) {
    logInfo("collector", "since.filtered", "按水位线跳过已采集记录", {
      toolId: definition.id, keyword, total: records.length, kept: kept.length,
      mode: watermark ? "incremental" : "backfill"
    });
    result.data[feed.collection] = kept;
  }
  // 存储本轮最旧时间到运行状态，供回填判断是否继续翻页。
  if (oldestIso) result.data["_backfill_oldest"] = [{ value: oldestIso }];
  return result;
}

/**
 * 关键词成功后推进水位线。
 * 正常模式：推进到本批最新（增量，已看到更新的内容）。
 * 回填模式（isBackfill）：推进到本批最旧（还没采完历史，下一轮从最旧处继续）。
 */
async function advanceWatermark(
  definition: ReturnType<typeof parseBrowserToolYaml>,
  keyword: string,
  data: BrowserToolRunResult["data"],
  isBackfill = false
): Promise<void> {
  const since = definition.since;
  const feed = definition.feed;
  if (!since || !feed) return;
  const records = data[feed.collection];
  if (!records || records.length === 0) return;
  const { newestIso, oldestIso } = filterSinceRecords(records, since.field, undefined, 90);
  const target = isBackfill ? oldestIso : newestIso;
  if (target) await setWatermark(feed.platform, keyword, target);
}

/** 从详情 URL 提取账号标识（用于 retry key）。 */
function keywordFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    // x.com/handle/status/id 或 xiaohongshu.com/user/profile/id/noteId
    if (parsed.hostname.includes("x.com") || parsed.hostname.includes("twitter.com")) return parts[0] || "unknown";
    if (parsed.hostname.includes("xiaohongshu.com")) return parts[2] || parts[1] || "unknown";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** 读取某账号的详情重试队列，并清空（本轮处理完即消）。 */
export async function takeDetailRetryQueue(platform: string, handle: string): Promise<string[]> {
  const key = `trail.detailRetry.${platform}.${handle}`;
  const result = (await chrome.storage.local.get(key)) as Record<string, string>;
  const ids = JSON.parse(result[key] || "[]") as string[];
  if (ids.length > 0) await chrome.storage.local.remove(key);
  return ids;
}

/**
 * 采集成功后从运行数据中提取用户资料（显示名 + 头像）并回写 follows 存储。
 * Twitter: graphql_fetch 的 store 已提取 profile_name / profile_avatar 到 values。
 * XHS: state_read 的 _profile 集合包含 nickname / avatar。
 */
async function refreshFollowProfile(
  definition: ReturnType<typeof parseBrowserToolYaml>,
  keyword: string,
  data: BrowserToolRunResult["data"]
): Promise<void> {
  const feed = definition.feed;
  if (!feed) return;
  const profile: { displayName?: string; avatar?: string } = {};

  // Twitter: values 中的 profile_name / profile_avatar
  const profileRecords = data["profile"];
  if (Array.isArray(profileRecords) && profileRecords.length > 0) {
    const record = profileRecords[0];
    if (typeof record.nickname === "string" && record.nickname.trim()) profile.displayName = record.nickname;
    if (typeof record.avatar === "string" && record.avatar.trim()) profile.avatar = record.avatar;
  }

  if (Object.keys(profile).length > 0) {
    await updateFollowProfile(feed.platform, keyword, profile);
    logInfo("collector", "profile.refresh", "已刷新用户资料", { platform: feed.platform, handle: keyword, ...profile });
  }
}
