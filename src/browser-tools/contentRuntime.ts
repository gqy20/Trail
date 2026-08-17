import type {
  BrowserToolDownloadResolution,
  BrowserToolRunResult,
  ClickBrowserToolDownloadMessage,
  ExecuteBrowserToolMessage,
  ResolveBrowserToolDownloadMessage
} from "./contracts";
import { executeBrowserTool } from "./executor";

export function installBrowserToolContentRuntime(): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (isResolveDownloadMessage(message)) {
      try {
        sendResponse(resolveDownload(message));
      } catch (error) {
        sendResponse({ error: error instanceof Error ? error.message : "无法解析下载资源。" });
      }
      return undefined;
    }

    if (isClickDownloadMessage(message)) {
      try {
        const element = document.querySelector(message.selector);
        if (!(element instanceof HTMLAnchorElement)) throw new Error("没有找到可点击的下载链接。");
        element.click();
        sendResponse({ clicked: true });
      } catch (error) {
        sendResponse({ error: error instanceof Error ? error.message : "无法点击下载链接。" });
      }
      return undefined;
    }

    if (!isExecuteBrowserToolMessage(message)) return undefined;

    executeBrowserTool(message.definition, message.parameters, message.progressId)
      .then(sendResponse)
      .catch((error: unknown) => {
        const messageText = error instanceof Error ? error.message : "Browser Tool 执行失败。";
        sendResponse({ error: messageText } satisfies Partial<BrowserToolRunResult>);
      });

    return true;
  });
}

function resolveDownload(message: ResolveBrowserToolDownloadMessage): BrowserToolDownloadResolution {
  for (const blocker of message.definition.blockers || []) {
    const element = document.querySelector(blocker.selector);
    if (element instanceof HTMLElement && isVisible(element)) {
      return { blocker: { status: blocker.status, message: blocker.message }, resources: {} };
    }
  }

  const resources: Record<string, string> = {};
  for (const [formatId, format] of Object.entries(message.definition.formats)) {
    const element = document.querySelector(format.selector);
    if (!(element instanceof HTMLAnchorElement)) continue;
    const rawHref = element.getAttribute("href");
    if (!rawHref) continue;
    const url = new URL(rawHref, location.href);
    if (url.protocol === "http:" || url.protocol === "https:") resources[formatId] = url.href;
  }
  return { resources };
}

function isVisible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
}

function isExecuteBrowserToolMessage(value: unknown): value is ExecuteBrowserToolMessage {
  if (!value || typeof value !== "object") return false;
  return (value as { type?: unknown }).type === "EXECUTE_BROWSER_TOOL";
}

function isResolveDownloadMessage(value: unknown): value is ResolveBrowserToolDownloadMessage {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "RESOLVE_BROWSER_TOOL_DOWNLOAD");
}

function isClickDownloadMessage(value: unknown): value is ClickBrowserToolDownloadMessage {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "CLICK_BROWSER_TOOL_DOWNLOAD");
}
