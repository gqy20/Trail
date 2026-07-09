export type TrailSource = "tab_group" | "window";

export type TrailStatus = "recording" | "completed";

export type TrailEventType =
  | "created"
  | "updated"
  | "activated"
  | "removed"
  | "group_updated"
  | "text_selected"
  | "text_copied";

export type TrailPrivacyLevel = "safe" | "sensitive" | "redacted";

export type TrailCopyKind = "text" | "quote" | "code" | "command" | "metric" | "link";

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
};

export type TrailSession = {
  id: string;
  source: TrailSource;
  name: string;
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
  markdown?: string;
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

export type TrailInteractionSettings = {
  captureCopy: boolean;
  captureSelection: boolean;
  captureContext: boolean;
  showToast: boolean;
  mergeDuplicates: boolean;
  redactSensitive: boolean;
  excludedDomains: string[];
};

export type RuntimeMessage =
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
  | { type: "DELETE_EVENT"; eventId: string }
  | { type: "OPEN_SESSION"; sessionId: string }
  | { type: "DELETE_SESSION"; sessionId: string };

export type PopupState = {
  activeSession?: TrailSession;
  currentGroup: GroupContext;
  recentSessions: TrailSession[];
  interactionSettings: TrailInteractionSettings;
};
