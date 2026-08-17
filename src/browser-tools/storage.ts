import type { BrowserToolRunRecord, BrowserToolRunResult, StoredBrowserTool } from "./contracts";

const TOOLS_KEY = "trail.browserTools";
const RUNS_KEY = "trail.browserToolRuns";
const MAX_TOOLS = 50;
const MAX_RUNS = 20;
const MAX_SAVED_RECORDS_PER_COLLECTION = 200;
const MAX_SAVED_TEXT_LENGTH = 2_000;

export async function getStoredBrowserTools(): Promise<StoredBrowserTool[]> {
  const result = await chrome.storage.local.get(TOOLS_KEY);
  return (result[TOOLS_KEY] as StoredBrowserTool[] | undefined) || [];
}

export async function getStoredBrowserTool(toolId: string): Promise<StoredBrowserTool | undefined> {
  return (await getStoredBrowserTools()).find((tool) => tool.id === toolId);
}

export async function saveStoredBrowserTool(tool: StoredBrowserTool): Promise<void> {
  const tools = await getStoredBrowserTools();
  const next = [tool, ...tools.filter((item) => item.id !== tool.id)].slice(0, MAX_TOOLS);
  await chrome.storage.local.set({ [TOOLS_KEY]: next });
}

export async function replaceStoredBrowserTools(tools: StoredBrowserTool[]): Promise<void> {
  await chrome.storage.local.set({ [TOOLS_KEY]: tools.slice(0, MAX_TOOLS) });
}

export async function deleteStoredBrowserTool(toolId: string): Promise<void> {
  const tools = await getStoredBrowserTools();
  await chrome.storage.local.set({ [TOOLS_KEY]: tools.filter((tool) => tool.id !== toolId) });
}

export async function getBrowserToolRuns(): Promise<BrowserToolRunRecord[]> {
  const result = await chrome.storage.local.get(RUNS_KEY);
  return (result[RUNS_KEY] as BrowserToolRunRecord[] | undefined) || [];
}

export async function saveBrowserToolRun(result: BrowserToolRunResult, toolName: string): Promise<BrowserToolRunRecord> {
  const runs = await getBrowserToolRuns();
  const record: BrowserToolRunRecord = {
    ...result,
    data: compactData(result.data),
    toolName,
    savedAt: Date.now()
  };
  await chrome.storage.local.set({ [RUNS_KEY]: [record, ...runs].slice(0, MAX_RUNS) });
  return record;
}

function compactData(data: BrowserToolRunResult["data"]): BrowserToolRunResult["data"] {
  return Object.fromEntries(
    Object.entries(data).map(([collection, records]) => [
      collection,
      records.slice(0, MAX_SAVED_RECORDS_PER_COLLECTION).map((record) =>
        Object.fromEntries(Object.entries(record).map(([key, value]) => [key, compactValue(value)]))
      )
    ])
  );
}

function compactValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, MAX_SAVED_TEXT_LENGTH);
  if (Array.isArray(value)) return value.slice(0, 100).map(compactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, compactValue(item)]));
  }
  return value;
}
