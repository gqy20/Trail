import type { CopyInteractionPayload, LinkClickPayload, RuntimeMessage, TrailLinkKind } from "../shared/types";

const TOAST_ID = "trail-copy-toast";
const MAX_COPIED_TEXT_LENGTH = 1200;
const MAX_CONTEXT_TEXT_LENGTH = 420;
const MIN_COPIED_TEXT_LENGTH = 8;
const SELECTION_STABLE_DELAY = 800;
let toastTimer: number | undefined;
let selectionTimer: number | undefined;
let lastSelectionKey = "";

document.addEventListener("copy", () => {
  window.clearTimeout(selectionTimer);
  void handleCopy();
});

document.addEventListener(
  "click",
  (event) => {
    void handleLinkClick(event);
  },
  true
);

document.addEventListener("selectionchange", () => {
  window.clearTimeout(selectionTimer);
  selectionTimer = window.setTimeout(() => {
    void handleStableSelection();
  }, SELECTION_STABLE_DELAY);
});

async function handleCopy() {
  const payload = getSelectionPayload();
  if (!payload) return;

  const response = await chrome.runtime
    .sendMessage<RuntimeMessage, { recorded: boolean; eventId?: string; reason?: string }>({
      type: "RECORD_INTERACTION",
      payload
    })
    .catch(() => undefined);

  if (!response?.recorded || !response.eventId) return;

  const settings = await chrome.runtime
    .sendMessage<RuntimeMessage, { showToast: boolean }>({ type: "GET_INTERACTION_SETTINGS" })
    .catch(() => undefined);

  if (settings?.showToast !== false) {
    showToast(response.eventId);
  }
}

async function handleStableSelection() {
  const payload = getSelectionPayload();
  if (!payload) return;

  const selectionKey = `${payload.pageUrl}::${payload.selectedText}`;
  if (selectionKey === lastSelectionKey) return;
  lastSelectionKey = selectionKey;

  await chrome.runtime
    .sendMessage<RuntimeMessage, { recorded: boolean; eventId?: string; reason?: string }>({
      type: "RECORD_SELECTION",
      payload
    })
    .catch(() => undefined);
}

async function handleLinkClick(event: MouseEvent) {
  const target = event.target instanceof Element ? event.target : undefined;
  const anchor = target?.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return;

  const payload = getLinkClickPayload(anchor);
  if (!payload) return;

  await chrome.runtime
    .sendMessage<RuntimeMessage, { recorded: boolean; eventId?: string; reason?: string }>({
      type: "RECORD_LINK_CLICK",
      payload
    })
    .catch(() => undefined);
}

function getSelectionPayload(): CopyInteractionPayload | undefined {
  const selection = window.getSelection();
  const rawText = selection?.toString() || "";
  const selectedText = truncateText(rawText, MAX_COPIED_TEXT_LENGTH);

  if (!selection || !selectedText || selectedText.length < MIN_COPIED_TEXT_LENGTH) return undefined;
  if (isSelectionInsideSensitiveSurface(selection)) return undefined;

  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : undefined;
  const element = getElementFromRange(range);
  const rect = range?.getBoundingClientRect();

  return {
    selectedText,
    surroundingText: getSurroundingText(element, selectedText),
    sectionTitle: getSectionTitle(element),
    elementTag: element?.tagName.toLowerCase(),
    elementRole: element?.getAttribute("role") || undefined,
    cssSelector: element ? getCssSelector(element) : undefined,
    pageUrl: location.href,
    pageTitle: document.title,
    domain: location.hostname,
    viewportX: rect ? Math.round(rect.left) : undefined,
    viewportY: rect ? Math.round(rect.top) : undefined,
    pageX: rect ? Math.round(rect.left + window.scrollX) : undefined,
    pageY: rect ? Math.round(rect.top + window.scrollY) : undefined,
    timestamp: Date.now()
  };
}

function getLinkClickPayload(anchor: HTMLAnchorElement): LinkClickPayload | undefined {
  const targetUrl = normalizeHref(anchor.href);
  if (!targetUrl) return undefined;

  const target = new URL(targetUrl);
  const current = new URL(location.href);
  const linkKind = classifyLink(anchor, target, current);
  if (!linkKind) return undefined;

  const targetText = truncateText(
    anchor.innerText || anchor.getAttribute("aria-label") || anchor.title || target.href,
    180
  );

  return {
    pageUrl: location.href,
    pageTitle: document.title,
    domain: location.hostname,
    targetUrl: target.href,
    targetText,
    targetDomain: target.hostname,
    sectionTitle: getSectionTitle(anchor),
    elementTag: anchor.tagName.toLowerCase(),
    elementRole: anchor.getAttribute("role") || undefined,
    cssSelector: getCssSelector(anchor),
    linkKind,
    timestamp: Date.now()
  };
}

