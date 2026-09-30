import {
  collectGroupTabs,
  collectWindowTabs,
  createNamedGroupFromCurrentSelection,
  getCurrentGroupContext,
  getUniqueGroupTitle,
  toResearchTab
} from "../shared/chromeTabs";
import { getDomain } from "../shared/domain";
import {
  classifyCopiedText,
  isDomainExcluded,
  isSameCopiedText,
  MAX_CONTEXT_TEXT_LENGTH,
  MAX_COPIED_TEXT_LENGTH,
  redactSensitiveText,
  truncateText
} from "../shared/interactions";
import { generateMockMarkdown } from "../shared/markdown";
import { getActiveSession, getInteractionSettings, getSessions, saveSession, setActiveSession } from "../shared/storage";
import type {
  CopyInteractionPayload,
  LinkClickPayload,
  PopupState,
  ResearchTab,
  TrailEvent,
  TrailEventType,
  TrailPageStat,
  TrailSession
} from "../shared/types";

let activeAttentionTimer: { sessionId: string; url: string; startedAt: number } | undefined;

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

function initialPageStats(tabs: ResearchTab[]): TrailPageStat[] {
  return tabs.map((tab) =>
    scorePageStat({
      url: tab.url,
      domain: tab.domain,
      title: tab.title,
      firstSeenAt: tab.capturedAt,
      lastSeenAt: tab.capturedAt,
      activeMs: 0,
      visitCount: 1,
      selectedCount: 0,
      copiedCount: 0,
      outboundClickCount: 0,
      score: 0,
      level: "passing"
    })
  );
}

function scorePageStat(stat: TrailPageStat): TrailPageStat {
  const activeMinutes = Math.min(30, Math.floor(stat.activeMs / 60000));
  const score =
    activeMinutes * 1 +
    stat.selectedCount * 3 +
    stat.copiedCount * 6 +
    stat.outboundClickCount * 2 +
    Math.max(0, stat.visitCount - 1) * 2;

  return {
    ...stat,
    score,
    level: score >= 12 ? "core" : score >= 5 ? "reference" : "passing"
  };
}

function updatePageStats(
  session: TrailSession,
  page: { url?: string; domain?: string; title?: string; timestamp?: number },
  increment: Partial<Pick<TrailPageStat, "visitCount" | "selectedCount" | "copiedCount" | "outboundClickCount">> & {
    activeMs?: number;
  } = {}
): TrailPageStat[] {
  const url = page.url || "";
  if (!url) return session.pageStats || [];

  const timestamp = page.timestamp || Date.now();
  const domain = page.domain || getDomain(url);
  const title = page.title || url;
  const stats = [...(session.pageStats || [])];
  const index = stats.findIndex((item) => item.url === url);
  const current =
    index >= 0
      ? stats[index]
      : {
          url,
          domain,
          title,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          activeMs: 0,
          visitCount: 0,
          selectedCount: 0,
          copiedCount: 0,
          outboundClickCount: 0,
          score: 0,
          level: "passing" as const
        };

  const next = scorePageStat({
    ...current,
    domain: current.domain || domain,
    title: title || current.title,
    lastSeenAt: Math.max(current.lastSeenAt, timestamp),
    activeMs: current.activeMs + (increment.activeMs || 0),
    visitCount: current.visitCount + (increment.visitCount || 0),
    selectedCount: current.selectedCount + (increment.selectedCount || 0),
    copiedCount: current.copiedCount + (increment.copiedCount || 0),
    outboundClickCount: current.outboundClickCount + (increment.outboundClickCount || 0)
  });

  if (index >= 0) stats[index] = next;
  else stats.push(next);

  return stats;
}

function beginAttentionTimer(session: TrailSession, tab?: chrome.tabs.Tab): void {
  if (!tab?.url) return;
  activeAttentionTimer = {
    sessionId: session.id,
    url: tab.url,
    startedAt: Date.now()
  };
}

function settleAttentionTimer(session: TrailSession): TrailSession {
  if (!activeAttentionTimer || activeAttentionTimer.sessionId !== session.id) return session;

  const activeMs = Math.max(0, Date.now() - activeAttentionTimer.startedAt);
  const pageStats = updatePageStats(session, { url: activeAttentionTimer.url }, { activeMs });
  activeAttentionTimer = undefined;

  return {
    ...session,
    pageStats
  };
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
    events: eventsFromTabs(tabs),
    pageStats: initialPageStats(tabs)
  };

  await setActiveSession(session);
  beginAttentionTimer(session, context.activeTab);
  return session;
}

