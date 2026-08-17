import type {
  BrowserToolDownloadItemInput,
  BrowserToolDownloadItemResult,
  BrowserToolDownloadDefinition,
  BrowserToolDownloadResolution,
  BrowserToolDownloadRunResult,
  ClickBrowserToolDownloadMessage,
  ResolveBrowserToolDownloadMessage
} from "../browser-tools/contracts";
import { getStoredBrowserTool } from "../browser-tools/storage";

export async function downloadBrowserToolItems(input: {
  toolId: string;
  downloadDefinitionId: string;
  format: string;
  items: BrowserToolDownloadItemInput[];
  userInitiated?: boolean;
}): Promise<BrowserToolDownloadRunResult> {
  if (input.userInitiated !== true) throw new Error("下载必须由用户主动启动。");
  const tool = await getStoredBrowserTool(input.toolId);
  if (!tool) throw new Error(`没有找到 Browser Tool：${input.toolId}`);
  const definition = tool.definition.downloads?.find((item) => item.id === input.downloadDefinitionId);
  if (!definition) throw new Error("该工具没有对应的下载定义。");
  const format = definition.formats[input.format];
  if (!format) throw new Error("该工具不支持选择的下载格式。");
  const maxItems = definition.max_items || 20;
  const items = normalizeItems(input.items);
  if (items.length === 0) throw new Error("至少选择一条可下载记录。");
  if (items.length > maxItems) throw new Error(`一次最多下载 ${maxItems} 条记录。`);

  const startedAt = Date.now();
  const results: BrowserToolDownloadItemResult[] = items.map((item) => ({ ...item, format: input.format, status: "pending" }));
  let workerTabId: number | undefined;
  let paused = false;

  try {
    const firstUrl = assertAllowedUrl(items[0].detailUrl, tool.definition.match.domains);
    const workerTab = await chrome.tabs.create({ url: firstUrl, active: false });
    if (workerTab.id === undefined) throw new Error("无法创建下载工作标签页。");
    workerTabId = workerTab.id;

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      try {
        const detailUrl = assertAllowedUrl(item.detailUrl, tool.definition.match.domains);
        if (index > 0) await navigateTab(workerTabId, detailUrl);
        else await waitForTabComplete(workerTabId);

        const resolution = await resolveDownload(workerTabId, definition);
        if (resolution.blocker) {
          results[index] = { ...results[index], status: "needs_user", error: resolution.blocker.message };
          paused = true;
          await chrome.tabs.update(workerTabId, { active: true });
          break;
        }

        const resourceUrl = resolution.resources[input.format];
        if (!resourceUrl) {
          results[index] = { ...results[index], status: "unavailable", error: `详情页没有${format.label}资源。` };
          continue;
        }
        assertAllowedUrl(resourceUrl, definition.allowed_domains || tool.definition.match.domains);

        const startedDownload = waitForDownloadStart(resourceUrl, 20_000);
        let clickResponse: { clicked?: boolean; error?: string };
        try {
          clickResponse = await sendContentMessage(workerTabId, {
            type: "CLICK_BROWSER_TOOL_DOWNLOAD",
            selector: format.selector
          } satisfies ClickBrowserToolDownloadMessage);
          if (clickResponse.error) throw new Error(clickResponse.error);
        } catch (error) {
          void startedDownload.catch(() => undefined);
          throw error;
        }
        const download = await startedDownload;
        const completed = await waitForDownloadComplete(download.id, 10 * 60_000);
        results[index] = {
          ...results[index],
          status: "completed",
          downloadId: completed.id,
          filename: completed.filename
        };
      } catch (error) {
        results[index] = { ...results[index], status: "failed", error: error instanceof Error ? error.message : "下载失败。" };
      }

      if (definition.delay_ms && index < items.length - 1) await sleep(definition.delay_ms);
    }
  } finally {
    if (workerTabId !== undefined && !paused) await chrome.tabs.remove(workerTabId).catch(() => undefined);
  }

  const completedCount = results.filter((item) => item.status === "completed").length;
  const failedCount = results.filter((item) => item.status === "failed" || item.status === "unavailable").length;
  const status: BrowserToolDownloadRunResult["status"] = paused
    ? "paused"
    : completedCount === results.length
      ? "completed"
      : completedCount > 0
        ? "partial"
        : failedCount > 0
          ? "failed"
          : "partial";
  return {
    toolId: input.toolId,
    downloadDefinitionId: input.downloadDefinitionId,
    format: input.format,
    status,
    startedAt,
    finishedAt: Date.now(),
    items: results,
    workerTabId: paused ? workerTabId : undefined
  };
}

