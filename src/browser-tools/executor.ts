import type {
  BrowserToolDefinition,
  BrowserToolExtractStep,
  BrowserToolFieldDefinition,
  BrowserToolRunResult,
  BrowserToolStep
} from "./contracts";
import { BROWSER_TOOL_LIMITS } from "./limits";
import { matchesBrowserTool } from "./matcher";
import { resolveParameters, resolveTemplate } from "./template";
import { applyBrowserToolTransforms } from "./transforms";

type ExecutionSignal = "continue" | "stop_repeat" | "pause";

type ExecutionContext = {
  definition: BrowserToolDefinition;
  parameters: Record<string, unknown>;
  data: Record<string, Array<Record<string, unknown>>>;
  warnings: string[];
  fingerprints: Map<string, string>;
  recordFingerprints: Map<string, Set<string>>;
  maxRecords: number;
};

export async function executeBrowserTool(
  definition: BrowserToolDefinition,
  suppliedParameters: Record<string, unknown>
): Promise<BrowserToolRunResult> {
  const startedAt = Date.now();
  const runId = `browser_tool_${createBrowserToolRunId()}`;
  const context: ExecutionContext = {
    definition,
    parameters: {},
    data: {},
    warnings: [],
    fingerprints: new Map(),
    recordFingerprints: new Map(),
    maxRecords: Math.min(definition.limits?.max_records || 500, BROWSER_TOOL_LIMITS.maxRecords)
  };

  try {
    if (!matchesBrowserTool(definition, location.href)) {
      throw new Error(`工具 ${definition.id} 不适用于当前页面。`);
    }

    context.parameters = resolveParameters(definition, suppliedParameters);
    const signal = await executeSteps(definition.workflow, context, false);

    return buildResult(context, runId, startedAt, signal === "pause" ? "paused" : "completed");
  } catch (error) {
    return buildResult(context, runId, startedAt, "failed", error instanceof Error ? error.message : "浏览器工具执行失败。");
  }
}

function createBrowserToolRunId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();

  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0"));
    return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
  }

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

async function executeSteps(steps: BrowserToolStep[], context: ExecutionContext, insideRepeat: boolean): Promise<ExecutionSignal> {
  for (const step of steps) {
    const signal = await executeStep(step, context, insideRepeat);
    if (signal !== "continue") return signal;

    const delay = context.definition.limits?.delay_between_actions_ms || 0;
    if (delay > 0) await sleep(delay);
  }
  return "continue";
}

