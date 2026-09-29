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
import { resolveTemplate } from "../browser-tools/template";
import { logDebug, logInfo, logWarn } from "../logging/logger";
import { stageAndMaybePublish } from "./feed";
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
  getBatchRunState,
  isTransientBatchError,
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

  return {
    tools,
    bundledVersions: getBundledToolVersions(),
    recentRuns,
    targetTab:
      targetTab?.id !== undefined && pageUrl
        ? { id: targetTab.id, title: targetTab.title || pageUrl, url: pageUrl }
        : undefined,
    matchedToolIds: pageUrl ? tools.filter((tool) => matchesBrowserTool(tool.definition, pageUrl)).map((tool) => tool.id) : []
  };
}

export async function runStoredBrowserTool(input: {
  toolId: string;
  parameters: Record<string, unknown>;
  tabId?: number;
  userInitiated?: boolean;
}): Promise<BrowserToolRunResult> {
  const tool = await getStoredBrowserTool(input.toolId);
  if (!tool) throw new Error(`没有找到 Browser Tool：${input.toolId}`);
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
  if (!tool) throw new Error(`没有找到 Browser Tool：${input.toolId}`);
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
  await clearBatchRunState();
  clearControlRequest();
  const state: BatchRunState = {
    runId: `browser_tool_batch_${createBackgroundRunId()}`,
    toolId: definition.id,
    toolName: definition.name,
    keywords,
    nextIndex: 0,
    completedKeywords: 0,
    parameters,
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

/** 从暂停状态恢复批量运行；由 Trail 界面的“继续”触发。 */
export async function resumeBrowserToolBatch(input: { tabId?: number; userInitiated?: boolean }): Promise<BrowserToolRunResult> {
  const state = await getBatchRunState();
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
  return getBatchRunState();
}

export function pauseBrowserToolBatch(): { requested: boolean } {
  return requestPauseBatchRun();
}

/** 停止批量运行：运行中在下一个输入边界收尾；已暂停时立即以现有数据收尾。 */
export async function stopBrowserToolBatch(): Promise<{ requested: boolean; finalized: boolean }> {
  const state = await getBatchRunState();
  if (!state) return { requested: false, finalized: false };
  if (state.status === "running") {
    requestStopBatchRun();
    return { requested: true, finalized: false };
  }
  if (state.status !== "paused") return { requested: false, finalized: false };
  const tool = await getStoredBrowserTool(state.toolId);
  if (!tool) throw new Error(`没有找到 Browser Tool：${state.toolId}`);
  const definition = parseBrowserToolYaml(tool.yaml);
  await finalizeBatchRun(definition, { ...state, status: "stopped" }, "partial", `已手动停止：完成 ${state.completedKeywords}/${state.keywords.length} 个输入。`);
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
  let retriedIndex = -1;
  const runStartedAt = Date.now();
  logInfo("batch", "batch.start", "批量运行开始", { toolId: definition.id, runId: initial.runId, total: initial.keywords.length, fromIndex: initial.nextIndex });

  const heartbeat = setInterval(() => {
    state = { ...state, updatedAt: Date.now() };
    void saveBatchRunState(state).catch(() => undefined);
  }, 30_000);

  try {
    while (state.nextIndex < state.keywords.length) {
      const control = consumeControlRequest();
      if (control.stop) {
        logInfo("batch", "batch.control", "收到停止请求，在当前输入边界收尾", { completed: state.completedKeywords, total: state.keywords.length });
        return await finalizeBatchRun(definition, { ...state, status: "stopped" }, "partial",
          `已手动停止：完成 ${state.completedKeywords}/${state.keywords.length} 个输入。`, warnings);
      }
      if (control.pause) {
        logInfo("batch", "batch.control", "收到暂停请求，在当前输入边界挂起", { completed: state.completedKeywords, total: state.keywords.length });
        return await finalizeBatchRun(definition, { ...state, status: "paused" }, "paused",
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
        const runParameters = navigation.type === "fixed_url"
          ? { ...state.parameters, [navigation.input_parameter]: keyword }
          : state.parameters;
        await navigateTab(tabId, nextUrl);
        const readyTab = await chrome.tabs.get(tabId);
        const result = await executeBrowserToolOnTab(definition, runParameters, readyTab, progressId);

        if (result.status === "paused") {
          // 登录墙/验证码：保持游标不变，处理后可从该输入继续。
          logWarn("batch", "batch.paused", "需要人工处理，运行转暂停", { keyword, detail: result.error || "登录或验证码" });
          warnings.push(`[${keyword}] 需要人工处理：${result.error || "登录或验证码"}`);
          const pausedState = { ...state, status: "paused" as const, updatedAt: Date.now(), lastPageUrl: result.pageUrl, lastPageTitle: result.pageTitle };
          await saveBatchRunState(pausedState);
          return await finalizeBatchRun(definition, pausedState, "paused",
            `[${keyword}] 需要人工处理，运行已暂停；处理后点“继续”将从这个输入重试。`, warnings);
        }

        state = {
          ...advanceBatchRun(state, keyword, result.data),
          lastPageUrl: result.pageUrl,
          lastPageTitle: result.pageTitle
        };
        warnings.push(...result.warnings.map((warning) => `[${keyword}] ${warning}`));
        if (result.status !== "completed") {
          const message = result.error || "提取未完整完成";
          if (retriedIndex !== index && isTransientBatchError(message)) {
            retriedIndex = index;
            logWarn("batch", "keyword.retry", "瞬时错误，5 秒后重试当前输入", { keyword, error: message });
            warnings.push(`[${keyword}] ${message}；5 秒后重试一次。`);
            await sleep(5_000);
            continue;
          }
          failed = true;
          warnings.push(`[${keyword}] ${message}`);
          break;
        }
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
        if (retriedIndex !== index && isTransientBatchError(message)) {
          retriedIndex = index;
          logWarn("batch", "keyword.retry", "瞬时异常，5 秒后重试当前输入", { keyword, error: message });
          warnings.push(`[${keyword}] ${message}；5 秒后重试一次。`);
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
  await clearBatchRunState();
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
    await clearBatchRunState();
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

  const result = await executeBrowserToolOnTab(definition, input.parameters, tab);
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
  const response = await sendToolMessageWithRetry(tab.id, message);
  if (response && "error" in response && !("status" in response)) throw new Error(response.error);
  return response as BrowserToolRunResult;
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
