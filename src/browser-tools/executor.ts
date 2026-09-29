import type {
  BrowserToolDefinition,
  BrowserToolExecutionProgressEvent,
  BrowserToolExtractStep,
  BrowserToolFieldDefinition,
  BrowserToolGraphqlFetchStep,
  BrowserToolRunResult,
  BrowserToolStep
} from "./contracts";
import { extractGraphqlCursor, extractGraphqlRecords, readJsonPath } from "./graphql";
import { BROWSER_TOOL_LIMITS } from "./limits";
import { matchesBrowserTool } from "./matcher";
import { resolveParameters, resolveTemplate } from "./template";
import { applyBrowserToolTransforms } from "./transforms";
import { sendMessage } from "../shared/runtime";

type ExecutionSignal = "continue" | "stop_repeat" | "pause" | "finish";

type ExecutionContext = {
  outcome?: "success" | "already_done";
  message?: string;
  definition: BrowserToolDefinition;
  parameters: Record<string, unknown>;
  values: Record<string, unknown>;
  data: Record<string, Array<Record<string, unknown>>>;
  warnings: string[];
  fingerprints: Map<string, string>;
  recordFingerprints: Map<string, Set<string>>;
  recordIdentities: Map<string, Set<string>>;
  maxRecords: number;
  progressId?: string;
};

