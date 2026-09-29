import type { RuntimeMessage } from "../shared/types";

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
  if (cached && Date.now() - cached.at < QUERY_ID_TTL_MS) return { queryId: cached.queryId };

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: scanOperationInPage,
    args: [message.operation]
  });
  const found = (results[0]?.result as { queryId?: unknown } | undefined)?.queryId;
  if (typeof found === "string" && QUERY_ID_PATTERN.test(found)) {
    queryIdCache.set(cacheKey, { queryId: found, at: Date.now() });
    return { queryId: found };
  }
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

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: fetchGraphqlInPage,
    args: [url, TWITTER_BEARER_TOKEN]
  });
  const result = results[0]?.result as { status: number; ok: boolean; json: unknown; error?: string } | undefined;
  if (!result) throw new Error("页面内 GraphQL 请求没有返回结果。");
  if (result.error) throw new Error(`页面内请求失败：${result.error}`);
  if (result.status === 401 || result.status === 403) throw new Error(`x.com 拒绝了请求（HTTP ${result.status}），登录态可能已过期，请重新打开页面登录。`);
  if (result.status === 429) throw new Error("x.com 返回 429 限流，请降低抓取频率并稍后重试。");
  if (!result.ok) throw new Error(`x.com 接口返回 HTTP ${result.status}。`);
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
