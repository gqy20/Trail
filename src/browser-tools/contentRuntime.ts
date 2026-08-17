import type {
  BrowserToolDownloadResolution,
  BrowserToolRunResult,
  ClickBrowserToolDownloadMessage,
  ExecuteBrowserToolMessage,
  GetBrowserToolNativeExportCountMessage,
  RunBrowserToolNativeExportBatchMessage,
  ResolveBrowserToolDownloadMessage
} from "./contracts";
import { executeBrowserTool } from "./executor";

export function installBrowserToolContentRuntime(): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (isNativeExportCountMessage(message)) {
      try {
        const text = document.querySelector(message.definition.result_count_selector)?.textContent || "";
        const count = Number((text.match(/[\d,]+/)?.[0] || "0").replace(/,/g, ""));
        sendResponse({ totalRecords: Number.isFinite(count) ? count : 0 });
      } catch (error) {
        sendResponse({ error: error instanceof Error ? error.message : "无法读取结果数量。" });
      }
      return undefined;
    }

    if (isNativeExportBatchMessage(message)) {
      runNativeExportBatch(message)
        .then(() => sendResponse({ started: true }))
        .catch((error: unknown) => sendResponse({ error: error instanceof Error ? error.message : "无法启动原生导出。" }));
      return true;
    }
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

async function runNativeExportBatch(message: RunBrowserToolNativeExportBatchMessage): Promise<void> {
  const definition = message.definition;
  (document.querySelector(definition.menu_button_selector) as HTMLElement | null)?.click();
  const menuItem = await waitForTextElement("[role='menuitem']", definition.menu_item_text, 5_000);
  menuItem.click();
  const rangeRadio = await waitForSelector<HTMLInputElement>(definition.range_radio_selector, 5_000);
  rangeRadio.click();
  fillNativeInput(await waitForEnabledSelector<HTMLInputElement>(definition.start_input_selector, 3_000), String(message.from));
  fillNativeInput(await waitForEnabledSelector<HTMLInputElement>(definition.end_input_selector, 3_000), String(message.to));
  (await waitForSelector<HTMLElement>(definition.content_button_selector, 3_000)).click();
  (await waitForTextElement("[role='option']", definition.content_option_text, 3_000)).click();
  (await waitForEnabledSelector<HTMLButtonElement>(definition.submit_button_selector, 3_000)).click();
}

function fillNativeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitForSelector<T extends Element>(selector: string, timeoutMs: number): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const element = document.querySelector(selector);
    if (element) return element as T;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  throw new Error(`等待导出控件超时：${selector}`);
}

async function waitForTextElement(selector: string, text: string, timeoutMs: number): Promise<HTMLElement> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const element = [...document.querySelectorAll(selector)].find((item) => item.textContent?.trim() === text);
    if (element instanceof HTMLElement) return element;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  throw new Error(`等待导出选项超时：${text}`);
}

async function waitForEnabledSelector<T extends HTMLInputElement | HTMLButtonElement>(selector: string, timeoutMs: number): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const element = document.querySelector(selector);
    if ((element instanceof HTMLInputElement || element instanceof HTMLButtonElement) && !element.disabled) return element as T;
    await new Promise((resolve) => window.setTimeout(resolve, 100));
  }
  throw new Error(`等待可用导出控件超时：${selector}`);
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

function isNativeExportCountMessage(value: unknown): value is GetBrowserToolNativeExportCountMessage {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "GET_BROWSER_TOOL_NATIVE_EXPORT_COUNT");
}

function isNativeExportBatchMessage(value: unknown): value is RunBrowserToolNativeExportBatchMessage {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "RUN_BROWSER_TOOL_NATIVE_EXPORT_BATCH");
}
