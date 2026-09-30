import {
  deleteActiveEvent,
  generateFromCurrentGroup,
  generateFromCurrentWindow,
  getPopupState,
  recordCopyInteraction,
  recordLinkClick,
  recordGroupUpdate,
  recordSelectionInteraction,
  recordTabEvent,
  startGroupRecording,
  startNewGroupRecording,
  startWindowRecording,
  stopRecording
} from "./recorder";
import { deleteSession, getInteractionSettings, updateInteractionSettings } from "../shared/storage";
import type { RuntimeMessage } from "../shared/types";
import type { BrowserToolExecutionProgress, BrowserToolExecutionProgressEvent } from "../browser-tools/contracts";
import {
  getBrowserToolManagerState,
  getBrowserToolBatchRunState,
  importBundledBrowserTools,
  importBrowserTool,
  pauseBrowserToolBatch,
  removeBrowserTool,
  resumeBrowserToolBatch,
  runBrowserTool,
  runStoredBrowserToolBatch,
  runStoredBrowserTool,
  stopBrowserToolBatch,
  validateBrowserToolYaml
} from "./browserTools";
import { downloadBrowserToolItems } from "./browserToolDownloads";
import { downloadLiteratureQueue, pauseLiteratureDownload, resumeLiteratureDownload } from "./literatureDownloads";
import { configureCheckin, getCheckinState, openCheckinPage, registerCheckins, runCheckin } from "./checkins";
import {
  configureCollector,
  getCollectorState,
  openCollectorPage,
  registerCollectors,
  runCollector
} from "./collectors";
import { addFollow, getFollows, importFollows, removeFollow, removeFollows } from "../collector/follows";
import { getFeedState, probeFeedConnection, publishStagedFeed, registerFeedPublisher, saveFeedPublisherConfig, stagePosts, clearStagedFeed } from "./feed";
import { fetchGraphqlPageForTab, readPageStateForTab, resolveGraphqlQueryIdForTab } from "./graphqlBridge";
import { clearLogEntries, getLogEntries } from "../logging/logger";
import { restoreBundledBrowserTool } from "../browser-tools/bundled";
import { getStoredBrowserTool, saveStoredBrowserTool } from "../browser-tools/storage";
import { getStoredBrowserTools } from "../browser-tools/storage";
import { getBudgetUsage, saveBudgetConfig } from "../collector/budget";

void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch((error: unknown) => {
  console.error("Trail 无法设置边栏入口。", error);
});

registerCheckins();
registerCollectors();

chrome.runtime.onMessage.addListener((message: RuntimeMessage | BrowserToolExecutionProgress | BrowserToolExecutionProgressEvent, sender, sendResponse) => {
  if (message.type === "BROWSER_TOOL_EXECUTION_PROGRESS") {
    void chrome.runtime.sendMessage({ ...message, type: "BROWSER_TOOL_PROGRESS_UPDATE" } satisfies BrowserToolExecutionProgress).catch(() => undefined);
    return false;
  }
  if (message.type === "BROWSER_TOOL_PROGRESS_UPDATE") return false;
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      const messageText = error instanceof Error ? error.message : "Unknown Trail error";
      sendResponse({ error: messageText });
    });

  return true;
});

