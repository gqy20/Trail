import type { TrailCopyKind, TrailInteractionSettings } from "./types";

export const DEFAULT_INTERACTION_SETTINGS: TrailInteractionSettings = {
  captureCopy: true,
  captureSelection: true,
  captureContext: true,
  showToast: true,
  mergeDuplicates: true,
  redactSensitive: false,
  excludedDomains: []
};

export const MAX_COPIED_TEXT_LENGTH = 1200;
export const MAX_CONTEXT_TEXT_LENGTH = 420;
export const MIN_COPIED_TEXT_LENGTH = 8;

export function normalizeDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/^www\./, "");
}

export function isDomainExcluded(domain: string, excludedDomains: string[]): boolean {
  const normalized = normalizeDomain(domain);
  return excludedDomains.some((item) => {
    const blocked = normalizeDomain(item);
    return normalized === blocked || normalized.endsWith(`.${blocked}`);
  });
}

export function truncateText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trim()}…`;
}

export function normalizeCopiedText(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim()
    .toLowerCase();
}

export function isSameCopiedText(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return normalizeCopiedText(left) === normalizeCopiedText(right);
}

export function classifyCopiedText(value: string, elementTag?: string): TrailCopyKind {
  const text = value.trim();
  const lower = text.toLowerCase();

  if (/^https?:\/\/\S+$/i.test(text)) return "link";
  if (elementTag === "code" || elementTag === "pre") return "code";
  if (/^(npm|pnpm|yarn|npx|git|curl|docker|pip|python|node|bun)\s+/i.test(text)) return "command";
  if (/[{};=<>]/.test(text) && /\b(import|export|const|let|function|class|return|type|interface)\b/.test(lower)) return "code";
  if (/\d/.test(text) && /(%|ms|s|kb|mb|gb|x|倍|秒|分钟|小时|美元|元|万|亿)/i.test(text)) return "metric";
  if (text.length > 80 && /[。.!?？]/.test(text)) return "quote";

  return "text";
}

export function redactSensitiveText(value: string): { text: string; redacted: boolean } {
  let redacted = false;
  let text = value;

  const patterns: RegExp[] = [
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    /\b(?:sk|pk|rk|ghp|gho|github_pat|xoxb|xoxp|ya29)[_-][A-Za-z0-9_-]{16,}\b/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    /\b(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*["']?[^"'\s]{8,}/gi
  ];

  for (const pattern of patterns) {
    text = text.replace(pattern, () => {
      redacted = true;
      return "[已脱敏]";
    });
  }

  return { text, redacted };
}
