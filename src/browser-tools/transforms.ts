import type { BrowserToolTransform } from "./contracts";

export function applyBrowserToolTransforms(value: unknown, transforms: BrowserToolTransform[] = []): unknown {
  return transforms.reduce<unknown>((current, transform) => applyTransform(current, transform), value);
}

function applyTransform(value: unknown, transform: BrowserToolTransform): unknown {
  switch (transform) {
    case "trim":
      return typeof value === "string" ? value.trim() : value;
    case "normalize_whitespace":
      return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : value;
    case "parse_year": {
      const match = String(value ?? "").match(/\b(18|19|20|21)\d{2}\b/);
      return match ? Number(match[0]) : undefined;
    }
    case "parse_number": {
      const normalized = String(value ?? "").replace(/[,，\s]/g, "");
      const match = normalized.match(/-?\d+(?:\.\d+)?/);
      return match ? Number(match[0]) : undefined;
    }
    case "parse_date": {
      if (typeof value !== "string" && typeof value !== "number") return value;
      const time = typeof value === "number" ? value : Date.parse(value.trim());
      return Number.isFinite(time) ? new Date(time).toISOString() : value;
    }
    case "split_authors":
      return typeof value === "string"
        ? value
            .split(/[;,，；、]/)
            .map((item) => item.trim())
            .filter(Boolean)
        : value;
  }
}