async function executeStep(step: BrowserToolStep, context: ExecutionContext, insideRepeat: boolean): Promise<ExecutionSignal> {
  switch (step.action) {
    case "wait_for": {
      const selector = resolve(step.selector, context);
      const element = await waitForElement(selector, step.timeout_ms);
      if (!element) {
        if (step.optional) {
          context.warnings.push(`未找到可选元素：${selector}`);
          return "continue";
        }
        throw new Error(`等待元素超时：${selector}`);
      }
      context.fingerprints.set(selector, fingerprint(selector));
      return "continue";
    }
    case "fill": {
      const selector = resolve(step.selector, context);
      const element = queryElement(selector);
      const value = resolve(step.value, context);
      fillElement(element, value, step.clear !== false);
      return "continue";
    }
    case "select": {
      const selector = resolve(step.selector, context);
      const element = queryElement(selector);
      if (!(element instanceof HTMLSelectElement)) throw new Error(`元素不是 select：${selector}`);
      const value = resolve(step.value, context);
      if (![...element.options].some((option) => option.value === value)) throw new Error(`select 中不存在值：${value}`);
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return "continue";
    }
    case "click": {
      const selector = resolve(step.selector, context);
      const element = document.querySelector(selector);
      if (!(element instanceof HTMLElement)) {
        if (step.optional) {
          context.warnings.push(`未找到可选点击元素：${selector}`);
          return insideRepeat && step.stop_repeat_on_missing ? "stop_repeat" : "continue";
        }
        throw new Error(`未找到可点击元素：${selector}`);
      }

      const changeSelector = step.wait_for_change ? resolve(step.wait_for_change.selector, context) : undefined;
      const before = changeSelector ? fingerprint(changeSelector) : undefined;
      element.click();
      if (changeSelector) {
        const changed = await waitForFingerprintChange(changeSelector, before || "", step.wait_for_change?.timeout_ms);
        if (!changed) throw new Error(`点击后页面内容未变化：${changeSelector}`);
        context.fingerprints.set(changeSelector, fingerprint(changeSelector));
      }
      return "continue";
    }
    case "wait":
      await sleep(step.duration_ms);
      return "continue";
    case "scroll": {
      const target = step.selector ? queryElement(step.selector) : document.scrollingElement;
      if (!(target instanceof Element)) throw new Error("没有找到可滚动区域。");
      if (step.position) {
        const top = step.position === "top" ? 0 : target.scrollHeight;
        target.scrollTo({ top, behavior: "auto" });
      } else {
        target.scrollBy({ top: step.delta_y || 0, behavior: "auto" });
      }
      return "continue";
    }
    case "wait_for_change": {
      const selector = resolve(step.selector, context);
      const previous = context.fingerprints.get(selector) || "";
      const changed = await waitForFingerprintChange(selector, previous, step.timeout_ms);
      if (!changed) {
        if (step.optional) {
          context.warnings.push(`可选内容没有发生变化：${selector}`);
          return "continue";
        }
        throw new Error(`等待内容变化超时：${selector}`);
      }
      context.fingerprints.set(selector, fingerprint(selector));
      return "continue";
    }
    case "pause_if_present": {
      const selector = resolve(step.selector, context);
      const element = await waitForElement(selector, step.timeout_ms || 1_500);
      if (!element) return "continue";
      context.warnings.push(step.reason);
      return "pause";
    }
    case "extract":
      return extractCollection(step, context) ? "continue" : insideRepeat ? "stop_repeat" : "continue";
    case "repeat": {
      const requestedMax = typeof step.max === "number" ? step.max : Number(resolve(step.max, context));
      if (!Number.isInteger(requestedMax) || requestedMax < 1) throw new Error("repeat.max 运行时参数必须是正整数。");
      const max = Math.min(requestedMax, BROWSER_TOOL_LIMITS.maxRepeat);
      for (let index = 0; index < max; index += 1) {
        const signal = await executeSteps(step.steps, context, true);
        if (signal === "pause") return signal;
        if (signal === "stop_repeat") break;
        if (index < max - 1 && step.between?.length) {
          const betweenSignal = await executeSteps(step.between, context, true);
          if (betweenSignal === "pause") return betweenSignal;
          if (betweenSignal === "stop_repeat") break;
        }
      }
      return "continue";
    }
    case "pause_for_user":
      context.warnings.push(step.reason);
      return "pause";
  }
}

function extractCollection(step: BrowserToolExtractStep, context: ExecutionContext): boolean {
  const selector = resolve(step.selector, context);
  const roots = [...document.querySelectorAll(selector)];
  if (roots.length === 0) throw new Error(`没有可提取的记录：${selector}`);

  const collection = (context.data[step.collection] ||= []);
  const seen = context.recordFingerprints.get(step.collection) || new Set<string>();
  context.recordFingerprints.set(step.collection, seen);
  context.fingerprints.set(selector, fingerprint(selector));

  for (const root of roots) {
    if (totalRecordCount(context.data) >= context.maxRecords) {
      if (!context.warnings.includes("已达到工具的最大记录数。")) context.warnings.push("已达到工具的最大记录数。");
      return false;
    }

    const record: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(step.fields)) {
      const value = extractField(root, field, context);
      if (value === undefined && !field.optional) context.warnings.push(`记录字段缺失：${step.collection}.${name}`);
      if (value !== undefined) record[name] = value;
    }
    if (Object.keys(record).length > 0) {
      const recordFingerprint = JSON.stringify(record);
      if (!seen.has(recordFingerprint)) {
        seen.add(recordFingerprint);
        collection.push(record);
      }
    }
  }

  return true;
}