function normalizeItems(items: BrowserToolDownloadItemInput[]): BrowserToolDownloadItemInput[] {
  const seen = new Set<string>();
  return items.map((item) => ({ title: item.title.trim().slice(0, 500), detailUrl: item.detailUrl.trim() })).filter((item) => {
    if (!item.title || !item.detailUrl || seen.has(item.detailUrl)) return false;
    seen.add(item.detailUrl);
    return true;
  });
}

async function resolveDownload(tabId: number, definition: BrowserToolDownloadDefinition): Promise<BrowserToolDownloadResolution> {
  let lastResponse: BrowserToolDownloadResolution = { resources: {} };
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await sendContentMessage<BrowserToolDownloadResolution & { error?: string }>(tabId, {
      type: "RESOLVE_BROWSER_TOOL_DOWNLOAD",
      definition
    } satisfies ResolveBrowserToolDownloadMessage);
    if (response.error) throw new Error(response.error);
    lastResponse = response;
    if (response.blocker || Object.keys(response.resources).length > 0) return response;
    await sleep(500);
  }
  return lastResponse;
}

async function sendContentMessage<T>(tabId: number, message: ResolveBrowserToolDownloadMessage | ClickBrowserToolDownloadMessage): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message) as T;
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法连接下载工作页面。");
}

function waitForDownloadStart(resourceUrl: string, timeoutMs: number): Promise<chrome.downloads.DownloadItem> {
  const expectedHost = new URL(resourceUrl).hostname;
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => finish(undefined, new Error("点击后没有检测到文件下载。")), timeoutMs);
    const listener = (item: chrome.downloads.DownloadItem) => {
      try {
        if (new URL(item.url).hostname === expectedHost) finish(item);
      } catch {
        // Ignore unrelated malformed download URLs.
      }
    };
    const finish = (item?: chrome.downloads.DownloadItem, error?: Error) => {
      globalThis.clearTimeout(timeout);
      chrome.downloads.onCreated.removeListener(listener);
      error ? reject(error) : resolve(item!);
    };
    chrome.downloads.onCreated.addListener(listener);
  });
}

function waitForDownloadComplete(downloadId: number, timeoutMs: number): Promise<chrome.downloads.DownloadItem> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => finish(undefined, new Error("等待文件下载完成超时。")), timeoutMs);
    const listener = (delta: chrome.downloads.DownloadDelta) => {
      if (delta.id !== downloadId || !delta.state?.current) return;
      if (delta.state.current === "complete") void lookup().then((item) => finish(item), (error) => finish(undefined, error));
      if (delta.state.current === "interrupted") finish(undefined, new Error(delta.error?.current || "下载被中断。"));
    };
    const lookup = async () => {
      const [item] = await chrome.downloads.search({ id: downloadId });
      if (!item) throw new Error("找不到 Chrome 下载记录。");
      return item;
    };
    const finish = (item?: chrome.downloads.DownloadItem, error?: Error) => {
      globalThis.clearTimeout(timeout);
      chrome.downloads.onChanged.removeListener(listener);
      error ? reject(error) : resolve(item!);
    };
    chrome.downloads.onChanged.addListener(listener);
    void lookup().then((item) => {
      if (item.state === "complete") finish(item);
      if (item.state === "interrupted") finish(undefined, new Error(item.error || "下载被中断。"));
    }).catch(() => undefined);
  });
}

function assertAllowedUrl(rawUrl: string, patterns: string[]): string {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许 HTTP(S) 下载页面。");
  const allowed = patterns.some((pattern) => pattern.startsWith("*.")
    ? url.hostname === pattern.slice(2) || url.hostname.endsWith(`.${pattern.slice(2)}`)
    : url.hostname === pattern);
  if (!allowed) throw new Error(`下载地址域名不在工具白名单中：${url.hostname}`);
  return url.href;
}

function navigateTab(tabId: number, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => finish(new Error("等待详情页加载超时。")), 45_000);
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const finish = (error?: Error) => {
      globalThis.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.update(tabId, { url }).catch((error: unknown) => finish(error instanceof Error ? error : new Error("详情页导航失败。")));
  });
}

async function waitForTabComplete(tabId: number): Promise<void> {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === "complete") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => finish(new Error("等待详情页加载超时。")), 45_000);
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const finish = (error?: Error) => {
      globalThis.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(duration: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, duration));
}
