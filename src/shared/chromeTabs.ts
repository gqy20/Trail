import { getDomain } from "./domain";
import type { GroupContext, ResearchTab } from "./types";

export function toResearchTab(tab: chrome.tabs.Tab, capturedAt = Date.now()): ResearchTab {
  return {
    id: tab.id,
    title: tab.title || tab.pendingUrl || tab.url || "Untitled",
    url: tab.url || tab.pendingUrl || "",
    domain: getDomain(tab.url || tab.pendingUrl),
    favIconUrl: tab.favIconUrl,
    groupId: tab.groupId,
    windowId: tab.windowId,
    capturedAt
  };
}

export async function getCurrentGroupContext(): Promise<GroupContext> {
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const windowId = activeTab?.windowId;

  if (!activeTab || activeTab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const tabs = windowId ? await chrome.tabs.query({ windowId }) : [];
    return {
      hasGroup: false,
      activeTab,
      windowId,
      tabs: tabs.map((tab) => toResearchTab(tab))
    };
  }

  const [group, tabs] = await Promise.all([
    chrome.tabGroups.get(activeTab.groupId),
    chrome.tabs.query({ windowId, groupId: activeTab.groupId })
  ]);

  return {
    hasGroup: true,
    group,
    activeTab,
    windowId,
    tabs: tabs.map((tab) => toResearchTab(tab))
  };
}

export async function collectWindowTabs(windowId: number): Promise<ResearchTab[]> {
  const tabs = await chrome.tabs.query({ windowId });
  return tabs.map((tab) => toResearchTab(tab));
}

export async function collectGroupTabs(windowId: number, groupId: number): Promise<ResearchTab[]> {
  const tabs = await chrome.tabs.query({ windowId, groupId });
  return tabs.map((tab) => toResearchTab(tab));
}
