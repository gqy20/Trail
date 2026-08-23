import type {
  LiteratureDownloadItemInput,
  LiteratureDownloadItemResult,
  LiteratureDownloadProgress,
  LiteratureDownloadRunResult,
  LiteratureResourceResolution,
  ResolveLiteratureResourceMessage,
  TriggerLiteratureDownloadMessage
} from "../literature-queue/types";

const MAX_ITEMS = 250;
const MAX_CONCURRENCY = 4;

type RunControl = {
  paused: boolean;
  concurrency: number;
  completed: number;
  total: number;
  active: number;
  succeeded: number;
  needsUser: number;
  failed: number;
  currentTitle?: string;
  resumeWaiters: Array<() => void>;
};

let activeRun: RunControl | undefined;

export async function downloadLiteratureQueue(input: {
  items: LiteratureDownloadItemInput[];
  concurrency?: number;
  userInitiated?: boolean;
}): Promise<LiteratureDownloadRunResult> {
  if (input.userInitiated !== true) throw new Error("文献下载必须由用户主动启动。");
  if (activeRun) throw new Error("已有文献下载任务正在运行。");
  const items = normalizeItems(input.items);
  if (items.length === 0) throw new Error("队列中没有可处理的文献。");
  if (items.length > MAX_ITEMS) throw new Error(`一次最多处理 ${MAX_ITEMS} 篇文献。`);

  const concurrency = Math.max(1, Math.min(MAX_CONCURRENCY, Math.round(input.concurrency || 2)));
  const startedAt = Date.now();
  const results = new Array<LiteratureDownloadItemResult>(items.length);
  const control: RunControl = {
    paused: false,
    concurrency,
    completed: 0,
    total: items.length,
    active: 0,
    succeeded: 0,
    needsUser: 0,
    failed: 0,
    resumeWaiters: []
  };
  activeRun = control;
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      await waitUntilResumed(control);
      if (nextIndex >= items.length) return;
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      control.active += 1;
      control.currentTitle = item.title;
      emitProgress(control);
      let result: LiteratureDownloadItemResult;
      try {
        result = await processItem(item);
      } catch (error) {
        result = { id: item.id, status: "failed", error: error instanceof Error ? error.message : "下载失败。" };
      }
      results[index] = result;
      control.active -= 1;
      control.completed += 1;
      if (result.status === "completed") control.succeeded += 1;
      else if (result.status === "needs_user" || result.status === "needs_search") control.needsUser += 1;
      else control.failed += 1;
      emitProgress(control);
    }
  }

  try {
    emitProgress(control);
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
    return { startedAt, finishedAt: Date.now(), items: results };
  } finally {
    releaseResumeWaiters(control);
    if (activeRun === control) activeRun = undefined;
  }
}

export function pauseLiteratureDownload(): { paused: boolean } {
  if (!activeRun) return { paused: false };
  activeRun.paused = true;
  emitProgress(activeRun);
  return { paused: true };
}

export function resumeLiteratureDownload(): { paused: boolean } {
  if (!activeRun) return { paused: false };
  activeRun.paused = false;
  releaseResumeWaiters(activeRun);
  emitProgress(activeRun);
  return { paused: false };
}

async function processItem(item: LiteratureDownloadItemInput): Promise<LiteratureDownloadItemResult> {
  const candidates = [...new Set([
    item.downloadUrl,
    item.pdfUrl,
    item.doi ? `https://doi.org/${item.doi}` : undefined
  ].filter(Boolean))] as string[];
  if (candidates.length === 0) {
    return { id: item.id, status: "needs_search", error: "缺少 DOI 和全文链接，需要按题名检索。" };
  }

  const errors: string[] = [];
  let lastResolverUrl: string | undefined;
  for (const candidate of candidates) {
    try {
      const result = await resolveAndDownload(candidate, item.title);
      lastResolverUrl = result.resolverUrl;
      if (result.blocker) {
        return { id: item.id, status: "needs_user", error: result.blocker, resolverUrl: result.resolverUrl };
      }
      if (!result.download) {
        errors.push(`${hostLabel(candidate)}：没有发现 PDF`);
        continue;
      }
      if (!isPdfDownload(result.download, result.resourceUrl || candidate)) {
        await discardInvalidDownload(result.download.id);
        errors.push(`${hostLabel(candidate)}：响应是网页而不是 PDF`);
        continue;
      }
      return {
        id: item.id,
        status: "completed",
        filename: result.download.filename,
        resolverUrl: result.resolverUrl
      };
    } catch (error) {
      errors.push(`${hostLabel(candidate)}：${error instanceof Error ? error.message : "下载失败"}`);
    }
  }

  return {
    id: item.id,
    status: "needs_search",
    error: errors.join("；").slice(0, 1000) || "没有找到可下载的 PDF。",
    resolverUrl: buildFallbackSearchUrl(item.title, item.doi) || lastResolverUrl || candidates[0]
  };
}

