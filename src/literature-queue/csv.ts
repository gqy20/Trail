import type { LiteratureDecision, LiteratureQueue, LiteratureQueueItem } from "./types";

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/i;

const HEADER_ALIASES = {
  title: ["title", "文献标题", "题名", "标题"],
  doi: ["doi"],
  pdfUrl: ["pdf_url", "pdfurl", "pdf link", "pdf链接"],
  downloadUrl: ["download_url", "downloadurl", "download link", "下载链接"],
  decision: ["decision", "决定", "筛选结果", "纳入状态"],
  pdfPath: ["pdf_path", "pdfpath", "本地路径"],
  downloadStatus: ["download_status", "downloadstatus", "下载状态"]
} as const;

export function parseLiteratureCsv(source: string, sourceName: string): LiteratureQueue {
  const rows = parseCsv(source.replace(/^\uFEFF/, ""));
  if (rows.length < 2) throw new Error("CSV 没有可导入的文献记录。");
  const headers = rows[0].map(normalizeHeader);
  const indexes = Object.fromEntries(
    Object.entries(HEADER_ALIASES).map(([name, aliases]) => [
      name,
      headers.findIndex((header) => aliases.some((alias) => normalizeHeader(alias) === header))
    ])
  ) as Record<keyof typeof HEADER_ALIASES, number>;
  if (indexes.title < 0) throw new Error("CSV 必须包含 title、文献标题或题名列。");

  const byKey = new Map<string, LiteratureQueueItem>();
  let sourceRows = 0;
  for (const row of rows.slice(1)) {
    const title = cell(row, indexes.title);
    if (!title) continue;
    sourceRows += 1;
    const doi = normalizeDoi(cell(row, indexes.doi));
    const key = doi ? `doi:${doi.toLowerCase()}` : `title:${normalizeTitle(title)}`;
    const existing = byKey.get(key);
    const decision = normalizeDecision(cell(row, indexes.decision));
    const pdfUrl = normalizeHttpUrl(cell(row, indexes.pdfUrl));
    const downloadUrl = normalizeHttpUrl(cell(row, indexes.downloadUrl));
    const existingPath = cell(row, indexes.pdfPath);
    const existingStatus = cell(row, indexes.downloadStatus).toLowerCase();

    if (existing) {
      existing.sourceRows += 1;
      if (!existing.doi && doi) existing.doi = doi;
      if (!existing.pdfUrl && pdfUrl) existing.pdfUrl = pdfUrl;
      if (!existing.downloadUrl && downloadUrl) existing.downloadUrl = downloadUrl;
      if (decision === "include") existing.decision = "include";
      continue;
    }

    byKey.set(key, {
      id: createItemId(key),
      title,
      doi: doi || undefined,
      pdfUrl: pdfUrl || undefined,
      downloadUrl: downloadUrl || undefined,
      decision,
      sourceRows: 1,
      status: existingPath || existingStatus === "completed"
        ? "completed"
        : pdfUrl || downloadUrl || doi
          ? "pending"
          : "needs_search",
      filename: existingPath || undefined
    });
  }

  if (byKey.size === 0) throw new Error("CSV 中没有有效题名。");
  const now = Date.now();
  return {
    sourceName,
    importedAt: now,
    updatedAt: now,
    sourceRows,
    items: [...byKey.values()]
  };
}

export function parseCsv(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cellValue = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        cellValue += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (character === "," && !quoted) {
      row.push(cellValue);
      cellValue = "";
      continue;
    }
    if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      row.push(cellValue);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cellValue = "";
      continue;
    }
    cellValue += character;
  }
  row.push(cellValue);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function cell(row: string[], index: number): string {
  return index < 0 ? "" : String(row[index] || "").trim();
}

function normalizeHeader(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function normalizeTitle(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizeDoi(value: string): string {
  const doi = value.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "").trim();
  return DOI_PATTERN.test(doi) ? doi : "";
}

function normalizeHttpUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function normalizeDecision(value: string): LiteratureDecision {
  const normalized = value.trim().toLowerCase();
  if (["include", "included", "纳入", "是"].includes(normalized)) return "include";
  if (["maybe", "待定", "可能", "复核"].includes(normalized)) return "maybe";
  return "other";
}

function createItemId(key: string): string {
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `literature-${(hash >>> 0).toString(36)}`;
}
