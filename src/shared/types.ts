import type {
  BrowserToolDefinition,
  BrowserToolDownloadItemInput,
  BrowserToolDownloadRunResult,
  BrowserToolManagerState,
  BrowserToolRunResult,
  StoredBrowserTool
} from "../browser-tools/contracts";
import type { LiteratureDownloadItemInput } from "../literature-queue/types";
import type { CollectorState, FollowEntry, FollowsImportResult } from "../collector/types";
import type { FeedPublisherConfig, FeedPublisherSnapshot, FeedPublishResult, FeedRepoProbe } from "../publisher/types";

export type TrailSource = "tab_group" | "window";

export type TrailStatus = "recording" | "completed";

export type TrailEventType =
  | "created"
  | "updated"
  | "activated"
  | "removed"
  | "group_updated"
  | "text_selected"
  | "text_copied"
  | "link_clicked";

export type TrailPrivacyLevel = "safe" | "sensitive" | "redacted";

export type TrailCopyKind = "text" | "quote" | "code" | "command" | "metric" | "link";

export type TrailLinkKind = "external" | "search_result" | "doc_toc" | "github" | "download" | "reference";

export type TrailSourceLevel = "core" | "reference" | "passing";

export type ResearchTab = {
  id?: number;
  title: string;
  url: string;
  domain: string;
  favIconUrl?: string;
  groupId?: number;
  windowId?: number;
  capturedAt: number;
};

export type TrailEvent = {
  id: string;
  type: TrailEventType;
  tabId?: number;
  title?: string;
  url?: string;
  domain?: string;
  timestamp: number;
  selectedText?: string;
  surroundingText?: string;
  sectionTitle?: string;
  elementTag?: string;
  elementRole?: string;
  cssSelector?: string;
  viewportX?: number;
  viewportY?: number;
  pageX?: number;
  pageY?: number;
  textLength?: number;
  privacyLevel?: TrailPrivacyLevel;
  copyKind?: TrailCopyKind;
  duplicateCount?: number;
  firstCopiedAt?: number;
  targetUrl?: string;
  targetText?: string;
  targetDomain?: string;
  linkKind?: TrailLinkKind;
};

export type TrailPageStat = {
  url: string;
  domain: string;
  title: string;
  firstSeenAt: number;
  lastSeenAt: number;
  activeMs: number;
  visitCount: number;
  selectedCount: number;
  copiedCount: number;
  outboundClickCount: number;
  score: number;
  level: TrailSourceLevel;
};

export type TrailSession = {
  id: string;
  source: TrailSource;
  name: string;
  goal?: string;
  groupId?: number;
  groupTitle?: string;
  groupColor?: string;
  windowId: number;
  status: TrailStatus;
  startedAt: number;
  endedAt?: number;
  updatedAt?: number;
  tabs: ResearchTab[];
  events: TrailEvent[];
  pageStats?: TrailPageStat[];
  markdown?: string;
  exportFileName?: string;
  lastExportedAt?: number;
};

export type ResearchReportSourceInput = {
  id: string;
  title: string;
  url: string;
  domain: string;
  level: TrailSourceLevel;
  activeMs: number;
  visitCount: number;
  selectedCount: number;
  copiedCount: number;
  outboundClickCount: number;
};

export type ResearchReportClipInput = {
  id: string;
  status: "copied" | "selected";
  kind: TrailCopyKind;
  text: string;
  context?: string;
  sourceId?: string;
  sourceUrl?: string;
  domain?: string;
  sectionTitle?: string;
  privacyLevel?: TrailPrivacyLevel;
  capturedAt: number;
};

export type ResearchReportClickInput = {
  id: string;
  sourceId?: string;
  sourceUrl?: string;
  sourceDomain?: string;
  targetUrl: string;
  targetDomain?: string;
  targetText?: string;
  kind: TrailLinkKind;
  clickedAt: number;
};

export type ResearchReportInput = {
  schemaVersion: 1;
  sessionId: string;
  title: string;
  goal?: string;
  source: TrailSource;
  startedAt: number;
  endedAt?: number;
  generatedAt: number;
  summary: {
    sourceCount: number;
    clipCount: number;
    copiedClipCount: number;
    selectedClipCount: number;
    clickCount: number;
  };
  sources: ResearchReportSourceInput[];
  clips: ResearchReportClipInput[];
  clickPath: ResearchReportClickInput[];
};

export type GroupContext = {
  hasGroup: boolean;
  group?: chrome.tabGroups.TabGroup;
  activeTab?: chrome.tabs.Tab;
  tabs: ResearchTab[];
  windowId?: number;
};

export type CopyInteractionPayload = {
  selectedText: string;
  surroundingText?: string;
  sectionTitle?: string;
  elementTag?: string;
  elementRole?: string;
  cssSelector?: string;
  pageUrl: string;
  pageTitle: string;
  domain: string;
  viewportX?: number;
  viewportY?: number;
  pageX?: number;
  pageY?: number;
  timestamp: number;
};

export type LinkClickPayload = {
  pageUrl: string;
  pageTitle: string;
  domain: string;
  targetUrl: string;
  targetText?: string;
  targetDomain: string;
  sectionTitle?: string;
  elementTag?: string;
  elementRole?: string;
  cssSelector?: string;
  linkKind: TrailLinkKind;
  timestamp: number;
};

