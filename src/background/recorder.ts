import {
  collectGroupTabs,
  collectWindowTabs,
  createNamedGroupFromCurrentSelection,
  getCurrentGroupContext,
  getUniqueGroupTitle,
  toResearchTab
} from "../shared/chromeTabs";
import { getDomain } from "../shared/domain";
import { isDomainExcluded, MAX_CONTEXT_TEXT_LENGTH, MAX_COPIED_TEXT_LENGTH, truncateText } from "../shared/interactions";
import { generateMockMarkdown } from "../shared/markdown";
import { getActiveSession, getInteractionSettings, getSessions, saveSession, setActiveSession } from "../shared/storage";
import type { CopyInteractionPayload, PopupState, TrailEvent, TrailEventType, TrailSession } from "../shared/types";

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
  const [activeSession, currentGroup, recentSessions, interactionSettings] = await Promise.all([
    getActiveSession(),
    getCurrentGroupContext(),
    getSessions(),
    getInteractionSettings()
  ]);

  return {
    activeSession,
    currentGroup,
    recentSessions: recentSessions.slice(0, 5),
    interactionSettings
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
  completed.updatedAt = completed.endedAt;
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
  completed.updatedAt = completed.endedAt;
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

export async function recordCopyInteraction(
  payload: CopyInteractionPayload,
  senderTab?: chrome.tabs.Tab
): Promise<{ recorded: boolean; eventId?: string; reason?: string }> {
  const [active, settings] = await Promise.all([getActiveSession(), getInteractionSettings()]);
  if (!active) return { recorded: false, reason: "no_active_session" };
  if (!settings.captureCopy) return { recorded: false, reason: "capture_disabled" };
  if (isDomainExcluded(payload.domain, settings.excludedDomains)) {
    return { recorded: false, reason: "domain_excluded" };
  }

  const tabId = senderTab?.id;
  const windowId = senderTab?.windowId;
  const groupId = senderTab?.groupId;
  const belongsToSession =
    active.source === "window"
      ? windowId === active.windowId
      : windowId === active.windowId && groupId === active.groupId;

  if (!belongsToSession) return { recorded: false, reason: "outside_session" };

  const selectedText = truncateText(payload.selectedText, MAX_COPIED_TEXT_LENGTH);
  if (!selectedText) return { recorded: false, reason: "empty_text" };

  const event: TrailEvent = {
    id: createId("event"),
    type: "text_copied",
    tabId,
    title: payload.pageTitle,
    url: payload.pageUrl,
    domain: payload.domain || getDomain(payload.pageUrl),
    timestamp: payload.timestamp || Date.now(),
    selectedText,
    textLength: payload.selectedText.length,
    privacyLevel: "safe"
  };

  if (settings.captureContext) {
    event.surroundingText = payload.surroundingText
      ? truncateText(payload.surroundingText, MAX_CONTEXT_TEXT_LENGTH)
      : undefined;
    event.sectionTitle = payload.sectionTitle ? truncateText(payload.sectionTitle, 120) : undefined;
    event.elementTag = payload.elementTag;
    event.elementRole = payload.elementRole;
    event.cssSelector = payload.cssSelector;
    event.viewportX = payload.viewportX;
    event.viewportY = payload.viewportY;
    event.pageX = payload.pageX;
    event.pageY = payload.pageY;
  }

  const nextTabs = senderTab ? uniqueTabs([...active.tabs, toResearchTab(senderTab)]) : active.tabs;
  await setActiveSession({
    ...active,
    tabs: nextTabs,
    events: [...active.events, event].slice(-300),
    updatedAt: Date.now()
  });

  return { recorded: true, eventId: event.id };
}

export async function deleteActiveEvent(eventId: string): Promise<{ deleted: boolean }> {
  const active = await getActiveSession();
  if (!active) return { deleted: false };

  const nextEvents = active.events.filter((event) => event.id !== eventId);
  if (nextEvents.length === active.events.length) return { deleted: false };

  await setActiveSession({
    ...active,
    events: nextEvents,
    updatedAt: Date.now()
  });

  return { deleted: true };
}
