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
  RESTORE_BUNDLED_BROWSER_TOOL: undefined;
  GET_CHECKIN_STATE: import("../checkin/types").CheckinState;
  CONFIGURE_CHECKIN: import("../checkin/types").CheckinState;
  RUN_CHECKIN: import("../checkin/types").CheckinState;
  OPEN_CHECKIN_PAGE: undefined;
  GET_FEED_STATE: import("../publisher/types").FeedPublisherSnapshot;
  SAVE_FEED_CONFIG: import("../publisher/types").FeedPublisherSnapshot;
  STAGE_FEED_POSTS: { staged: number };
  PUBLISH_FEED: import("../publisher/types").FeedPublishResult;
  PROBE_FEED_REPO: import("../publisher/types").FeedRepoProbe;
  BROWSER_TOOL_GRAPHQL_RESOLVE: { queryId: string | null };
  BROWSER_TOOL_GRAPHQL_FETCH: { status: number; json: unknown };
  GET_BATCH_RUN_STATE: import("../background/runControl").BatchRunState | null;
  PAUSE_BATCH_RUN: { requested: boolean };
  RESUME_BATCH_RUN: BrowserToolRunResult;
  STOP_BATCH_RUN: { requested: boolean; finalized: boolean };
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