export async function startNewGroupRecording(name?: string, tabIds?: number[]): Promise<TrailSession> {
  const requestedName = name?.trim() || "研究记录";
  const group = await createNamedGroupFromCurrentSelection(requestedName, tabIds);
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
    events: eventsFromTabs(tabs),
    pageStats: initialPageStats(tabs)
  };

  await setActiveSession(session);
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  beginAttentionTimer(session, activeTab);
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
    events: eventsFromTabs(tabs),
    pageStats: initialPageStats(tabs)
  };

  await setActiveSession(session);
  beginAttentionTimer(session, context.activeTab);
  return session;
}

export async function stopRecording(): Promise<TrailSession | undefined> {
  const active = await getActiveSession();

  if (!active) return undefined;

  const settled = settleAttentionTimer(active);
  const freshTabs =
    settled.source === "tab_group" && settled.groupId !== undefined
      ? await collectGroupTabs(settled.windowId, settled.groupId)
      : await collectWindowTabs(settled.windowId);

  const completed: TrailSession = {
    ...settled,
    status: "completed",
    endedAt: Date.now(),
    tabs: uniqueTabs([...settled.tabs, ...freshTabs])
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
  let active = await getActiveSession();
  if (!active) return;

  const currentTab = tab || (await chrome.tabs.get(tabId).catch(() => undefined));
  if (!currentTab) return;

  const belongsToSession =
    active.source === "window"
      ? currentTab.windowId === active.windowId
      : currentTab.windowId === active.windowId && currentTab.groupId === active.groupId;

  if (!belongsToSession) return;

  if (type === "activated") {
    active = settleAttentionTimer(active);
    beginAttentionTimer(active, currentTab);
  }

  const next: TrailSession = {
    ...active,
    tabs: uniqueTabs([...active.tabs, toResearchTab(currentTab)]),
    events: [...active.events, createEvent(type, currentTab)].slice(-200),
    pageStats: updatePageStats(
      active,
      {
        url: currentTab.url || currentTab.pendingUrl,
        domain: getDomain(currentTab.url || currentTab.pendingUrl),
        title: currentTab.title || currentTab.pendingUrl || currentTab.url,
        timestamp: Date.now()
      },
      type === "activated" ? { visitCount: 1 } : {}
    )
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

  const rawSelectedText = truncateText(payload.selectedText, MAX_COPIED_TEXT_LENGTH);
  const redaction = settings.redactSensitive ? redactSensitiveText(rawSelectedText) : { text: rawSelectedText, redacted: false };
  const selectedText = redaction.text;
  if (!selectedText) return { recorded: false, reason: "empty_text" };

  const existingCopyEvent = settings.mergeDuplicates
    ? active.events.find(
        (event) =>
          (event.type === "text_copied" || event.type === "text_selected") &&
          event.url === payload.pageUrl &&
          isSameCopiedText(event.selectedText, selectedText)
      )
    : undefined;

  if (existingCopyEvent) {
    const mergedContext = payload.surroundingText
      ? settings.redactSensitive
        ? redactSensitiveText(truncateText(payload.surroundingText, MAX_CONTEXT_TEXT_LENGTH)).text
        : truncateText(payload.surroundingText, MAX_CONTEXT_TEXT_LENGTH)
      : undefined;
    const nextEvents = active.events.map((event) =>
      event.id === existingCopyEvent.id
        ? {
            ...event,
            type: "text_copied" as const,
            timestamp: payload.timestamp || Date.now(),
            duplicateCount: event.type === "text_selected" ? event.duplicateCount || 1 : (event.duplicateCount || 1) + 1,
            firstCopiedAt: event.firstCopiedAt || event.timestamp,
            privacyLevel: redaction.redacted ? "redacted" : event.privacyLevel || "safe",
            copyKind: event.copyKind || classifyCopiedText(selectedText, payload.elementTag),
            sectionTitle: event.sectionTitle || payload.sectionTitle,
            surroundingText: event.surroundingText || mergedContext
          }
        : event
    );

    await setActiveSession({
      ...active,
      events: nextEvents,
      pageStats: updatePageStats(
        active,
        { url: payload.pageUrl, domain: payload.domain, title: payload.pageTitle, timestamp: payload.timestamp },
        { copiedCount: existingCopyEvent.type === "text_selected" ? 1 : 0 }
      ),
      updatedAt: Date.now()
    });

    return { recorded: true, eventId: existingCopyEvent.id, reason: "merged_duplicate" };
  }

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
    privacyLevel: redaction.redacted ? "redacted" : "safe",
    copyKind: classifyCopiedText(selectedText, payload.elementTag),
    duplicateCount: 1
  };

  if (settings.captureContext) {
    event.surroundingText = payload.surroundingText
      ? settings.redactSensitive
        ? redactSensitiveText(truncateText(payload.surroundingText, MAX_CONTEXT_TEXT_LENGTH)).text
        : truncateText(payload.surroundingText, MAX_CONTEXT_TEXT_LENGTH)
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
    pageStats: updatePageStats(
      active,
      { url: payload.pageUrl, domain: payload.domain, title: payload.pageTitle, timestamp: payload.timestamp },
      { copiedCount: 1 }
    ),
    updatedAt: Date.now()
  });

  return { recorded: true, eventId: event.id };
}

