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
import {
  getBrowserToolManagerState,
  importBrowserTool,
  removeBrowserTool,
  runBrowserTool,
  runStoredBrowserTool,
  validateBrowserToolYaml
} from "./browserTools";

chrome.runtime.onMessage.addListener((message: RuntimeMessage, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error: unknown) => {
      const messageText = error instanceof Error ? error.message : "Unknown Trail error";
      sendResponse({ error: messageText });
    });

  return true;
});

async function handleMessage(message: RuntimeMessage, sender: chrome.runtime.MessageSender) {
  switch (message.type) {
    case "GET_POPUP_STATE":
      return getPopupState();
    case "GET_INTERACTION_SETTINGS":
      return getInteractionSettings();
    case "UPDATE_INTERACTION_SETTINGS":
      return updateInteractionSettings(message.settings);
    case "START_GROUP_RECORDING":
      return startGroupRecording(message.name);
    case "START_NEW_GROUP_RECORDING":
      return startNewGroupRecording(message.name);
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
    case "DELETE_BROWSER_TOOL":
      return removeBrowserTool(message.toolId);
    case "RUN_STORED_BROWSER_TOOL":
      return runStoredBrowserTool(message);
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