async function resolveAndDownload(rawUrl: string, title: string): Promise<{
  download?: chrome.downloads.DownloadItem;
  resourceUrl?: string;
  resolverUrl?: string;
  blocker?: string;
}> {
  const initialUrl = assertHttpUrl(rawUrl);
  const tab = await chrome.tabs.create({ url: initialUrl, active: false });
  if (tab.id === undefined) throw new Error("无法创建解析标签页。");
  try {
    for (let hop = 0; hop < 4; hop += 1) {
      await waitForTabComplete(tab.id);
      const currentTab = await chrome.tabs.get(tab.id);
      const currentUrl = currentTab.url ? assertHttpUrl(currentTab.url) : initialUrl;
      let resolution: LiteratureResourceResolution;
      try {
        resolution = await sendResolveMessage(tab.id);
      } catch (error) {
        if (!looksLikePdfUrl(currentUrl)) throw error;
        const download = await startAndWaitForDownload(currentUrl, title);
        return { download, resourceUrl: currentUrl, resolverUrl: currentUrl };
      }
      if (resolution.blocker) return { blocker: resolution.blocker, resolverUrl: currentUrl };
      if (!resolution.resourceUrl) return { resolverUrl: currentUrl };
      const resourceUrl = assertHttpUrl(resolution.resourceUrl);
      if (resolution.action === "navigate") {
        await navigateTab(tab.id, resourceUrl);
        continue;
      }

      const download = await triggerDownloadFromPage(tab.id, resourceUrl, title);
      return { download, resourceUrl, resolverUrl: currentUrl };
    }
    return { resolverUrl: (await chrome.tabs.get(tab.id)).url };
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => undefined);
  }
}

async function triggerDownloadFromPage(tabId: number, resourceUrl: string, title: string): Promise<chrome.downloads.DownloadItem> {
  const filename = `${safeFilename(title)}.pdf`;
  const startedDownload = waitForDownloadStart(resourceUrl, filename, 25_000);
  try {
    const response = await sendContentMessage<{ triggered?: boolean; error?: string }>(tabId, {
      type: "TRIGGER_LITERATURE_DOWNLOAD",
      resourceUrl,
      filename
    } satisfies TriggerLiteratureDownloadMessage);
    if (response.error) throw new Error(response.error);
  } catch (error) {
    void startedDownload.catch(() => undefined);
    throw error;
  }
  const created = await startedDownload;
  return waitForDownloadComplete(created.id, 10 * 60_000);
}

async function sendResolveMessage(tabId: number): Promise<LiteratureResourceResolution> {
  return sendContentMessage<LiteratureResourceResolution>(tabId, { type: "RESOLVE_LITERATURE_RESOURCE" } satisfies ResolveLiteratureResourceMessage);
}

async function sendContentMessage<T>(tabId: number, message: ResolveLiteratureResourceMessage | TriggerLiteratureDownloadMessage): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await chrome.tabs.sendMessage(tabId, message) as T;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法读取全文页面。");
}

async function startAndWaitForDownload(resourceUrl: string, title: string): Promise<chrome.downloads.DownloadItem> {
  const downloadId = await chrome.downloads.download({
    url: assertHttpUrl(resourceUrl),
    filename: `Trail-Literature/${safeFilename(title)}.pdf`,
    conflictAction: "uniquify",
    saveAs: false
  });
  return waitForDownloadComplete(downloadId, 10 * 60_000);
}

function waitForDownloadStart(resourceUrl: string, filename: string, timeoutMs: number): Promise<chrome.downloads.DownloadItem> {
  const expectedHost = new URL(resourceUrl).hostname;
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => finish(undefined, new Error("页面点击后没有检测到文件下载。")), timeoutMs);
    const listener = (item: chrome.downloads.DownloadItem) => {
      const urls = [item.url, item.finalUrl].filter(Boolean) as string[];
      if (urls.some((url) => safeHostname(url) === expectedHost)) finish(item);
    };
    const filenameListener = (item: chrome.downloads.DownloadItem, suggest: (suggestion?: chrome.downloads.FilenameSuggestion) => void) => {
      if (!matchesDownloadResource(item, resourceUrl)) return;
      suggest({ filename: `Trail-Literature/${filename}`, conflictAction: "uniquify" });
    };
    const finish = (item?: chrome.downloads.DownloadItem, error?: Error) => {
      globalThis.clearTimeout(timeout);
      chrome.downloads.onCreated.removeListener(listener);
      if (error) chrome.downloads.onDeterminingFilename.removeListener(filenameListener);
      else globalThis.setTimeout(() => chrome.downloads.onDeterminingFilename.removeListener(filenameListener), 5_000);
      error ? reject(error) : resolve(item!);
    };
    chrome.downloads.onCreated.addListener(listener);
    chrome.downloads.onDeterminingFilename.addListener(filenameListener);
  });
}

