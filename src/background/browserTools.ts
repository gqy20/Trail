import type { BrowserToolRunResult, ExecuteBrowserToolMessage } from "../browser-tools/contracts";
import { parseBrowserToolYaml } from "../browser-tools/loader";
import { matchesBrowserTool } from "../browser-tools/matcher";

export function validateBrowserToolYaml(source: string) {
  return parseBrowserToolYaml(source);
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
  return response as BrowserToolRunResult;
}

async function getTargetTab(tabId?: number): Promise<chrome.tabs.Tab> {
  if (tabId !== undefined) return chrome.tabs.get(tabId);
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!activeTab) throw new Error("没有找到当前活动标签页。");
  return activeTab;
}
