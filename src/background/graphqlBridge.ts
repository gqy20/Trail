import type { RuntimeMessage } from "../shared/types";
import { getBudgetUsage } from "../collector/budget";
import { logDebug, logError, logInfo, logWarn } from "../logging/logger";

/**
 * X 网页客户端内置的公开 bearer token（全球同一个，随网页前端分发）。
 * 只由核心代码注入请求头，工具 YAML 无法提供或覆盖认证信息。
 */
const TWITTER_BEARER_TOKEN = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const OPERATION_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const QUERY_ID_PATTERN = /^[A-Za-z0-9_-]{3,80}$/;
const QUERY_ID_TTL_MS = 10 * 60_000;
const queryIdCache = new Map<string, { queryId: string; at: number }>();

type GraphqlResolveMessage = Extract<RuntimeMessage, { type: "BROWSER_TOOL_GRAPHQL_RESOLVE" }>;
type GraphqlFetchMessage = Extract<RuntimeMessage, { type: "BROWSER_TOOL_GRAPHQL_FETCH" }>;

export async function resolveGraphqlQueryIdForTab(
  message: GraphqlResolveMessage,
  sender: chrome.runtime.MessageSender
): Promise<{ queryId: string | null }> {
  const { tabId, origin } = requireTwitterPageContext(sender);
  if (!OPERATION_PATTERN.test(message.operation)) throw new Error("GraphQL 操作名不合法。");

  const cacheKey = `${origin}:${message.operation}`;
  const cached = queryIdCache.get(cacheKey);
  if (cached && Date.now() - cached.at < QUERY_ID_TTL_MS) {
    logDebug("graphql", "queryId.cache", "使用缓存的 queryId", { platform: "twitter", operation: message.operation });
    return { queryId: cached.queryId };
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: scanOperationInPage,
    args: [message.operation]
  });
  const found = (results[0]?.result as { queryId?: unknown } | undefined)?.queryId;
  if (typeof found === "string" && QUERY_ID_PATTERN.test(found)) {
    queryIdCache.set(cacheKey, { queryId: found, at: Date.now() });
    logInfo("graphql", "queryId.resolved", "从页面 bundle 解析到 queryId", { platform: "twitter", operation: message.operation, queryId: found });
    return { queryId: found };
  }
  logWarn("graphql", "queryId.miss", "bundle 扫描未命中 queryId，回退到工具兜底值", { platform: "twitter", operation: message.operation });
  return { queryId: null };
}

