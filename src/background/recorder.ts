import {
  collectGroupTabs,
  collectWindowTabs,
  createNamedGroupFromCurrentSelection,
  getCurrentGroupContext,
  getUniqueGroupTitle,
  toResearchTab
} from "../shared/chromeTabs";
import { getDomain } from "../shared/domain";
import { generateMockMarkdown } from "../shared/markdown";
import { getActiveSession, getSessions, saveSession, setActiveSession } from "../shared/storage";
import type { PopupState, TrailEvent, TrailEventType, TrailSession } from "../shared/types";

function createId(prefix: string): string {
  return `${prefix}_${Date.now()}_${crypto.randomUUID()}`;
}

function createEvent(type: TrailEventType, tab?: chrome.tabs.Tab): TrailEvent {
  return {
    id: createId("event"),
    type,
    tabId: tab?.id,
    title: tab?.title || tab?.pendingUrl || tab?.url,
    url: tab?.url || tab?.pendingUrl,
    domain: getDomain(tab?.url || tab?.pendingUrl),
    timestamp: Date.now()
  };
}

function uniqueTabs(tabs: TrailSession["tabs"]): TrailSession["tabs"] {
  const byUrl = new Map<string, TrailSession["tabs"][number]>();

  for (const tab of tabs) {
    const key = tab.url || `${tab.id || "unknown"}-${tab.title}`;
    byUrl.set(key, tab);
  }

  return [...byUrl.values()];
}

function eventsFromTabs(tabs: TrailSession["tabs"]): TrailEvent[] {
  return tabs.map((tab) => ({
    id: createId("event"),
    type: "created",
    tabId: tab.id,
    title: tab.title,
    url: tab.url,
    domain: tab.domain,
    timestamp: tab.capturedAt
  }));
}

export async function getPopupState(): Promise<PopupState> {
  const [activeSession, currentGroup, recentSessions] = await Promise.all([
    getActiveSession(),
    getCurrentGroupContext(),
    getSessions()
  ]);

  return {
    activeSession,
    currentGroup,
    recentSessions: recentSessions.slice(0, 5)
  };
}

export async function startGroupRecording(name?: string): Promise<TrailSession> {
  const context = await getCurrentGroupContext();

  if (!context.hasGroup || !context.group || !context.windowId) {
    throw new Error("当前标签页不在任何分组中。");
  }

  const requestedName = name?.trim() || context.group.title || "未命名研究记录";
  const sessionName = await getUniqueGroupTitle(context.windowId, requestedName, context.group.id);
  const group = await chrome.tabGroups.update(context.group.id, { title: sessionName });
  const tabs = await collectGroupTabs(context.windowId, context.group.id);

  const session: TrailSession = {
    id: createId("session"),
    source: "tab_group",
    name: sessionName,
    groupId: group?.id || context.group.id,
    groupTitle: group?.title || sessionName,
    groupColor: group?.color || context.group.color,
    windowId: context.windowId,
    status: "recording",
    startedAt: Date.now(),
    tabs,
    events: eventsFromTabs(tabs)
  };

  await setActiveSession(session);
  return session;
}

export async function startNewGroupRecording(name?: string): Promise<TrailSession> {
  const requestedName = name?.trim() || "研究记录";
  const group = await createNamedGroupFromCurrentSelection(requestedName);
  const sessionName = group.title || requestedName;
  const tabs = await collectGroupTabs(group.windowId, group.id);

  const session: TrailSession = {
    id: createId("session"),
    source: "tab_group",
    name: sessionName,
    groupId: group.id,
    groupTitle: sessionName,
    groupColor: group.color,
    windowId: group.windowId,
    status: "recording",
    startedAt: Date.now(),
    tabs,
    events: eventsFromTabs(tabs)
  };

  await setActiveSession(session);
  return session;
}

export async function startWindowRecording(name?: string): Promise<TrailSession> {
  const context = await getCurrentGroupContext();
  const windowId = context.windowId;

  if (!windowId) {
    throw new Error("没有找到当前浏览器窗口。");
  }

  const tabs = await collectWindowTabs(windowId);
  const session: TrailSession = {
    id: createId("session"),
    source: "window",
    name: name?.trim() || "窗口研究记录",
    windowId,
    status: "recording",
    startedAt: Date.now(),
    tabs,
    events: eventsFromTabs(tabs)
  };

  await setActiveSession(session);
  return session;
}

export async function stopRecording(): Promise<TrailSession | undefined> {
  const active = await getActiveSession();

  if (!active) return undefined;

  const freshTabs =
    active.source === "tab_group" && active.groupId !== undefined
      ? await collectGroupTabs(active.windowId, active.groupId)
      : await collectWindowTabs(active.windowId);

  const completed: TrailSession = {
    ...active,
    status: "completed",
    endedAt: Date.now(),
    tabs: uniqueTabs([...active.tabs, ...freshTabs])
  };

  completed.markdown = generateMockMarkdown(completed);
  await saveSession(completed);
  await setActiveSession(undefined);
  return completed;
}

export async function generateFromCurrentGroup(name?: string): Promise<TrailSession> {
  const session = await startGroupRecording(name);
  return finalizeSnapshot(session);
}

export async function generateFromCurrentWindow(name?: string): Promise<TrailSession> {
  const session = await startWindowRecording(name);
  return finalizeSnapshot(session);
}

async function finalizeSnapshot(session: TrailSession): Promise<TrailSession> {
  const completed: TrailSession = {
    ...session,
    status: "completed",
    endedAt: Date.now()
  };
  completed.markdown = generateMockMarkdown(completed);
  await saveSession(completed);
  await setActiveSession(undefined);
  return completed;
}

export async function recordTabEvent(type: TrailEventType, tabId: number, tab?: chrome.tabs.Tab): Promise<void> {
  const active = await getActiveSession();
  if (!active) return;

  const currentTab = tab || (await chrome.tabs.get(tabId).catch(() => undefined));
  if (!currentTab) return;

  const belongsToSession =
    active.source === "window"
      ? currentTab.windowId === active.windowId
      : currentTab.windowId === active.windowId && currentTab.groupId === active.groupId;

  if (!belongsToSession) return;

  const next: TrailSession = {
    ...active,
    tabs: uniqueTabs([...active.tabs, toResearchTab(currentTab)]),
    events: [...active.events, createEvent(type, currentTab)].slice(-200)
  };

  await setActiveSession(next);
}

export async function recordGroupUpdate(group: chrome.tabGroups.TabGroup): Promise<void> {
  const active = await getActiveSession();
  if (!active || active.source !== "tab_group" || active.groupId !== group.id) return;

  await setActiveSession({
    ...active,
    groupTitle: group.title,
    groupColor: group.color,
    name: active.name || group.title || "未命名研究记录",
    events: [
      ...active.events,
      {
        id: createId("event"),
        type: "group_updated" as const,
        title: group.title || "分组已更新",
        timestamp: Date.now()
      }
    ].slice(-200)
  });
}