function extractField(root: Element, field: BrowserToolFieldDefinition, context: ExecutionContext): unknown {
  if (field.multiple) {
    const elements = field.selector ? [...root.querySelectorAll(resolve(field.selector, context))] : [root];
    if (elements.length === 0) return undefined;
    return elements
      .map((element) => extractElementValue(element, field))
      .filter((value) => value !== undefined && value !== "");
  }

  const element = field.selector ? root.querySelector(resolve(field.selector, context)) : root;
  return element ? extractElementValue(element, field) : undefined;
}

function extractElementValue(element: Element, field: BrowserToolFieldDefinition): unknown {

  let value: string | null | undefined;
  switch (field.attribute || "text") {
    case "text":
      value = element.textContent;
      break;
    case "href": {
      const rawHref = element.getAttribute("href");
      value = rawHref ? new URL(rawHref, location.href).href : undefined;
      break;
    }
    case "content":
      value = element.getAttribute("content");
      break;
    case "datetime":
      value = element.getAttribute("datetime");
      break;
    case "aria_label":
      value = element.getAttribute("aria-label");
      break;
  }

  const clamped = typeof value === "string" ? value.slice(0, BROWSER_TOOL_LIMITS.maxTextLength) : value;
  return applyBrowserToolTransforms(clamped ?? undefined, field.transforms);
}

function fillElement(element: Element, value: string, clear: boolean): void {
  if (element instanceof HTMLInputElement) {
    if (element.type.toLowerCase() === "password") throw new Error("Browser Tool 禁止填写密码框。");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(element, clear ? value : `${element.value}${value}`);
  } else if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, clear ? value : `${element.value}${value}`);
  } else if (element instanceof HTMLElement && element.isContentEditable) {
    element.textContent = clear ? value : `${element.textContent || ""}${value}`;
  } else {
    throw new Error("fill 只支持 input、textarea 和 contenteditable 元素。");
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function queryElement(selector: string): Element {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`未找到元素：${selector}`);
  return element;
}

function resolve(value: string, context: ExecutionContext): string {
  return resolveTemplate(value, context.definition, context.parameters);
}

function fingerprint(selector: string): string {
  return [...document.querySelectorAll(selector)]
    .slice(0, 100)
    .map((element) => `${element.textContent || ""}|${element.getAttribute("href") || ""}`)
    .join("\n")
    .slice(0, 50_000);
}

async function waitForElement(selector: string, timeout = 15_000): Promise<Element | undefined> {
  const existing = document.querySelector(selector);
  if (existing) return existing;

  return waitForMutation(() => document.querySelector(selector) || undefined, timeout);
}

async function waitForFingerprintChange(selector: string, previous: string, timeout = 15_000): Promise<boolean> {
  if (fingerprint(selector) !== previous) return true;
  return Boolean(await waitForMutation(() => (fingerprint(selector) !== previous ? true : undefined), timeout));
}

function waitForMutation<T>(read: () => T | undefined, timeout: number): Promise<T | undefined> {
  return new Promise((resolvePromise) => {
    let settled = false;
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      resolvePromise(value);
    };
    const observer = new MutationObserver(() => {
      const value = read();
      if (value !== undefined) finish(value);
    });
    const timer = window.setTimeout(() => finish(undefined), timeout);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  });
}

function totalRecordCount(data: ExecutionContext["data"]): number {
  return Object.values(data).reduce((total, records) => total + records.length, 0);
}

function sleep(duration: number): Promise<void> {
  return new Promise((resolvePromise) => window.setTimeout(resolvePromise, duration));
}

function buildResult(
  context: ExecutionContext,
  runId: string,
  startedAt: number,
  status: BrowserToolRunResult["status"],
  error?: string
): BrowserToolRunResult {
  return {
    toolId: context.definition.id,
    runId,
    pageUrl: location.href,
    pageTitle: document.title,
    startedAt,
    finishedAt: Date.now(),
    status,
    data: context.data,
    warnings: context.warnings,
    error
  };
}