async function handleMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  if (["RESTORE_BUNDLED_BROWSER_TOOL", "GET_CHECKIN_STATE", "CONFIGURE_CHECKIN", "RUN_CHECKIN", "OPEN_CHECKIN_PAGE", "GET_FEED_STATE", "SAVE_FEED_CONFIG", "STAGE_FEED_POSTS", "PUBLISH_FEED", "PROBE_FEED_REPO", "CLEAR_STAGED_FEED", "CLEAR_TRAIL_LOGS", "GET_COLLECTOR_STATE", "CONFIGURE_COLLECTOR", "RUN_COLLECTOR_NOW", "OPEN_COLLECTOR_PAGE", "ADD_FOLLOW", "REMOVE_FOLLOW", "REMOVE_FOLLOWS", "IMPORT_FOLLOWS", "GET_BATCH_RUN_STATE", "PAUSE_BATCH_RUN", "RESUME_BATCH_RUN", "STOP_BATCH_RUN"].includes(message.type)) {
    const extensionUrl = chrome.runtime.getURL("");
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(extensionUrl)) throw new Error("此操作只能从 Trail 界面发起。");
  }
  switch (message.type) {
    case "GET_ACTIVITY_BUDGET": return getBudgetUsage((await getStoredBrowserTools()).flatMap((tool) => tool.definition.feed ? [tool.definition.feed.platform] : []));
    case "SAVE_ACTIVITY_BUDGET": {
      if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL(""))) throw new Error("只能从 Trail 界面修改预算。");
      await saveBudgetConfig(message.platform, message.config);
      return undefined;
    }
    case "RESTORE_BUNDLED_BROWSER_TOOL": return restoreBundledBrowserTool(message.toolId);
    case "GET_CHECKIN_STATE": return getCheckinState();
    case "CONFIGURE_CHECKIN": return configureCheckin(message.toolId, message.enabled, message.time);
    case "RUN_CHECKIN": return runCheckin(message.toolId);
    case "OPEN_CHECKIN_PAGE": return openCheckinPage(message.toolId);
    case "GET_FEED_STATE": return getFeedState();
    case "SAVE_FEED_CONFIG": return saveFeedPublisherConfig(message.config);
    case "STAGE_FEED_POSTS": return stagePosts(message.posts);
    case "PUBLISH_FEED": return publishStagedFeed();
    case "PROBE_FEED_REPO": return probeFeedConnection();
    case "CLEAR_STAGED_FEED": return clearStagedFeed();
    case "GET_TRAIL_LOGS": return getLogEntries();
    case "CLEAR_TRAIL_LOGS": return clearTrailLogs();
    case "GET_COLLECTOR_STATE": return getCollectorState();
    case "CONFIGURE_COLLECTOR": return configureCollector(message.toolId, message.enabled, message.intervalHours);
    case "RUN_COLLECTOR_NOW": return runCollector(message.toolId);
    case "OPEN_COLLECTOR_PAGE": return openCollectorPage(message.toolId);
    case "GET_FOLLOWS": return getFollows(message.platform);
    case "ADD_FOLLOW": return addFollow({ platform: message.platform, handle: message.handle, displayName: message.displayName });
    case "REMOVE_FOLLOW": return removeFollow(message.platform, message.handle);
    case "REMOVE_FOLLOWS": {
      if (!Array.isArray(message.handles) || message.handles.some((handle) => typeof handle !== "string")) throw new Error("账号列表无效。");
      return removeFollows(message.platform, message.handles);
    }
    case "IMPORT_FOLLOWS": return importFollows(message.platform, message.text);
    case "BROWSER_TOOL_GRAPHQL_RESOLVE": return resolveGraphqlQueryIdForTab(message, sender);
    case "BROWSER_TOOL_GRAPHQL_FETCH": return fetchGraphqlPageForTab(message, sender);
    case "BROWSER_TOOL_STATE_READ": return readPageStateForTab(message, sender);
    case "GET_BATCH_RUN_STATE": return getBrowserToolBatchRunState();
    case "PAUSE_BATCH_RUN": return pauseBrowserToolBatch();
    case "RESUME_BATCH_RUN": return resumeBrowserToolBatch({ tabId: message.tabId, userInitiated: message.userInitiated });
    case "STOP_BATCH_RUN": return stopBrowserToolBatch();
    case "GET_POPUP_STATE":
      return getPopupState();
    case "GET_INTERACTION_SETTINGS":
      return getInteractionSettings();
    case "UPDATE_INTERACTION_SETTINGS":
      return updateInteractionSettings(message.settings);
    case "START_GROUP_RECORDING":
      return startGroupRecording(message.name);
    case "START_NEW_GROUP_RECORDING":
      return startNewGroupRecording(message.name, message.tabIds);
    case "START_WINDOW_RECORDING":
      return startWindowRecording(message.name);
    case "STOP_RECORDING":
      return stopRecording();
    case "GENERATE_FROM_CURRENT_GROUP":
      return generateFromCurrentGroup(message.name);
    case "GENERATE_FROM_CURRENT_WINDOW":
      return generateFromCurrentWindow(message.name);
    case "RECORD_INTERACTION":
      return recordCopyInteraction(message.payload, sender.tab);
    case "RECORD_SELECTION":
      return recordSelectionInteraction(message.payload, sender.tab);
    case "RECORD_LINK_CLICK":
      return recordLinkClick(message.payload, sender.tab);
    case "DELETE_EVENT":
      return deleteActiveEvent(message.eventId);
    case "VALIDATE_BROWSER_TOOL_YAML":
      return validateBrowserToolYaml(message.yaml);
    case "RUN_BROWSER_TOOL":
      return runBrowserTool(message);
    case "GET_BROWSER_TOOL_STATE":
      return getBrowserToolManagerState(message.tabId);
    case "IMPORT_BROWSER_TOOL":
      return importBrowserTool(message.yaml);
    case "IMPORT_BUNDLED_BROWSER_TOOLS":
      return importBundledBrowserTools();
    case "DOWNLOAD_BROWSER_TOOL_ITEMS":
      return downloadBrowserToolItems(message);
    case "DOWNLOAD_LITERATURE_QUEUE":
      return downloadLiteratureQueue(message);
    case "PAUSE_LITERATURE_DOWNLOAD":
      return pauseLiteratureDownload();
    case "RESUME_LITERATURE_DOWNLOAD":
      return resumeLiteratureDownload();
    case "DELETE_BROWSER_TOOL":
      return removeBrowserTool(message.toolId);
    case "SET_BROWSER_TOOL_ENABLED": {
      if (typeof message.enabled !== "boolean") throw new Error("工具启用状态无效。");
      const tool = await getStoredBrowserTool(message.toolId);
      if (!tool || tool.source?.backupOf) throw new Error("未找到工具。");
      if (!message.enabled && tool.enabled !== false) {
        const batch = await getBrowserToolBatchRunState();
        if (batch?.toolId === tool.id && (batch.status === "running" || batch.status === "paused")) throw new Error("请先停止此工具的批量任务，再停用工具。");
        if (tool.definition.checkin) {
          const item = (await getCheckinState()).items.find((item) => item.toolId === tool.id);
          if (item?.job.status === "running") throw new Error("请等待签到结束后停用。");
          await configureCheckin(tool.id, false, item?.job.time || "09:00");
        }
        if (tool.definition.feed && tool.definition.batch && tool.definition.feed.entry_url) {
          const item = (await getCollectorState()).items.find((item) => item.toolId === tool.id);
          if (item?.job?.status === "running") throw new Error("请先停止采集任务，再停用工具。");
          await configureCollector(tool.id, false, item?.job?.intervalHours || 4);
        }
      }
      await saveStoredBrowserTool({ ...tool, enabled: message.enabled });
      return undefined;
    }
    case "RUN_STORED_BROWSER_TOOL":
      return runStoredBrowserTool(message);
    case "RUN_BROWSER_TOOL_BATCH":
      return runStoredBrowserToolBatch(message);
    case "OPEN_SESSION":
      await chrome.tabs.create({ url: chrome.runtime.getURL(`entries/research.html?sessionId=${message.sessionId}`) });
      return undefined;
    case "DELETE_SESSION":
      await deleteSession(message.sessionId);
      return undefined;
  }
}

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) void recordTabEvent("created", tab.id, tab);
});

async function clearTrailLogs(): Promise<{ cleared: number }> {
  const entries = await getLogEntries();
  await clearLogEntries();
  return { cleared: entries.length };
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" || changeInfo.title || changeInfo.url) {
    void recordTabEvent("updated", tabId, tab);
  }
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void recordTabEvent("activated", activeInfo.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void recordTabEvent("removed", tabId);
});

chrome.tabGroups.onUpdated.addListener((group) => {
  void recordGroupUpdate(group);
});
