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
import { importBundledBrowserTools } from "../browser-tools/bundled";
import { parseBrowserToolYaml } from "../browser-tools/loader";
import { matchesBrowserTool } from "../browser-tools/matcher";
import {
  deleteStoredBrowserTool,
  getBrowserToolRuns,
  getStoredBrowserTool,
  getStoredBrowserTools,
  saveBrowserToolRun,
  saveStoredBrowserTool
} from "../browser-tools/storage";

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

  const startedAt = Date.now();
  const progressId = `browser_tool_progress_${createBackgroundRunId()}`;
  const data: BrowserToolRunResult["data"] = {};
  const warnings: string[] = [];
  const nativeExports: NonNullable<BrowserToolRunResult["nativeExports"]> = [];
  let completedKeywords = 0;
  let lastPageUrl = tab.url;
  let lastPageTitle = tab.title || tab.url;
  let failed = false;

  for (const [index, keyword] of keywords.entries()) {
    try {
      emitProgress({
        type: "BROWSER_TOOL_PROGRESS_UPDATE",
        progressId,
        toolId: definition.id,
        scope: "keyword",
        label: "正在处理检索式",
        itemLabel: "条",
        current: index + 1,
        total: keywords.length,
        recordCount: Object.values(data).reduce((total, records) => total + records.length, 0)
      });
      const currentTab = await chrome.tabs.get(tab.id);
      if (!currentTab.url) throw new Error("目标标签页没有有效 URL。");
      const navigation = definition.batch.navigation;
      const nextUrl = navigation.type === "query_parameter"
        ? buildBatchUrl(currentTab.url, navigation.parameter, keyword)
        : navigation.url;
      if (!matchesBrowserTool(definition, nextUrl)) throw new Error(`工具 ${definition.id} 的批量导航地址不在适用范围内。`);
      const runParameters = navigation.type === "fixed_url"
        ? { ...input.parameters, [navigation.input_parameter]: keyword }
        : input.parameters;
      await navigateTab(tab.id, nextUrl);
      const readyTab = await chrome.tabs.get(tab.id);
      const result = await executeBrowserToolOnTab(definition, runParameters, readyTab, progressId);
      lastPageUrl = result.pageUrl;
      lastPageTitle = result.pageTitle;

      for (const [collection, records] of Object.entries(result.data)) {
        const target = (data[collection] ||= []);
        target.push(...records.map((record) => ({ _query: keyword, ...record })));
      }
      warnings.push(...result.warnings.map((warning) => `[${keyword}] ${warning}`));
      if (result.status !== "completed") {
        failed = true;
        warnings.push(`[${keyword}] ${result.error || (result.status === "paused" ? "需要人工处理登录或验证码" : "提取未完整完成")}`);
        break;
      }
      if (input.nativeExport) {
        const exportDefinition = definition.native_exports?.find((item) => item.id === input.nativeExport?.definitionId);
        if (!exportDefinition) throw new Error("工具没有对应的原生导出定义。");
        const exportSummary = await runNativeExportBatches(tab.id, definition.id, exportDefinition, input.nativeExport.maxRecords, keyword, progressId);
        nativeExports.push(exportSummary);
        if (exportSummary.error) warnings.push(`[${keyword}] 原生导出部分完成：${exportSummary.error}`);
      }
      completedKeywords += 1;
    } catch (error) {
      failed = true;
      warnings.push(`[${keyword}] ${error instanceof Error ? error.message : "批量检索失败"}`);
      break;
    }

    if (index < keywords.length - 1) await sleep(definition.batch.delay_between_keywords_ms || 0);
  }

  const status: BrowserToolRunResult["status"] = failed
    ? completedKeywords > 0
      ? "partial"
      : "failed"
    : "completed";
  const result: BrowserToolRunResult = {
    toolId: definition.id,
    runId: `browser_tool_batch_${createBackgroundRunId()}`,
    pageUrl: lastPageUrl,
    pageTitle: lastPageTitle,
    startedAt,
    finishedAt: Date.now(),
    status,
    data,
    warnings,
    nativeExports: nativeExports.length > 0 ? nativeExports : undefined,
    error: failed ? `已完成 ${completedKeywords}/${keywords.length} 个检索词。` : undefined
  };
  return persistRunResult(result, `${definition.name} · 批量`);
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
