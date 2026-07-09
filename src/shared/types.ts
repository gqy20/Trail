export type TrailSource = "tab_group" | "window";

export type TrailStatus = "recording" | "completed";

export type TrailEventType = "created" | "updated" | "activated" | "removed" | "group_updated";

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

export type RuntimeMessage =
  | { type: "GET_POPUP_STATE" }
  | { type: "START_GROUP_RECORDING"; name?: string }
  | { type: "START_NEW_GROUP_RECORDING"; name?: string }
  | { type: "START_WINDOW_RECORDING"; name?: string }
  | { type: "STOP_RECORDING" }
  | { type: "GENERATE_FROM_CURRENT_GROUP"; name?: string }
  | { type: "GENERATE_FROM_CURRENT_WINDOW"; name?: string }
  | { type: "OPEN_SESSION"; sessionId: string }
  | { type: "DELETE_SESSION"; sessionId: string };

export type PopupState = {
  activeSession?: TrailSession;
  currentGroup: GroupContext;
  recentSessions: TrailSession[];
};
