import type {
  BrowserToolManagerState,
  BrowserToolRunResult,
  ExecuteBrowserToolMessage,
  StoredBrowserTool
} from "../browser-tools/contracts";
import { parseBrowserToolYaml } from "../browser-tools/loader";
import { matchesBrowserTool } from "../browser-tools/matcher";
import {
  deleteStoredBrowserTool,
  getBrowserToolRuns,
  getStoredBrowserTool,
  getStoredBrowserTools,
  saveBrowserToolRun,
  saveStoredBrowserTool
} from "../browser-tools/storage";

export function validateBrowserToolYaml(source: string) {
  return parseBrowserToolYaml(source);
}

export async function importBrowserTool(yaml: string): Promise<StoredBrowserTool> {
  const definition = parseBrowserToolYaml(yaml);
  const current = await getStoredBrowserTool(definition.id);
  const now = Date.now();
  const tool: StoredBrowserTool = {
    id: definition.id,
    yaml,
    definition,
    importedAt: current?.importedAt || now,
    updatedAt: now
  };
  await saveStoredBrowserTool(tool);
  return tool;
}

export async function removeBrowserTool(toolId: string): Promise<void> {
  await deleteStoredBrowserTool(toolId);
}

export async function getBrowserToolManagerState(tabId?: number): Promise<BrowserToolManagerState> {
  const [tools, recentRuns, targetTab] = await Promise.all([
    getStoredBrowserTools(),
    getBrowserToolRuns(),
    getTargetTab(tabId).catch(() => undefined)
  ]);
  const pageUrl = targetTab?.url;

  return {
    tools,
    recentRuns,
    targetTab:
      targetTab?.id !== undefined && pageUrl
        ? { id: targetTab.id, title: targetTab.title || pageUrl, url: pageUrl }
        : undefined,
    matchedToolIds: pageUrl ? tools.filter((tool) => matchesBrowserTool(tool.definition, pageUrl)).map((tool) => tool.id) : []
  };
}

export async function runStoredBrowserTool(input: {
  toolId: string;
  parameters: Record<string, unknown>;
  tabId?: number;
  userInitiated?: boolean;
}): Promise<BrowserToolRunResult> {
  const tool = await getStoredBrowserTool(input.toolId);
  if (!tool) throw new Error(`没有找到 Browser Tool：${input.toolId}`);
  return runBrowserTool({ ...input, yaml: tool.yaml });
}

export async function runBrowserTool(input: {
  yaml: string;
  parameters: Record<string, unknown>;
  tabId?: number;
  userInitiated?: boolean;
}): Promise<BrowserToolRunResult> {
  const definition = parseBrowserToolYaml(input.yaml);
  if (definition.limits?.require_user_activation !== false && input.userInitiated !== true) {
    throw new Error("该 Browser Tool 必须由用户主动启动。");
  }

  const tab = await getTargetTab(input.tabId);
  if (tab.id === undefined || !tab.url) throw new Error("没有找到可运行 Browser Tool 的网页标签页。");
  if (!/^https?:/i.test(tab.url)) throw new Error("Browser Tool 只能在普通 HTTP(S) 页面运行。");
  if (!matchesBrowserTool(definition, tab.url)) throw new Error(`工具 ${definition.id} 不适用于当前页面。`);

  const message: ExecuteBrowserToolMessage = {
    type: "EXECUTE_BROWSER_TOOL",
    definition,
    parameters: input.parameters
  };
  const response = await chrome.tabs.sendMessage<ExecuteBrowserToolMessage, BrowserToolRunResult | { error: string }>(tab.id, message);
  if (response && "error" in response && !("status" in response)) throw new Error(response.error);
  const result = response as BrowserToolRunResult;
  try {
    await saveBrowserToolRun(result, definition.name);
    return result;
  } catch {
    return {
      ...result,
      warnings: [...result.warnings, "运行已完成，但结果未能写入本地历史记录。"]
    };
  }
}

async function getTargetTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (tabId !== undefined) return chrome.tabs.get(tabId);
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) throw new Error("没有找到当前活动标签页。");
  return activeTab;
}
