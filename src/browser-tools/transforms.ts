import type { BrowserToolTransform, BrowserToolTransformSpec } from "./contracts";

export function applyBrowserToolTransforms(value: unknown, transforms: BrowserToolTransformSpec[] = []): unknown {
  return transforms.reduce<unknown>((current, transform) => applyTransform(current, transform), value);
}

function applyTransform(value: unknown, transform: BrowserToolTransformSpec): unknown {
  if (typeof transform === "object") {
    const match = String(value ?? "").match(transform.match);
    return match ? (match[1] ?? match[0]) : undefined;
  }
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
      // 数字时间戳：毫秒（≥1e12）原样，更小按秒换算（部分平台返回秒级时间戳）。
      const numeric = typeof value === "number" ? (value > 0 && value < 1e12 ? value * 1000 : value) : undefined;
      const time = numeric !== undefined ? numeric : Date.parse(String(value).trim());
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