function normalizeHref(href: string): string | undefined {
  try {
    const url = new URL(href, location.href);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function classifyLink(anchor: HTMLAnchorElement, target: URL, current: URL): TrailLinkKind | undefined {
  const pathname = target.pathname.toLowerCase();
  const targetText = `${anchor.innerText} ${anchor.getAttribute("aria-label") || ""} ${anchor.title || ""}`.toLowerCase();
  const currentHost = current.hostname.replace(/^www\./, "");
  const targetHost = target.hostname.replace(/^www\./, "");

  if (/\.(pdf|zip|tar|gz|dmg|exe|pkg|csv|xlsx?|docx?|pptx?)$/i.test(pathname)) return "download";
  if (targetHost === "github.com" && /\/(issues|pull|releases|blob|tree)\//.test(pathname)) return "github";
  if (isSearchPage(current) && targetHost !== currentHost) return "search_result";
  if (targetHost === currentHost && target.pathname === current.pathname && target.hash) return "doc_toc";
  if (targetHost !== currentHost) return "external";
  if (/\b(readme|docs?|guide|reference|api|issue|pull request|release)\b/i.test(targetText)) return "reference";

  return undefined;
}

function isSearchPage(url: URL): boolean {
  const host = url.hostname.replace(/^www\./, "");
  return (
    ["google.com", "bing.com", "duckduckgo.com", "kagi.com", "perplexity.ai"].some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    ) || ["/search", "/html"].some((path) => url.pathname.startsWith(path))
  );
}

function isSelectionInsideSensitiveSurface(selection: Selection): boolean {
  const node = selection.anchorNode || selection.focusNode;
  const element = node instanceof Element ? node : node?.parentElement;
  const target = element?.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']");

  if (!target) return false;
  if (target instanceof HTMLInputElement && target.type.toLowerCase() === "password") return true;
  return true;
}

function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function getElementFromRange(range?: Range): Element | undefined {
  if (!range) return undefined;
  const node = range.commonAncestorContainer;
  return node instanceof Element ? node : node.parentElement || undefined;
}

function getSurroundingText(element: Element | undefined, selectedText: string): string | undefined {
  if (!element) return undefined;

  const text = truncateText(element.textContent || "", MAX_CONTEXT_TEXT_LENGTH);
  if (!text || text === selectedText) return undefined;
  return text;
}

function getSectionTitle(element: Element | undefined): string | undefined {
  if (!element) return undefined;

  const localHeading = element.closest("section, article, main, [role='main']")?.querySelector("h1, h2, h3");
  const headingText = localHeading?.textContent?.trim();
  if (headingText) return truncateText(headingText, 120);

  let cursor: Element | null = element;
  while (cursor && cursor !== document.body) {
    let previous = cursor.previousElementSibling;
    while (previous) {
      if (/^H[1-3]$/.test(previous.tagName)) {
        const text = previous.textContent?.trim();
        return text ? truncateText(text, 120) : undefined;
      }
      previous = previous.previousElementSibling;
    }
    cursor = cursor.parentElement;
  }

  return undefined;
}

function getCssSelector(element: Element): string {
  const parts: string[] = [];
  let cursor: Element | null = element;

  while (cursor && cursor !== document.body && parts.length < 5) {
    const tag = cursor.tagName.toLowerCase();
    const id = cursor.id ? `#${CSS.escape(cursor.id)}` : "";
    const className = Array.from(cursor.classList)
      .slice(0, 2)
      .map((item) => `.${CSS.escape(item)}`)
      .join("");

    parts.unshift(`${tag}${id}${className}`);
    if (id) break;
    cursor = cursor.parentElement;
  }

  return parts.join(" > ");
}

function showToast(eventId: string) {
  let toast = document.getElementById(TOAST_ID);
  if (!toast) {
    toast = document.createElement("div");
    toast.id = TOAST_ID;
    toast.setAttribute("role", "status");
    toast.style.cssText = [
      "position:fixed",
      "right:18px",
      "bottom:18px",
      "z-index:2147483647",
      "display:flex",
      "align-items:center",
      "gap:10px",
      "max-width:min(360px,calc(100vw - 36px))",
      "padding:10px 12px",
      "border:1px solid rgba(32,43,54,.18)",
      "border-radius:8px",
      "background:rgba(255,253,248,.96)",
      "color:#18212c",
      "box-shadow:0 12px 30px rgba(24,33,44,.14)",
      "font:600 13px/1.4 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif"
    ].join(";");
    document.documentElement.appendChild(toast);
  }

  toast.innerHTML = "";
  const text = document.createElement("span");
  text.textContent = "已记录到 Trail";
  const undo = document.createElement("button");
  undo.type = "button";
  undo.textContent = "撤销";
  undo.style.cssText = [
    "border:0",
    "border-radius:7px",
    "background:#202b36",
    "color:white",
    "padding:5px 8px",
    "font:700 12px/1 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
    "cursor:pointer"
  ].join(";");
  undo.addEventListener("click", () => {
    void chrome.runtime.sendMessage<RuntimeMessage, { deleted: boolean }>({ type: "DELETE_EVENT", eventId });
    toast?.remove();
  });

  toast.append(text, undo);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast?.remove(), 4200);
}
