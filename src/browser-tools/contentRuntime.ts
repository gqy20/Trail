import type {
  BrowserToolDownloadResolution,
  BrowserToolRunResult,
  ClickBrowserToolDownloadMessage,
  ExecuteBrowserToolMessage,
  GetBrowserToolNativeExportCountMessage,
  RunBrowserToolNativeExportBatchMessage,
  ResolveBrowserToolDownloadMessage
} from "./contracts";
import type {
  LiteratureResourceResolution,
  ResolveLiteratureResourceMessage,
  TriggerLiteratureDownloadMessage
} from "../literature-queue/types";
import { executeBrowserTool, extractPageFields } from "./executor";
import type { BrowserToolFieldDefinition } from "./contracts";

export function installBrowserToolContentRuntime(): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (isScrollMessage(message)) {
      try {
        window.scrollTo({ top: message.position === 'top' ? 0 : document.documentElement.scrollHeight, behavior: 'instant' as ScrollBehavior });
        sendResponse({ scrolled: true });
      } catch (error) {
        sendResponse({ error: error instanceof Error ? error.message : '滚动失败。' });
      }
      return undefined;
    }
    if (isHumanizedClickMessage(message)) {
      humanizedClick(message.selector, message.timeoutMs)
        .then(sendResponse)
        .catch((error: unknown) => sendResponse({ error: error instanceof Error ? error.message : '点击失败。' }));
      return true;
    }
    if (isExtractDetailsMessage(message)) {
      extractDetailsOnPage(message)
        .then(sendResponse)
        .catch((error: unknown) => sendResponse({ error: error instanceof Error ? error.message : "无法提取详情字段。" }));
      return true;
    }
    if (isResolveLiteratureResourceMessage(message)) {
      try {
        sendResponse(resolveLiteratureResource());
      } catch (error) {
        sendResponse({ blocker: error instanceof Error ? error.message : "无法解析全文入口。" } satisfies LiteratureResourceResolution);
      }
      return undefined;
    }

    if (isTriggerLiteratureDownloadMessage(message)) {
      triggerLiteratureDownload(message)
        .then(() => sendResponse({ triggered: true }))
        .catch((error: unknown) => sendResponse({ error: error instanceof Error ? error.message : "无法启动 PDF 下载。" }));
      return true;
    }

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

function resolveLiteratureResource(): LiteratureResourceResolution {
  const blocker = findLiteratureBlocker();
  if (blocker) return { blocker };
  if (document.contentType.toLowerCase().includes("application/pdf") || /\.pdf(?:$|[?#])/i.test(location.href)) {
    return { resourceUrl: location.href, action: "download" };
  }

  const host = location.hostname.toLowerCase();
  if (host.endsWith("journals.ashs.org")) {
    const viewer = document.querySelector<HTMLIFrameElement>("iframe[title='PDF Viewer'][src*='pdfUrl=']");
    if (viewer?.src) {
      const viewerUrl = new URL(viewer.src, location.href);
      const pdfPath = viewerUrl.searchParams.get("pdfUrl");
      if (pdfPath) return { resourceUrl: new URL(pdfPath, location.href).href, action: "download" };
    }
  }

  if (host.endsWith("onlinelibrary.wiley.com")) {
    const direct = findHttpUrl("a[href*='/doi/pdfdirect/']");
    if (direct) return { resourceUrl: direct, action: "download" };
    const reader = findHttpUrl("a[href*='/doi/epdf/']");
    if (reader) return { resourceUrl: reader, action: "navigate" };
  }

  if (host.endsWith("agronomy-journal.org") || host.endsWith("edpsciences.org")) {
    const edpPdf = findHttpUrl("a[href*='/articles/'][href*='/pdf/'][href$='.pdf']");
    if (edpPdf) return { resourceUrl: edpPdf, action: "download" };
  }

  const selectors = [
    "meta[name='citation_pdf_url']",
    "meta[name='wkhealth_pdf_url']",
    "meta[property='og:pdf']",
    "link[type='application/pdf']",
    "embed[type='application/pdf']",
    "iframe[src*='.pdf']",
    "a[type='application/pdf']",
    "a[href$='.pdf']",
    "a[href*='.pdf?']",
    "a[href*='/pdfdirect/']",
    "a[href*='/pdf/']",
    "a[href*='downloadPdf']",
    "a[href*='downloadpdf']"
  ];
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      const rawUrl = element.getAttribute("content") || element.getAttribute("href") || element.getAttribute("src");
      if (!rawUrl) continue;
      const url = new URL(rawUrl, location.href);
      if (url.protocol === "http:" || url.protocol === "https:") return { resourceUrl: url.href, action: "download" };
    }
  }
  return {};
}

