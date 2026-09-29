import type { BrowserToolGraphqlFieldDefinition, BrowserToolGraphqlFetchStep } from "./contracts";
import { applyBrowserToolTransforms } from "./transforms";

/**
 * 读取点路径（"data.user.result.rest_id"）；数字段作为数组下标，
 * 其余段作为对象键。路径不存在返回 undefined，不抛错。
 */
export function readJsonPath(root: unknown, path: string): unknown {
  if (!path) return undefined;
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 深度优先遍历所有对象节点；visitor 返回 true 时不再深入该节点的子树。 */
export function walkJson(root: unknown, visit: (node: Record<string, unknown>) => boolean | void): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      for (const item of current) if (item !== null && typeof item === "object") stack.push(item);
      continue;
    }
    if (!isPlainObject(current)) continue;
    const skipChildren = visit(current);
    if (skipChildren) continue;
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === "object") stack.push(child);
    }
  }
}

/** 遍历响应，取 match_key === match_value 节点上的 value_path（分页游标）。 */
export function extractGraphqlCursor(
  root: unknown,
  cursor: NonNullable<BrowserToolGraphqlFetchStep["cursor"]>
): string | null {
  let result: string | null = null;
  walkJson(root, (node) => {
    if (result !== null) return true;
    if (node[cursor.match_key] !== cursor.match_value) return false;
    const value = readJsonPath(node, cursor.value_path);
    if (typeof value === "string" && value) result = value;
    return true;
  });
  return result;
}

export type GraphqlExtractSpec = NonNullable<BrowserToolGraphqlFetchStep["extract"]>;

/**
 * 递归遍历响应，对每个存在 walk.has 点路径的节点按 fields 提取一条记录。
 * 字段值支持 fallback_paths 与 item_path（数组元素子路径）。
 */
export function extractGraphqlRecords(root: unknown, spec: GraphqlExtractSpec): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  walkJson(root, (node) => {
    if (readJsonPath(node, spec.walk?.has || "") === undefined) return false;
    const record: Record<string, unknown> = {};
    for (const [name, field] of Object.entries(spec.fields)) {
      const value = readGraphqlField(node, field);
      if (value === undefined) continue;
      record[name] = value;
    }
    if (Object.keys(record).length > 0) records.push(record);
    return true;
  });
  return records;
}

function readGraphqlField(node: Record<string, unknown>, field: BrowserToolGraphqlFieldDefinition): unknown {
  let raw: unknown = readJsonPath(node, field.path);
  if (raw === undefined && field.fallback_paths) {
    for (const fallback of field.fallback_paths) {
      raw = readJsonPath(node, fallback);
      if (raw !== undefined) break;
    }
  }
  if (raw === undefined) return undefined;

  if (field.item_path) {
    const itemPath = field.item_path;
    if (!Array.isArray(raw)) return undefined;
    const items = raw
      .map((item) => readJsonPath(item, itemPath))
      .filter((item): item is string | number => typeof item === "string" || typeof item === "number");
    if (items.length === 0) return undefined;
    return items.map((item) => applyBrowserToolTransforms(item, field.transforms));
  }

  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") return undefined;
  return applyBrowserToolTransforms(raw, field.transforms);
}

/**
 * state_read 的模板字段：{{ 字段名 }} 引用同记录已提取字段，
 * {{ __page_url }} 为当前页地址（不带尾斜杠）。
 */
export function resolveStateTemplate(template: string, record: Record<string, unknown>, pageUrl: string): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, name: string) => {
    if (name === "__page_url") return pageUrl.replace(/\/+$/, "");
    const value = record[name];
    if (value === undefined || value === null) throw new Error(`模板字段不存在：${name}`);
    return String(value);
  });
}

/** state_read 提取：路径字段走 JSON 提取，模板字段引用已提取的同记录字段组合。 */
export function extractStateRecords(
  root: unknown,
  spec: NonNullable<import("./contracts").BrowserToolStateReadStep["extract"]>,
  pageUrl: string
): Array<Record<string, unknown>> {
  const records = extractGraphqlRecords(root, {
    collection: spec.collection,
    walk: spec.walk,
    // 先只提取路径字段；模板字段在记录层二次解析。
    fields: Object.fromEntries(Object.entries(spec.fields).filter(([, field]) => field.path)) as NonNullable<GraphqlExtractSpec["fields"]>
  });
  for (const record of records) {
    for (const [name, field] of Object.entries(spec.fields)) {
      if (!field.template) continue;
      record[name] = applyBrowserToolTransforms(resolveStateTemplate(field.template, record, pageUrl), field.transforms);
    }
  }
  return records;
}
