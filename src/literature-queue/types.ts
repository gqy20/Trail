export type LiteratureDecision = "include" | "maybe" | "other";

export type LiteratureQueueStatus =
  | "pending"
  | "resolving"
  | "completed"
  | "needs_search"
  | "needs_user"
  | "failed";

export type LiteratureQueueItem = {
  id: string;
  title: string;
  doi?: string;
  pdfUrl?: string;
  downloadUrl?: string;
  decision: LiteratureDecision;
  sourceRows: number;
  status: LiteratureQueueStatus;
  filename?: string;
  error?: string;
  resolverUrl?: string;
};

export type LiteratureQueue = {
  sourceName: string;
  importedAt: number;
  updatedAt: number;
  sourceRows: number;
  items: LiteratureQueueItem[];
};

export type LiteratureDownloadItemInput = Pick<
  LiteratureQueueItem,
  "id" | "title" | "doi" | "pdfUrl" | "downloadUrl"
>;

export type LiteratureDownloadItemResult = Pick<LiteratureQueueItem, "id" | "status" | "filename" | "error" | "resolverUrl">;

export type LiteratureDownloadRunResult = {
  startedAt: number;
  finishedAt: number;
  items: LiteratureDownloadItemResult[];
};

export type LiteratureQueuePreferences = {
  concurrency: number;
};

export type ResolveLiteratureResourceMessage = {
  type: "RESOLVE_LITERATURE_RESOURCE";
};

export type LiteratureResourceResolution = {
  resourceUrl?: string;
  action?: "download" | "navigate";
  blocker?: string;
};

export type TriggerLiteratureDownloadMessage = {
  type: "TRIGGER_LITERATURE_DOWNLOAD";
  resourceUrl: string;
  filename: string;
};

export type LiteratureDownloadProgress = {
  type: "LITERATURE_DOWNLOAD_PROGRESS";
  state: "running" | "paused";
  completed: number;
  total: number;
  active: number;
  succeeded: number;
  needsUser: number;
  failed: number;
  concurrency: number;
  currentTitle?: string;
};
