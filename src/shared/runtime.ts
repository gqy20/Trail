import type {
  BrowserToolDefinition,
  BrowserToolDownloadRunResult,
  BrowserToolManagerState,
  BrowserToolRunResult,
  PopupState,
  RuntimeMessage,
  TrailInteractionSettings,
  TrailSession
} from "./types";
import type { StoredBrowserTool } from "../browser-tools/contracts";
import type { BundledBrowserToolImportResult } from "../browser-tools/bundled";
import type { LiteratureDownloadRunResult } from "../literature-queue/types";

type RuntimeResponseMap = {
  GET_POPUP_STATE: PopupState;
  GET_INTERACTION_SETTINGS: TrailInteractionSettings;
  UPDATE_INTERACTION_SETTINGS: TrailInteractionSettings;
  START_GROUP_RECORDING: TrailSession;
  START_NEW_GROUP_RECORDING: TrailSession;
  START_WINDOW_RECORDING: TrailSession;
  STOP_RECORDING: TrailSession | undefined;
  GENERATE_FROM_CURRENT_GROUP: TrailSession;
  GENERATE_FROM_CURRENT_WINDOW: TrailSession;
  RECORD_INTERACTION: { recorded: boolean; eventId?: string; reason?: string };
  RECORD_SELECTION: { recorded: boolean; eventId?: string; reason?: string };
  RECORD_LINK_CLICK: { recorded: boolean; eventId?: string; reason?: string };
  DELETE_EVENT: { deleted: boolean };
  VALIDATE_BROWSER_TOOL_YAML: BrowserToolDefinition;
  RUN_BROWSER_TOOL: BrowserToolRunResult;
  GET_BROWSER_TOOL_STATE: BrowserToolManagerState;
  IMPORT_BROWSER_TOOL: StoredBrowserTool;
  IMPORT_BUNDLED_BROWSER_TOOLS: BundledBrowserToolImportResult;
  DOWNLOAD_BROWSER_TOOL_ITEMS: BrowserToolDownloadRunResult;
  DOWNLOAD_LITERATURE_QUEUE: LiteratureDownloadRunResult;
  PAUSE_LITERATURE_DOWNLOAD: { paused: boolean };
  RESUME_LITERATURE_DOWNLOAD: { paused: boolean };
  DELETE_BROWSER_TOOL: undefined;
  RUN_STORED_BROWSER_TOOL: BrowserToolRunResult;
  RUN_BROWSER_TOOL_BATCH: BrowserToolRunResult;
  OPEN_SESSION: undefined;
  DELETE_SESSION: undefined;
};

export async function sendMessage<T extends RuntimeMessage>(
  message: T
): Promise<RuntimeResponseMap[T["type"]]> {
  const response = await chrome.runtime.sendMessage(message);

  if (response && typeof response === "object" && "error" in response) {
    throw new Error(String(response.error));
  }

  return response;
}