async function triggerLiteratureDownload(message: TriggerLiteratureDownloadMessage): Promise<void> {
  const url = new URL(message.resourceUrl, location.href);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("只允许下载 HTTP(S) PDF。");
  const response = await fetch(url.href, {
    credentials: "include",
    headers: { Accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.1" },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`全文服务器返回 HTTP ${response.status}。`);
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("html") || contentType.startsWith("text/")) {
    throw new Error(`全文入口返回 ${contentType || "网页内容"}，不是 PDF。`);
  }
  const blob = await response.blob();
  const signature = new TextDecoder("latin1").decode(await blob.slice(0, 1_024).arrayBuffer());
  if (!signature.includes("%PDF-")) throw new Error("全文响应缺少 PDF 文件头。");
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = message.filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  window.setTimeout(() => anchor.remove(), 1_000);
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}

function findHttpUrl(selector: string): string | undefined {
  const element = document.querySelector(selector);
  const rawUrl = element?.getAttribute("href") || element?.getAttribute("src");
  if (!rawUrl) return undefined;
  const url = new URL(rawUrl, location.href);
  return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
}

function findLiteratureBlocker(): string | undefined {
  const pageSignal = `${document.title} ${(document.body?.innerText || "").slice(0, 1_500)}`.toLowerCase();
  if (/just a moment|please wait|请稍候|verify you are human|checking your browser|security verification/.test(pageSignal)) {
    return "页面正在进行安全验证，请手动完成后重试。";
  }
  const selectors = [
    "iframe[src*='captcha']",
    "iframe[src*='hcaptcha']",
    "iframe[src*='recaptcha']",
    "#tCaptchaDyMainWrap",
    "[class*='captcha']",
    "[id*='captcha']"
  ];
  const blocker = selectors.flatMap((selector) => [...document.querySelectorAll(selector)]).find((element) => element instanceof HTMLElement && isVisible(element));
  if (blocker) return "页面需要安全验证，请打开该文献页面完成验证后重试。";
  return undefined;
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

function isResolveLiteratureResourceMessage(value: unknown): value is ResolveLiteratureResourceMessage {  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "RESOLVE_LITERATURE_RESOURCE");
}

function isTriggerLiteratureDownloadMessage(value: unknown): value is TriggerLiteratureDownloadMessage {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "TRIGGER_LITERATURE_DOWNLOAD");
}

type ExtractDetailsMessage = {
  type: "EXTRACT_BROWSER_TOOL_DETAILS";
  fields: Record<string, BrowserToolFieldDefinition>;
  waitFor?: string;
  timeoutMs?: number;
  blockers?: Array<{ selector?: string; reason: string }>;
};

/** 详情页提取：先等锚点元素，再检查阻断器，最后按声明取字段。 */
async function extractDetailsOnPage(message: ExtractDetailsMessage): Promise<{ record?: Record<string, unknown>; blocker?: string }> {
  if (message.waitFor) {
    const deadline = Date.now() + (message.timeoutMs || 12_000);
    while (Date.now() < deadline && !document.querySelector(message.waitFor)) {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
    }
    if (!document.querySelector(message.waitFor)) return { blocker: "详情页未出现预期内容，可能需要登录或被风控拦截。" };
  }
  for (const blocker of message.blockers || []) {
    if (blocker.selector && document.querySelector(blocker.selector)) return { blocker: blocker.reason };
  }
  return { record: extractPageFields(message.fields) };
}

function isExtractDetailsMessage(value: unknown): value is ExtractDetailsMessage {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "EXTRACT_BROWSER_TOOL_DETAILS");
}

type HumanizedClickMessage = {
  type: "BROWSER_TOOL_HUMANIZED_CLICK";
  selector: string;
  timeoutMs?: number;
};

/**
 * 人性化点击：先沿抖动路径派发 mousemove 预热，再 mousedown/mouseup 点击。
 * content script 事件 isTrusted=false 是平台限制（真事件需 CDP），但坐标
 * 轨迹与随之而来的 SPA 跳转足以让流量模式接近真人。
 */
async function humanizedClick(selector: string, timeoutMs = 5000): Promise<{ clicked: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let element = document.querySelector(selector);
  while (!element && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    element = document.querySelector(selector);
  }
  if (!(element instanceof HTMLElement)) return { clicked: false };
  element.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
  await new Promise((resolve) => window.setTimeout(resolve, 120));
  const rect = element.getBoundingClientRect();
  const targetX = rect.left + rect.width / 2 + (Math.random() - 0.5) * Math.min(rect.width * 0.5, 30);
  const targetY = rect.top + rect.height / 2 + (Math.random() - 0.5) * Math.min(rect.height * 0.5, 20);
  const startX = targetX + (Math.random() - 0.5) * 160;
  const startY = targetY - 40 - Math.random() * 120;
  const steps = 6 + Math.floor(Math.random() * 4);
  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps;
    const eased = progress * progress * (3 - 2 * progress);
    const x = startX + (targetX - startX) * eased + (Math.random() - 0.5) * 6;
    const y = startY + (targetY - startY) * eased + (Math.random() - 0.5) * 6;
    element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window }));
    await new Promise((resolve) => window.setTimeout(resolve, 25 + Math.random() * 45));
  }
  for (const type of ["mouseover", "mousedown", "mouseup", "click"] as const) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: targetX, clientY: targetY, button: 0, view: window }));
  }
  return { clicked: true };
}

function isHumanizedClickMessage(value: unknown): value is HumanizedClickMessage {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "BROWSER_TOOL_HUMANIZED_CLICK");
}

type ScrollMessage = {
  type: "BROWSER_TOOL_SCROLL";
  position: "top" | "bottom";
};

function isScrollMessage(value: unknown): value is ScrollMessage {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "BROWSER_TOOL_SCROLL");
}