export type TrailInteractionSettings = {
  captureCopy: boolean;
  captureSelection: boolean;
  captureClicks: boolean;
  captureContext: boolean;
  showToast: boolean;
  mergeDuplicates: boolean;
  redactSensitive: boolean;
  excludedDomains: string[];
};

export type RuntimeMessage =
  | { type: "RESTORE_BUNDLED_BROWSER_TOOL"; toolId: string }
  | { type: "GET_CHECKIN_STATE" }
  | { type: "CONFIGURE_CHECKIN"; toolId: string; enabled: boolean; time: string }
  | { type: "RUN_CHECKIN"; toolId: string }
  | { type: "OPEN_CHECKIN_PAGE"; toolId: string }
  | { type: "GET_FEED_STATE" }
  | { type: "SAVE_FEED_CONFIG"; config: FeedPublisherConfig }
  | { type: "STAGE_FEED_POSTS"; posts: unknown[] }
  | { type: "PUBLISH_FEED" }
  | { type: "PROBE_FEED_REPO" }
  | { type: "BROWSER_TOOL_GRAPHQL_RESOLVE"; operation: string }
  | {
      type: "BROWSER_TOOL_GRAPHQL_FETCH";
      operation: string;
      query_id: string;
      variables: Record<string, unknown>;
      features?: Record<string, boolean>;
      field_toggles?: Record<string, boolean>;
    }
  | { type: "BROWSER_TOOL_STATE_READ"; source?: string }
  | { type: "GET_BATCH_RUN_STATE" }
  | { type: "PAUSE_BATCH_RUN" }
  | { type: "RESUME_BATCH_RUN"; tabId?: number; userInitiated?: boolean }
  | { type: "STOP_BATCH_RUN" }
  | { type: "CLEAR_STAGED_FEED" }
  | { type: "GET_TRAIL_LOGS" }
  | { type: "CLEAR_TRAIL_LOGS" }
  | { type: "GET_COLLECTOR_STATE" }
  | { type: "CONFIGURE_COLLECTOR"; toolId: string; enabled: boolean; intervalHours: number }
  | { type: "RUN_COLLECTOR_NOW"; toolId: string }
  | { type: "OPEN_COLLECTOR_PAGE"; toolId: string }
  | { type: "GET_FOLLOWS"; platform: string }
  | { type: "ADD_FOLLOW"; platform: string; handle: string; displayName?: string }
  | { type: "REMOVE_FOLLOW"; platform: string; handle: string }
  | { type: "IMPORT_FOLLOWS"; platform: string; text: string }
  | { type: "GET_POPUP_STATE" }
  | { type: "GET_INTERACTION_SETTINGS" }
  | { type: "UPDATE_INTERACTION_SETTINGS"; settings: Partial<TrailInteractionSettings> }
  | { type: "START_GROUP_RECORDING"; name?: string }
  | { type: "START_NEW_GROUP_RECORDING"; name?: string }
  | { type: "START_WINDOW_RECORDING"; name?: string }
  | { type: "STOP_RECORDING" }
  | { type: "GENERATE_FROM_CURRENT_GROUP"; name?: string }
  | { type: "GENERATE_FROM_CURRENT_WINDOW"; name?: string }
  | { type: "RECORD_INTERACTION"; payload: CopyInteractionPayload }
  | { type: "RECORD_SELECTION"; payload: CopyInteractionPayload }
  | { type: "RECORD_LINK_CLICK"; payload: LinkClickPayload }
  | { type: "DELETE_EVENT"; eventId: string }
  | { type: "VALIDATE_BROWSER_TOOL_YAML"; yaml: string }
  | {
      type: "RUN_BROWSER_TOOL";
      yaml: string;
      parameters: Record<string, unknown>;
      tabId?: number;
      userInitiated: true;
    }
  | { type: "GET_BROWSER_TOOL_STATE"; tabId?: number }
  | { type: "IMPORT_BROWSER_TOOL"; yaml: string }
  | { type: "IMPORT_BUNDLED_BROWSER_TOOLS" }
  | {
      type: "DOWNLOAD_BROWSER_TOOL_ITEMS";
      toolId: string;
      downloadDefinitionId: string;
      format: string;
      items: BrowserToolDownloadItemInput[];
      userInitiated: true;
    }
  | {
      type: "DOWNLOAD_LITERATURE_QUEUE";
      items: LiteratureDownloadItemInput[];
      concurrency: number;
      userInitiated: true;
    }
  | { type: "PAUSE_LITERATURE_DOWNLOAD" }
  | { type: "RESUME_LITERATURE_DOWNLOAD" }
  | { type: "DELETE_BROWSER_TOOL"; toolId: string }
  | {
      type: "RUN_STORED_BROWSER_TOOL";
      toolId: string;
      parameters: Record<string, unknown>;
      tabId?: number;
      userInitiated: true;
    }
  | {
      type: "RUN_BROWSER_TOOL_BATCH";
      toolId: string;
      keywords: string[];
      parameters: Record<string, unknown>;
      tabId?: number;
      userInitiated: true;
      nativeExport?: { definitionId: string; maxRecords: number };
    }
  | { type: "OPEN_SESSION"; sessionId: string }
  | { type: "DELETE_SESSION"; sessionId: string };

export type { BrowserToolDefinition, BrowserToolDownloadRunResult, BrowserToolManagerState, BrowserToolRunResult, StoredBrowserTool };

export type PopupState = {
  activeSession?: TrailSession;
  currentGroup: GroupContext;
  recentSessions: TrailSession[];
  interactionSettings: TrailInteractionSettings;
};
