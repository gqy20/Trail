export type BrowserToolParameterType = "string" | "number" | "boolean";

export type BrowserToolParameterDefinition = {
  type: BrowserToolParameterType;
  label?: string;
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
  presentation?: {
    placement?: "primary" | "advanced";
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

export type BrowserToolFieldDefinition = {
  selector?: string;
  attribute?: "text" | "href" | "content" | "datetime";
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
};

export type BrowserToolPauseStep = {
  action: "pause_for_user";
  reason: string;
};

export type BrowserToolStep =
  | BrowserToolWaitForStep
  | BrowserToolFillStep
  | BrowserToolSelectStep
  | BrowserToolClickStep
  | BrowserToolWaitStep
  | BrowserToolWaitForChangeStep
  | BrowserToolExtractStep
  | BrowserToolRepeatStep
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
  batch?: {
    navigation: {
      type: "query_parameter";
      parameter: string;
    };
    max_keywords?: number;
    delay_between_keywords_ms?: number;
  };
  limits?: {
    delay_between_actions_ms?: number;
    max_records?: number;
    require_user_activation?: boolean;
  };
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
};