function waitForDownloadComplete(downloadId: number, timeoutMs: number): Promise<chrome.downloads.DownloadItem> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => finish(undefined, new Error("等待 PDF 下载完成超时。")), timeoutMs);
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

function waitForTabComplete(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => finish(new Error("等待全文页面加载超时。")), 45_000);
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const finish = (error?: Error) => {
      globalThis.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.get(tabId).then((tab) => tab.status === "complete" ? finish() : undefined).catch((error: unknown) => finish(error instanceof Error ? error : new Error("无法读取全文标签页。")));
  });
}

function navigateTab(tabId: number, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => finish(new Error("等待 PDF 阅读器加载超时。")), 45_000);
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    const finish = (error?: Error) => {
      globalThis.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
    void chrome.tabs.update(tabId, { url }).catch((error: unknown) => finish(error instanceof Error ? error : new Error("无法打开 PDF 阅读器。")));
  });
}

function normalizeItems(items: LiteratureDownloadItemInput[]): LiteratureDownloadItemInput[] {
  const seen = new Set<string>();
  return items.flatMap((item) => {
    const title = item.title.trim().slice(0, 500);
    if (!item.id || !title || seen.has(item.id)) return [];
    seen.add(item.id);
    return [{
      id: item.id,
      title,
      doi: item.doi?.trim(),
      pdfUrl: normalizeOptionalUrl(item.pdfUrl),
      downloadUrl: normalizeOptionalUrl(item.downloadUrl)
    }];
  });
}

function normalizeOptionalUrl(value?: string): string | undefined {
  return value ? assertHttpUrl(value) : undefined;
}

function assertHttpUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许 HTTP(S) 全文链接。");
  return url.href;
}

function looksLikePdfUrl(value: string): boolean {
  const url = new URL(value);
  return /\.pdf(?:$|[?#])/i.test(url.href)
    || /\/(?:pdf|pdfdirect|downloadpdf|watermark-pdf)(?:$|[/?#])/i.test(url.pathname)
    || /[?&](?:download|type)=pdf(?:&|$)/i.test(url.search);
}

function isPdfDownload(item: chrome.downloads.DownloadItem, resourceUrl: string): boolean {
  const mime = (item.mime || "").toLowerCase();
  const filename = item.filename.toLowerCase();
  if (mime.includes("html") || mime.startsWith("text/") || /\.html?$/.test(filename)) return false;
  if (mime.includes("pdf")) return true;
  if (/\.pdf$/.test(filename) && (item.bytesReceived || item.fileSize || 0) >= 8_192) return true;
  return /octet-stream/.test(mime) && looksLikePdfUrl(resourceUrl) && (item.bytesReceived || item.fileSize || 0) >= 8_192;
}

async function discardInvalidDownload(downloadId: number): Promise<void> {
  await chrome.downloads.removeFile(downloadId).catch(() => undefined);
  await chrome.downloads.erase({ id: downloadId }).catch(() => undefined);
}

function safeFilename(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "literature";
}

function hostLabel(value: string): string {
  try { return new URL(value).hostname; } catch { return "链接"; }
}

function safeHostname(value: string): string | undefined {
  try { return new URL(value).hostname; } catch { return undefined; }
}

function buildFallbackSearchUrl(title: string, doi?: string): string {
  const plainTitle = title.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const query = [doi ? `"${doi}"` : "", `"${plainTitle}"`, "PDF"].filter(Boolean).join(" ");
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function matchesDownloadResource(item: chrome.downloads.DownloadItem, resourceUrl: string): boolean {
  try {
    const expected = new URL(resourceUrl);
    return [item.url, item.finalUrl].filter(Boolean).some((rawUrl) => {
      const actual = new URL(rawUrl!);
      return actual.hostname === expected.hostname && actual.pathname === expected.pathname;
    });
  } catch {
    return false;
  }
}

function emitProgress(control: RunControl): void {
  void chrome.runtime.sendMessage({
    type: "LITERATURE_DOWNLOAD_PROGRESS",
    state: control.paused ? "paused" : "running",
    completed: control.completed,
    total: control.total,
    active: control.active,
    succeeded: control.succeeded,
    needsUser: control.needsUser,
    failed: control.failed,
    concurrency: control.concurrency,
    currentTitle: control.currentTitle
  } satisfies LiteratureDownloadProgress).catch(() => undefined);
}

function waitUntilResumed(control: RunControl): Promise<void> {
  if (!control.paused) return Promise.resolve();
  return new Promise((resolve) => control.resumeWaiters.push(resolve));
}

function releaseResumeWaiters(control: RunControl): void {
  for (const resolve of control.resumeWaiters.splice(0)) resolve();
}

function sleep(duration: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, duration));
}