export async function recordSelectionInteraction(
  payload: CopyInteractionPayload,
  senderTab?: chrome.tabs.Tab
): Promise<{ recorded: boolean; eventId?: string; reason?: string }> {
  const [active, settings] = await Promise.all([getActiveSession(), getInteractionSettings()]);
  if (!active) return { recorded: false, reason: "no_active_session" };
  if (!settings.captureSelection) return { recorded: false, reason: "selection_disabled" };
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

  const rawSelectedText = truncateText(payload.selectedText, MAX_COPIED_TEXT_LENGTH);
  const redaction = settings.redactSensitive ? redactSensitiveText(rawSelectedText) : { text: rawSelectedText, redacted: false };
  const selectedText = redaction.text;
  if (!selectedText) return { recorded: false, reason: "empty_text" };

  const existingEvent = active.events.find(
    (event) =>
      (event.type === "text_selected" || event.type === "text_copied") &&
      event.url === payload.pageUrl &&
      isSameCopiedText(event.selectedText, selectedText)
  );

  if (existingEvent) return { recorded: true, eventId: existingEvent.id, reason: "already_recorded" };

  const event: TrailEvent = {
    id: createId("event"),
    type: "text_selected",
    tabId,
    title: payload.pageTitle,
    url: payload.pageUrl,
    domain: payload.domain || getDomain(payload.pageUrl),
    timestamp: payload.timestamp || Date.now(),
    selectedText,
    textLength: payload.selectedText.length,
    privacyLevel: redaction.redacted ? "redacted" : "safe",
    copyKind: classifyCopiedText(selectedText, payload.elementTag),
    duplicateCount: 1
  };

  if (settings.captureContext) {
    event.surroundingText = payload.surroundingText
      ? settings.redactSensitive
        ? redactSensitiveText(truncateText(payload.surroundingText, MAX_CONTEXT_TEXT_LENGTH)).text
        : truncateText(payload.surroundingText, MAX_CONTEXT_TEXT_LENGTH)
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
    pageStats: updatePageStats(
      active,
      { url: payload.pageUrl, domain: payload.domain, title: payload.pageTitle, timestamp: payload.timestamp },
      { selectedCount: 1 }
    ),
    updatedAt: Date.now()
  });

  return { recorded: true, eventId: event.id };
}

export async function recordLinkClick(
  payload: LinkClickPayload,
  senderTab?: chrome.tabs.Tab
): Promise<{ recorded: boolean; eventId?: string; reason?: string }> {
  const [active, settings] = await Promise.all([getActiveSession(), getInteractionSettings()]);
  if (!active) return { recorded: false, reason: "no_active_session" };
  if (!settings.captureClicks) return { recorded: false, reason: "click_capture_disabled" };
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

  const duplicate = active.events.find(
    (event) =>
      event.type === "link_clicked" &&
      event.url === payload.pageUrl &&
      event.targetUrl === payload.targetUrl &&
      Math.abs(event.timestamp - payload.timestamp) < 1500
  );
  if (duplicate) return { recorded: true, eventId: duplicate.id, reason: "duplicate_click" };

  const event: TrailEvent = {
    id: createId("event"),
    type: "link_clicked",
    tabId,
    title: payload.pageTitle,
    url: payload.pageUrl,
    domain: payload.domain || getDomain(payload.pageUrl),
    timestamp: payload.timestamp || Date.now(),
    targetUrl: payload.targetUrl,
    targetText: payload.targetText ? truncateText(payload.targetText, 180) : undefined,
    targetDomain: payload.targetDomain || getDomain(payload.targetUrl),
    sectionTitle: payload.sectionTitle ? truncateText(payload.sectionTitle, 120) : undefined,
    elementTag: payload.elementTag,
    elementRole: payload.elementRole,
    cssSelector: payload.cssSelector,
    linkKind: payload.linkKind
  };

  const nextTabs = senderTab ? uniqueTabs([...active.tabs, toResearchTab(senderTab)]) : active.tabs;
  await setActiveSession({
    ...active,
    tabs: nextTabs,
    events: [...active.events, event].slice(-300),
    pageStats: updatePageStats(
      active,
      { url: payload.pageUrl, domain: payload.domain, title: payload.pageTitle, timestamp: payload.timestamp },
      { outboundClickCount: 1 }
    ),
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
