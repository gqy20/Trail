import type { TrailInteractionSettings } from "./types";

export const DEFAULT_INTERACTION_SETTINGS: TrailInteractionSettings = {
  captureCopy: true,
  captureContext: true,
  showToast: true,
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