export async function fetchGraphqlPageForTab(
  message: GraphqlFetchMessage,
  sender: chrome.runtime.MessageSender
): Promise<{ status: number; json: unknown }> {
  const { tabId, origin } = requireTwitterPageContext(sender);
  if (!OPERATION_PATTERN.test(message.operation)) throw new Error("GraphQL 操作名不合法。");
  if (!QUERY_ID_PATTERN.test(message.query_id)) throw new Error("GraphQL queryId 不合法。");

  const variables = JSON.stringify(message.variables || {});
  const features = JSON.stringify(message.features || {});
  const fieldToggles = JSON.stringify(message.field_toggles || {});
  if (variables.length > 8_000 || features.length > 16_000 || fieldToggles.length > 4_000) {
    throw new Error("GraphQL 请求参数过大。");
  }

  const params = new URLSearchParams({ variables, features });
  if (message.field_toggles && Object.keys(message.field_toggles).length > 0) params.set("fieldToggles", fieldToggles);
  const url = `${origin}/i/api/graphql/${message.query_id}/${message.operation}?${params.toString()}`;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !parsed.pathname.startsWith("/i/api/graphql/")) {
    throw new Error("GraphQL 请求地址不在允许范围内。");
  }
  const budget = (await getBudgetUsage(["twitter"]))[0];
  const activityContext = { platform: "twitter", kind: "api", config: budget.config, used: budget.used, profile: budget.profile, detail: budget.detail };
  const startedAt = Date.now();

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: fetchGraphqlInPage,
    args: [url, TWITTER_BEARER_TOKEN]
  });
  const result = results[0]?.result as { status: number; ok: boolean; json: unknown; error?: string } | undefined;
  const elapsedMs = Date.now() - startedAt;
  if (!result) {
    logError("graphql", "fetch.noResult", "页面内 GraphQL 请求没有返回结果", { ...activityContext, operation: message.operation });
    throw new Error("页面内 GraphQL 请求没有返回结果。");
  }
  if (result.error) {
    logError("graphql", "fetch.error", "页面内请求失败", { ...activityContext, operation: message.operation, detail: result.error, elapsedMs });
    throw new Error(`页面内请求失败：${result.error}`);
  }
  logDebug("graphql", "fetch", "GraphQL 请求完成", { ...activityContext, operation: message.operation, status: result.status, elapsedMs });
  if (result.status === 401 || result.status === 403) {
    logError("graphql", "fetch.auth", "登录态被拒绝", { ...activityContext, operation: message.operation, status: result.status });
    throw new Error(`需要重新登录 x.com（HTTP ${result.status}）。`);
  }
  if (result.status === 429) {
    logError("graphql", "fetch.rateLimited", "触发 429 限流", { ...activityContext, operation: message.operation, status: result.status, elapsedMs });
    throw new Error("x.com 返回 429 限流，请降低抓取频率并稍后重试。");
  }
  if (!result.ok) {
    logError("graphql", "fetch.httpError", "接口返回异常状态", { ...activityContext, operation: message.operation, status: result.status });
    throw new Error(`x.com 接口返回 HTTP ${result.status}。`);
  }
  return { status: result.status, json: result.json };
}

function requireTwitterPageContext(sender: chrome.runtime.MessageSender): { tabId: number; origin: string } {
  const tabId = sender.tab?.id;
  const senderUrl = sender.url || sender.tab?.url || "";
  if (tabId === undefined || !senderUrl) throw new Error("GraphQL 请求缺少来源标签页。");
  const parsed = new URL(senderUrl);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (host !== "x.com" && host !== "twitter.com" && !host.endsWith(".x.com"))) {
    throw new Error("GraphQL 桥只接受来自 x.com 页面的请求。");
  }
  return { tabId, origin: parsed.origin };
}

/** 在页面主世界扫描已加载的 client-web bundle，解析操作名对应的 queryId。 */
async function scanOperationInPage(operation: string): Promise<{ queryId: string | null }> {
  const sources: string[] = [];
  for (const script of Array.from(document.scripts)) {
    if (script.src) sources.push(script.src);
  }
  try {
    for (const entry of performance.getEntriesByType("resource")) {
      const name = (entry as PerformanceEntry).name;
      if (typeof name === "string" && name.includes("client-web") && name.endsWith(".js")) sources.push(name);
    }
  } catch {
    // 某些页面上下文限制 performance 访问，忽略。
  }
  const unique = [...new Set(sources)];
  const candidates = [...new Set([...unique.slice(0, 15), ...unique.slice(-15)])];
  for (const src of candidates) {
    try {
      const response = await fetch(src);
      if (!response.ok) continue;
      const text = await response.text();
      const direct = new RegExp(`queryId:"([A-Za-z0-9_-]{3,80})",operationName:"${operation}"`).exec(text)
        || new RegExp(`operationName:"${operation}"[^{}]{0,160}?queryId:"([A-Za-z0-9_-]{3,80})"`).exec(text);
      if (direct) return { queryId: direct[1] };
    } catch {
      // 单个 bundle 拉取失败时尝试下一个。
    }
  }
  return { queryId: null };
}

