import {
  generateFromCurrentGroup,
  generateFromCurrentWindow,
  getPopupState,
  recordGroupUpdate,
  recordTabEvent,
  startGroupRecording,
  startNewGroupRecording,
  startWindowRecording,
  stopRecording
} from "./recorder";
import { deleteSession } from "../shared/storage";
import type { RuntimeMessage } from "../shared/types";

chrome.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error: unknown) => {
      const messageText = error instanceof Error ? error.message : "Unknown Trail error";
      sendResponse({ error: messageText });
    });

  return true;
});

async function handleMessage(message: RuntimeMessage) {
  switch (message.type) {
    case "GET_POPUP_STATE":
      return getPopupState();
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
