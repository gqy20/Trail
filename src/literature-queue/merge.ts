import type { LiteratureQueue } from "./types";

/** 合并提取结果时补全全文入口，不覆盖已完成、失败或人工筛选状态。 */
export function mergeLiteratureQueues(current: LiteratureQueue | undefined, imported: LiteratureQueue): LiteratureQueue {
  if (!current) return imported;
  const items = new Map(current.items.map((item) => [item.id, item]));
  for (const item of imported.items) {
    const existing = items.get(item.id);
    items.set(item.id, existing ? {
      ...existing,
      doi: existing.doi || item.doi,
      pdfUrl: existing.pdfUrl || item.pdfUrl,
      downloadUrl: existing.downloadUrl || item.downloadUrl
    } : item);
  }
  return { ...current, updatedAt: Date.now(), sourceRows: current.sourceRows + imported.sourceRows, items: [...items.values()] };
}
