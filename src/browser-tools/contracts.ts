export type BrowserToolParameterType = "string" | "number" | "boolean";

export type BrowserToolParameterDefinition = {
  type: BrowserToolParameterType;
  label?: string;
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  presentation?: {
    placement?: "primary" | "advanced" | "hidden";
    style?: "field" | "sentence";
    prefix?: string;
    suffix?: string;
  };
};

export type BrowserToolFieldPresentation = {
  label?: string;
  order?: number;
  display?: "text" | "link";
  emphasis?: "primary" | "secondary";
};

export type BrowserToolCollectionPresentation = {
  label?: string;
  item_label?: string;
  count_unit?: string;
  fields?: Record<string, BrowserToolFieldPresentation>;
};

export type BrowserToolPresentation = {
  title?: string;
  source_label?: string;
  batch_input?: {
    label?: string;
    placeholder?: string;
    item_label?: string;
    count_unit?: string;
    import_formats?: Array<"txt" | "csv">;
    csv_headers?: string[];
    composer?: {
      enabled?: boolean;
      label?: string;
      group_label?: string;
      placeholder?: string;
      operators?: string[];
      default_operator?: string;
      max_groups?: number;
    };
  };
  actions?: {
    run?: string;
    run_empty?: string;
    running?: string;
    single_run?: string;
    single_running?: string;
  };
  results?: {
    title?: string;
    item_label?: string;
    count_unit?: string;
    empty_title?: string;
    empty_description?: string;
  };
  collections?: Record<string, BrowserToolCollectionPresentation>;
};

export type BrowserToolDownloadDefinition = {
  id: string;
  label: string;
  collection: string;
  detail_url_field: string;
  title_field?: string;
  formats: Record<string, {
    label: string;
    selector: string;
    extension?: string;
  }>;
  blockers?: Array<{
    selector: string;
    status: "verification" | "login" | "permission";
    message: string;
  }>;
  allowed_domains?: string[];
  max_items?: number;
  delay_ms?: number;
};

export type BrowserToolFieldDefinition = {
  selector?: string;
  attribute?: "text" | "href" | "content" | "datetime" | "aria_label";
  transforms?: BrowserToolTransform[];
  optional?: boolean;
  multiple?: boolean;
};

export type BrowserToolTransform =
  | "trim"
  | "normalize_whitespace"
  | "parse_year"
  | "parse_number"
  | "split_authors";

export type BrowserToolWaitForStep = {
  action: "wait_for";
  selector: string;
  timeout_ms?: number;
  optional?: boolean;
};

export type BrowserToolFillStep = {
  action: "fill";
  selector: string;
  value: string;
  clear?: boolean;
};

export type BrowserToolSelectStep = {
  action: "select";
  selector: string;
  value: string;
};

export type BrowserToolClickStep = {
  action: "click";
  selector: string;
  optional?: boolean;
  stop_repeat_on_missing?: boolean;
  wait_for_change?: {
    selector: string;
    timeout_ms?: number;
  };
};

export type BrowserToolWaitStep = {
  action: "wait";
  duration_ms: number;
};

export type BrowserToolScrollStep = {
  action: "scroll";
  selector?: string;
  delta_y?: number;
  position?: "top" | "bottom";
};

export type BrowserToolWaitForChangeStep = {
  action: "wait_for_change";
  selector: string;
  timeout_ms?: number;
  optional?: boolean;
};

export type BrowserToolExtractStep = {
  action: "extract";
  collection: string;
  selector: string;
  fields: Record<string, BrowserToolFieldDefinition>;
};

export type BrowserToolRepeatStep = {
  action: "repeat";
  max: number | string;
  steps: BrowserToolStep[];
  between?: BrowserToolStep[];
  progress?: {
    scope: string;
    label: string;
    item_label?: string;
  };
};

export type BrowserToolPauseStep = {
  action: "pause_for_user";
  reason: string;
};

export type BrowserToolPauseIfPresentStep = {
  action: "pause_if_present";
  selector: string;
  reason: string;
  timeout_ms?: number;
};

