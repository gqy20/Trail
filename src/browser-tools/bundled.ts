import { parseDocument } from "yaml";
import type { StoredBrowserTool } from "./contracts";
import { parseBrowserToolYaml } from "./loader";
import { getStoredBrowserTools, replaceStoredBrowserTools } from "./storage";

const BUNDLED_YAML_MODULES = import.meta.glob("../../browser-tools/**/*.yml", {
  eager: true,
  import: "default",
  query: "?raw"
}) as Record<string, string>;

const CATALOG_MODULE_PATH = "../../browser-tools/catalog.yml";
const CATALOG_PATH_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*\.ya?ml$/;

type BrowserToolCatalog = {
  schema_version: 1;
  version: number;
  tools: Array<{ path: string; enabled: boolean }>;
};

export type BundledBrowserToolImportResult = {
  unchanged: number;
  customPreserved: number;
  installed: number;
  updated: number;
  preserved: number;
  disabled: number;
};

export async function importBundledBrowserTools(): Promise<BundledBrowserToolImportResult> {
  const catalog = readCatalog();
  const currentTools = await getStoredBrowserTools();
  const currentById = new Map(currentTools.map((tool) => [tool.id, tool]));
  const nextBundled: StoredBrowserTool[] = [];
  const bundledIds = new Set<string>();
  const result: BundledBrowserToolImportResult = { installed: 0, updated: 0, preserved: 0, disabled: 0, unchanged: 0, customPreserved: 0 };
  const now = Date.now();

  for (const entry of catalog.tools) {
    const yaml = readBundledYaml(entry.path);
    const definition = parseBrowserToolYaml(yaml);
    if (bundledIds.has(definition.id)) throw new Error(`Browser Tool 清单包含重复工具 id：${definition.id}`);
    bundledIds.add(definition.id);

    if (!entry.enabled) {
      result.disabled += 1;
      continue;
    }

    const current = currentById.get(definition.id);
    currentById.delete(definition.id);

    if (current && !current.source && current.yaml === yaml) {
      nextBundled.push({ ...current, source: { type: "bundled", catalogVersion: catalog.version } });
      result.preserved += 1;
      result.unchanged += 1;
      continue;
    }

    if (current && current.source?.type !== "bundled") {
      nextBundled.push(current);
      result.preserved += 1;
      result.customPreserved += 1;
      continue;
    }

    if (current?.yaml === yaml) {
      nextBundled.push({ ...current, source: { type: "bundled", catalogVersion: catalog.version } });
      result.preserved += 1;
      result.unchanged += 1;
      continue;
    }

    nextBundled.push({
      id: definition.id,
      enabled: current?.enabled !== false,
      yaml,
      definition,
      importedAt: current?.importedAt || now,
      updatedAt: now,
      source: { type: "bundled", catalogVersion: catalog.version }
    });
    current ? result.updated += 1 : result.installed += 1;
  }

  // 无变化时不写存储：SW 每次唤醒都会跑自动同步，避免无谓的存储写放大。
  if (result.installed + result.updated > 0) {
    await replaceStoredBrowserTools([...nextBundled, ...currentById.values()]);
  }
  return result;
}

export function getBundledToolVersions(): Record<string, string> {
  return Object.fromEntries(readCatalog().tools.filter((entry) => entry.enabled).map((entry) => {
    const definition = parseBrowserToolYaml(readBundledYaml(entry.path));
    return [definition.id, definition.version];
  }));
}

export async function restoreBundledBrowserTool(toolId: string): Promise<void> {
  const catalog = readCatalog();
  const entry = catalog.tools.filter((entry) => entry.enabled).map((entry) => {
    const yaml = readBundledYaml(entry.path);
    return { yaml, definition: parseBrowserToolYaml(yaml) };
  }).find((entry) => entry.definition.id === toolId);
  if (!entry) throw new Error("没有对应的内置工具。");
  const tools = await getStoredBrowserTools();
  const current = tools.find((tool) => tool.id === toolId);
  if (!current && tools.length >= 50) throw new Error("工具已达数量上限，无法添加内置工具。");
  const now = Date.now();
  if (current && current.source?.type !== "bundled") {
    if (tools.length >= 50) throw new Error("工具已达数量上限，无法保存自定义备份。");
    const document = parseDocument(current.yaml);
    const backupId = `${toolId.slice(0, 40)}.backup-${crypto.randomUUID().slice(0, 8)}`;
    document.set("id", backupId);
    document.set("name", `${current.definition.name}（自定义备份）`);
    const yaml = document.toString();
    tools.push({ ...current, id: backupId, yaml, definition: parseBrowserToolYaml(yaml), updatedAt: now, source: { type: "user", backupOf: toolId } });
  }
  await replaceStoredBrowserTools([
    { id: toolId, ...entry, enabled: current?.enabled !== false, importedAt: current?.importedAt || now, updatedAt: now, source: { type: "bundled", catalogVersion: catalog.version } },
    ...tools.filter((tool) => tool.id !== toolId)
  ]);
}

function readCatalog(): BrowserToolCatalog {
  const source = BUNDLED_YAML_MODULES[CATALOG_MODULE_PATH];
  if (!source) throw new Error("没有找到 browser-tools/catalog.yml。");
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) throw new Error(document.errors[0].message);
  const value = document.toJS({ maxAliasCount: 10 }) as Record<string, unknown>;
  if (value.schema_version !== 1) throw new Error("Browser Tool 清单只支持 schema_version: 1。");
  if (!Number.isInteger(value.version) || Number(value.version) < 1) throw new Error("Browser Tool 清单 version 必须是正整数。");
  if (!Array.isArray(value.tools)) throw new Error("Browser Tool 清单 tools 必须是数组。");

  const paths = new Set<string>();
  const tools = value.tools.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Browser Tool 清单 tools[${index}] 无效。`);
    const entry = raw as Record<string, unknown>;
    if (typeof entry.path !== "string" || !CATALOG_PATH_PATTERN.test(entry.path) || entry.path.includes("..") || entry.path.startsWith("/")) {
      throw new Error(`Browser Tool 清单 tools[${index}].path 无效。`);
    }
    if (paths.has(entry.path)) throw new Error(`Browser Tool 清单包含重复路径：${entry.path}`);
    paths.add(entry.path);
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") throw new Error(`Browser Tool 清单 tools[${index}].enabled 必须是布尔值。`);
    return { path: entry.path, enabled: entry.enabled !== false };
  });

  return { schema_version: 1, version: Number(value.version), tools };
}

function readBundledYaml(path: string): string {
  const modulePath = `../../browser-tools/${path}`;
  const source = BUNDLED_YAML_MODULES[modulePath];
  if (!source) throw new Error(`Browser Tool 清单引用的文件不存在：${path}`);
  return source;
}
