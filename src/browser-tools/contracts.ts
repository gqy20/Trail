export type BrowserToolParameterType = "string" | "number" | "boolean";

export type BrowserToolParameterDefinition = {
  type: BrowserToolParameterType;
  label?: string;
  required?: boolean;
  default?: string | number | boolean;
  min?: number;
  max?: number;
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