/** 在页面主世界携带登录 cookie 调用 GraphQL 接口；认证头由核心注入。 */
async function fetchGraphqlInPage(
  url: string,
  bearer: string
): Promise<{ status: number; ok: boolean; json: unknown; error?: string }> {
  try {
    const rawCt0 = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/)?.[1];
    if (!rawCt0) return { status: 401, ok: false, json: null, error: "页面缺少 ct0 登录态" };
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "X-Csrf-Token": decodeURIComponent(rawCt0),
        "X-Twitter-Auth-Type": "OAuth2Session",
        "X-Twitter-Active-User": "yes"
      }
    });
    let json: unknown = null;
    try {
      json = await response.json();
    } catch {
      json = null;
    }
    return { status: response.status, ok: response.ok, json };
  } catch (error) {
    return { status: 0, ok: false, json: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** 页面主世界读取 SSR 注入的全局状态（当前仅 __INITIAL_STATE__），供 state_read 步骤使用。 */
export async function readPageStateForTab(
  message: Extract<RuntimeMessage, { type: "BROWSER_TOOL_STATE_READ" }>,
  sender: chrome.runtime.MessageSender
): Promise<{ state: unknown }> {
  const tabId = sender.tab?.id;
  const senderUrl = sender.url || sender.tab?.url || "";
  if (tabId === undefined || !senderUrl) throw new Error("状态读取缺少来源标签页。");
  const parsed = new URL(senderUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("状态读取只支持普通网页。");
  const source = message.source || "__INITIAL_STATE__";
  if (source !== "__INITIAL_STATE__") throw new Error("不支持的状态源。");
  let results: chrome.scripting.InjectionResult<unknown>[];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: readInitialStateInPage
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (detail.includes("Cannot access contents")) {
      throw new Error(`扩展缺少 ${parsed.hostname} 的主机权限（manifest host_permissions），请重新加载扩展并确认权限。`);
    }
    throw error;
  }
  return { state: results[0]?.result ?? null };
}

/**
 * 页面主世界读取 __INITIAL_STATE__。必须完全自包含：chrome.scripting
 * 只序列化函数本身，模块作用域引用注入后不存在。用迭代克隆替代递归——
 * 整树深递归会爆栈（实测 RangeError），且 Vue 响应式代理含循环引用与
 * 抛异常的 getter；深度 14 / 节点 3 万封顶，Pinia Ref 的 _value 包装
 * 保留原样（提取的递归 walk 可穿透）。
 */
function readInitialStateInPage(): Promise<unknown> {
  return (async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const root = (window as { __INITIAL_STATE__?: unknown }).__INITIAL_STATE__;
      if (root !== undefined && root !== null && typeof root === "object") {
        const seen = new WeakMap<object, number>();
        const out: Record<string, unknown> = {};
        const stack: Array<{ src: Record<string, unknown>; dst: Record<string, unknown>; depth: number }> = [
          { src: root as Record<string, unknown>, dst: out, depth: 0 }
        ];
        let count = 0;
        while (stack.length > 0) {
          count += 1;
          if (count > 30_000) return out;
          const frame = stack.pop()!;
          if (!frame.src || typeof frame.src !== "object") continue;
          for (const key of Object.keys(frame.src)) {
            let value: unknown;
            try {
              value = frame.src[key];
            } catch {
              continue;
            }
            if (value === null || typeof value !== "object") {
              if (typeof value === "function") continue;
              if (typeof value === "bigint") { frame.dst[key] = String(value); continue; }
              frame.dst[key] = value;
              continue;
            }
            if (seen.has(value as object)) { frame.dst[key] = "[Circular]"; continue; }
            seen.set(value as object, 1);
            if (value instanceof Date) { frame.dst[key] = value.toISOString(); continue; }
            if (frame.depth + 1 > 14) { frame.dst[key] = "[DepthLimit]"; continue; }
            const child = (Array.isArray(value) ? [] : {}) as Record<string, unknown>;
            frame.dst[key] = child;
            stack.push({ src: value as Record<string, unknown>, dst: child, depth: frame.depth + 1 });
          }
        }
        return out;
      }
      await new Promise((resolve) => setTimeout(resolve, 800));
    }
    return null;
  })();
}