export type BrowserToolStep =
  | BrowserToolWaitForStep
  | BrowserToolFillStep
  | BrowserToolSelectStep
  | BrowserToolClickStep
  | BrowserToolWaitStep
  | BrowserToolScrollStep
  | BrowserToolWaitForChangeStep
  | BrowserToolExtractStep
  | BrowserToolRepeatStep
  | BrowserToolPauseIfPresentStep
  | BrowserToolPauseStep;

export type BrowserToolDefinition = {
  schema_version: 1;
  id: string;
  name: string;
  description?: string;
  version: string;
  match: {
    domains: string[];
    urls?: string[];
  };
  parameters?: Record<string, BrowserToolParameterDefinition>;
  selectors?: Record<string, string>;
  workflow: BrowserToolStep[];
  presentation?: BrowserToolPresentation;
  downloads?: BrowserToolDownloadDefinition[];
  batch?: {
    navigation:
      | { type: "query_parameter"; parameter: string }
      | { type: "fixed_url"; url: string; input_parameter: string };
    max_keywords?: number;
    delay_between_keywords_ms?: number;
  };
  limits?: {
    delay_between_actions_ms?: number;
    max_records?: number;
    require_user_activation?: boolean;
  };
};

export type BrowserToolDownloadItemInput = {
  title: string;
  detailUrl: string;
};

export type BrowserToolDownloadItemResult = BrowserToolDownloadItemInput & {
  status: "pending" | "completed" | "failed" | "unavailable" | "needs_user";
  format: string;
  downloadId?: number;
  filename?: string;
  error?: string;
};

export type BrowserToolDownloadRunResult = {
  toolId: string;
  downloadDefinitionId: string;
  format: string;
  status: "completed" | "partial" | "paused" | "failed";
  startedAt: number;
  finishedAt: number;
  items: BrowserToolDownloadItemResult[];
  workerTabId?: number;
};

export type ResolveBrowserToolDownloadMessage = {
  type: "RESOLVE_BROWSER_TOOL_DOWNLOAD";
  definition: BrowserToolDownloadDefinition;
};

export type ClickBrowserToolDownloadMessage = {
  type: "CLICK_BROWSER_TOOL_DOWNLOAD";
  selector: string;
};

export type BrowserToolDownloadResolution = {
  blocker?: { status: "verification" | "login" | "permission"; message: string };
  resources: Record<string, string>;
};

export type BrowserToolRunStatus = "completed" | "partial" | "paused" | "cancelled" | "failed";

export type BrowserToolRunResult = {
  toolId: string;
  runId: string;
  pageUrl: string;
  pageTitle: string;
  startedAt: number;
  finishedAt: number;
  status: BrowserToolRunStatus;
  data: Record<string, Array<Record<string, unknown>>>;
  warnings: string[];
  error?: string;
};

export type StoredBrowserTool = {
  id: string;
  yaml: string;
  definition: BrowserToolDefinition;
  importedAt: number;
  updatedAt: number;
  source?: {
    type: "bundled" | "user";
    catalogVersion?: number;
  };
};

export type BrowserToolRunRecord = BrowserToolRunResult & {
  toolName: string;
  savedAt: number;
};

export type BrowserToolBatchProgress = {
  completedKeywords: number;
  totalKeywords: number;
  currentKeyword?: string;
};

export type BrowserToolManagerState = {
  tools: StoredBrowserTool[];
  recentRuns: BrowserToolRunRecord[];
  targetTab?: {
    id: number;
    title: string;
    url: string;
  };
  matchedToolIds: string[];
};

export type ExecuteBrowserToolMessage = {
  type: "EXECUTE_BROWSER_TOOL";
  definition: BrowserToolDefinition;
  parameters: Record<string, unknown>;
  progressId?: string;
};

export type BrowserToolExecutionProgress = {
  type: "BROWSER_TOOL_PROGRESS_UPDATE";
  progressId: string;
  toolId: string;
  scope: string;
  label: string;
  itemLabel?: string;
  current: number;
  total: number;
  recordCount: number;
};

export type BrowserToolExecutionProgressEvent = Omit<BrowserToolExecutionProgress, "type"> & {
  type: "BROWSER_TOOL_EXECUTION_PROGRESS";
};