export async function executeBrowserTool(
  definition: BrowserToolDefinition,
  suppliedParameters: Record<string, unknown>,
  progressId?: string
): Promise<BrowserToolRunResult> {
  const startedAt = Date.now();
  const runId = `browser_tool_${createBrowserToolRunId()}`;
  const context: ExecutionContext = {
    definition,
    parameters: {},
    values: {},
    data: {},
    warnings: [],
    fingerprints: new Map(),
    recordFingerprints: new Map(),
    recordIdentities: new Map(),
    maxRecords: Math.min(definition.limits?.max_records || 500, BROWSER_TOOL_LIMITS.maxRecords),
    progressId
  };

  try {
    if (!matchesBrowserTool(definition, location.href)) {
      throw new Error(`工具 ${definition.id} 不适用于当前页面。`);
    }

    context.parameters = resolveParameters(definition, suppliedParameters);
    const signal = await executeSteps(definition.workflow, context, false);
    if (definition.checkin && signal !== "pause" && !context.outcome) throw new Error("未获得明确的签到结果。");

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
    case "if": {
      const condition = { ...step.condition, selector: resolve(step.condition.selector, context) };
      return executeSteps(findMatchingElement(condition) ? step.then : step.else || [], context, insideRepeat);
    }
    case "finish":
      context.outcome = step.outcome;
      context.message = step.message;
      return "finish";
    case "wait_for": {
      const selector = resolve(step.selector, context);
      const condition = { selector, visible: step.visible, text: step.text };
      const element = findMatchingElement(condition) || await waitForMutation(() => findMatchingElement(condition), step.timeout_ms ?? 15_000);
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
      if (step.url_contains && location.href.includes(step.url_contains)) {
        context.warnings.push(step.reason);
        return "pause";
      }
      if (!step.selector) return "continue";
      const selector = resolve(step.selector, context);
      const element = await waitForElement(selector, step.timeout_ms || 1_500);
      if (!element) return "continue";
      context.warnings.push(step.reason);
      return "pause";
    }
    case "extract":
      return extractCollection(step, context) ? "continue" : insideRepeat ? "stop_repeat" : "continue";
    case "graphql_fetch":
      return executeGraphqlFetchStep(step, context);
    case "repeat": {
      const requestedMax = typeof step.max === "number" ? step.max : Number(resolve(step.max, context));
      if (!Number.isInteger(requestedMax) || requestedMax < 1) throw new Error("repeat.max 运行时参数必须是正整数。");
      const max = Math.min(requestedMax, BROWSER_TOOL_LIMITS.maxRepeat);
      let unchangedIterations = 0;
      const repeatStartRecordCount = totalRecordCount(context.data);
      for (let index = 0; index < max; index += 1) {
        if (step.progress && context.progressId) {
          void chrome.runtime.sendMessage({
            type: "BROWSER_TOOL_EXECUTION_PROGRESS",
            progressId: context.progressId,
            toolId: context.definition.id,
            scope: step.progress.scope,
            label: step.progress.label,
            itemLabel: step.progress.item_label,
            current: index + 1,
            total: max,
            recordCount: totalRecordCount(context.data)
          } satisfies BrowserToolExecutionProgressEvent).catch(() => undefined);
        }
        const recordsBefore = totalRecordCount(context.data);
        const signal = await executeSteps(step.steps, context, true);
        if (signal === "pause" || signal === "finish") return signal;
        if (signal === "stop_repeat") break;
        if (step.stop_after_unchanged) {
          unchangedIterations = totalRecordCount(context.data) === recordsBefore ? unchangedIterations + 1 : 0;
          if (unchangedIterations >= step.stop_after_unchanged) break;
        }
        if (step.stop_after_records && totalRecordCount(context.data) - repeatStartRecordCount >= step.stop_after_records) break;
        if (index < max - 1 && step.between?.length) {
          const betweenSignal = await executeSteps(step.between, context, true);
          if (betweenSignal === "pause" || betweenSignal === "finish") return betweenSignal;
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
  const seenIdentities = context.recordIdentities.get(step.collection) || new Set<string>();
  context.recordIdentities.set(step.collection, seenIdentities);
  context.fingerprints.set(selector, fingerprint(selector));

  for (const root of roots) {
    if (totalRecordCount(context.data) >= context.maxRecords) {
      if (!context.warnings.includes("已达到工具的最大记录数。")) context.warnings.push("已达到工具的最大记录数。");
      return false;
    }

    const record: Record<string, unknown> = {};
    let identity: unknown;
    if (step.dedupe_by) {
      identity = extractField(root, step.fields[step.dedupe_by], context);
      const identityKey = JSON.stringify(identity);
      if (identity !== undefined && seenIdentities.has(identityKey)) continue;
    }
    for (const [name, field] of Object.entries(step.fields)) {
      const value = name === step.dedupe_by ? identity : extractField(root, field, context);
      if (value === undefined && !field.optional) context.warnings.push(`记录字段缺失：${step.collection}.${name}`);
      if (value !== undefined) record[name] = value;
    }
    if (Object.keys(record).length > 0) {
      const recordFingerprint = JSON.stringify(record);
      if (!seen.has(recordFingerprint)) {
        seen.add(recordFingerprint);
        if (step.dedupe_by && identity !== undefined) seenIdentities.add(JSON.stringify(identity));
        collection.push(record);
      }
    }
  }

  return true;
}

/** 详情页字段提取：由 contentRuntime 的详情补全消息调用，选择器作用于整个文档。 */
export function extractPageFields(fields: Record<string, BrowserToolFieldDefinition>): Record<string, unknown> {
  const context: ExecutionContext = { definition: { schema_version: 1, id: "detail_extract", name: "detail_extract", version: "0", match: { domains: [] }, workflow: [] }, parameters: {}, values: {}, data: {}, warnings: [], fingerprints: new Map(), recordFingerprints: new Map(), recordIdentities: new Map(), maxRecords: 1 };
  const record: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(fields)) {
    const value = extractField(document.documentElement, field, context);
    if (value !== undefined) record[name] = value;
  }
  return record;
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
    case "src": {
      const rawSrc = element.getAttribute("src") || element.getAttribute("data-src");
      value = rawSrc ? new URL(rawSrc, location.href).href : undefined;
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
  return resolveTemplate(value, context.definition, context.parameters, context.values);
}

const GRAPHQL_MAX_PAGES = 20;
const graphqlQueryIdCache = new Map<string, string>();

/** 在已登录的 x.com 页面上下文中调用内部 GraphQL 接口并提取结构化数据。 */
async function executeGraphqlFetchStep(step: BrowserToolGraphqlFetchStep, context: ExecutionContext): Promise<ExecutionSignal> {
  const host = location.hostname.toLowerCase();
  if (host !== "x.com" && host !== "twitter.com" && !host.endsWith(".x.com")) {
    throw new Error(`graphql_fetch 需要 x.com 页面上下文（当前：${host}）。`);
  }
  if (!/(?:^|;\s*)ct0=/.test(document.cookie)) {
    throw new Error("页面缺少 x.com 登录态（ct0），请先登录后重试。");
  }

  const queryId = await resolveGraphqlQueryId(host, step);
  const requestedMax = typeof step.max_pages === "number"
    ? step.max_pages
    : step.max_pages !== undefined ? Number(resolve(String(step.max_pages), context)) : 1;
  if (!Number.isInteger(requestedMax) || requestedMax < 1) throw new Error("graphql_fetch.max_pages 必须是正整数。");
  const maxPages = Math.min(requestedMax, GRAPHQL_MAX_PAGES);

  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    if (page > 0 && step.page_delay_ms) await sleep(step.page_delay_ms);
    const variables: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(step.variables || {})) {
      variables[name] = typeof value === "string" ? resolve(value, context) : value;
    }
    if (step.cursor && cursor) variables.cursor = cursor;

    const payload = await sendMessage({
      type: "BROWSER_TOOL_GRAPHQL_FETCH",
      operation: step.operation,
      query_id: queryId,
      variables,
      features: step.features,
      field_toggles: step.field_toggles
    });
    if (!payload || typeof payload.json !== "object" || payload.json === null) {
      throw new Error(`GraphQL ${step.operation} 没有返回 JSON 数据。`);
    }

    for (const [name, path] of Object.entries(step.store || {})) {
      const value = readJsonPath(payload.json, resolve(path, context));
      if (value === undefined) throw new Error(`未从 ${step.operation} 响应读取到 ${name}（账号可能不存在、改名或被冻结）。`);
      context.values[name] = value;
    }

    if (step.extract) collectGraphqlRecords(step, payload.json, context);
    const nextCursor = step.cursor ? extractGraphqlCursor(payload.json, step.cursor) : null;
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }
  return "continue";
}

async function resolveGraphqlQueryId(host: string, step: BrowserToolGraphqlFetchStep): Promise<string> {
  const cacheKey = `${host}:${step.operation}`;
  const cached = graphqlQueryIdCache.get(cacheKey);
  if (cached) return cached;
  const resolved = await sendMessage({ type: "BROWSER_TOOL_GRAPHQL_RESOLVE", operation: step.operation });
  const queryId = resolved?.queryId || step.query_id || "";
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(queryId)) {
    throw new Error(`无法解析 ${step.operation} 的 queryId，页面 bundle 扫描失败且工具未提供兜底值。`);
  }
  graphqlQueryIdCache.set(cacheKey, queryId);
  return queryId;
}

function collectGraphqlRecords(step: BrowserToolGraphqlFetchStep, payload: unknown, context: ExecutionContext): void {
  const spec = step.extract!;
  const collection = (context.data[spec.collection] ||= []);
  const seenIdentities = context.recordIdentities.get(spec.collection) || new Set<string>();
  context.recordIdentities.set(spec.collection, seenIdentities);
  const seenFingerprints = context.recordFingerprints.get(spec.collection) || new Set<string>();
  context.recordFingerprints.set(spec.collection, seenFingerprints);

  for (const record of extractGraphqlRecords(payload, spec)) {
    if (totalRecordCount(context.data) >= context.maxRecords) {
      if (!context.warnings.includes("已达到工具的最大记录数。")) context.warnings.push("已达到工具的最大记录数。");
      return;
    }
    if (spec.dedupe_by) {
      const identity = JSON.stringify(record[spec.dedupe_by]);
      if (seenIdentities.has(identity)) continue;
      seenIdentities.add(identity);
    } else {
      const fingerprint = JSON.stringify(record);
      if (seenFingerprints.has(fingerprint)) continue;
      seenFingerprints.add(fingerprint);
    }
    collection.push(record);
  }
}

function findMatchingElement(condition: { selector: string; visible?: boolean; text?: string }): Element | undefined {
  return [...document.querySelectorAll(condition.selector)].find((element) => {
    if (condition.text && !(element.textContent || "").includes(condition.text)) return false;
    if (condition.visible !== undefined) {
      const style = getComputedStyle(element);
      const visible = element.getClientRects().length > 0 && style.visibility !== "hidden" && style.visibility !== "collapse" && style.display !== "none";
      if (visible !== condition.visible) return false;
    }
    return true;
  });
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
    outcome: context.outcome,
    message: context.message,
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
