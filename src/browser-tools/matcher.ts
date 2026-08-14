import type { BrowserToolDefinition } from "./contracts";

export function matchesBrowserTool(definition: BrowserToolDefinition, pageUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    return false;
  }

  const hostname = url.hostname.toLowerCase();
  const domainMatched = definition.match.domains.some((pattern) => matchesDomain(pattern, hostname));
  if (!domainMatched) return false;

  const urlPatterns = definition.match.urls;
  if (!urlPatterns?.length) return true;

  const pathAndQuery = `${url.pathname}${url.search}`;
  return urlPatterns.some((pattern) => matchesGlob(pattern, pageUrl) || matchesGlob(pattern, pathAndQuery));
}

function matchesDomain(pattern: string, hostname: string): boolean {
  const normalized = pattern.trim().toLowerCase();
  if (normalized.startsWith("*.")) {
    const suffix = normalized.slice(1);
    return hostname.endsWith(suffix) && hostname.length > suffix.length;
  }
  return hostname === normalized;
}

function matchesGlob(pattern: string, value: string): boolean {
  const expression = pattern
    .split("*")
    .map((part) => escapeRegExp(part))
    .join(".*");
  return new RegExp(`^${expression}$`, "i").test(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
