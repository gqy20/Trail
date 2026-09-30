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

export type BrowserToolNativeExportDefinition = {
  id: string;
  label: string;
  result_count_selector: string;
  menu_button_selector: string;
  menu_item_text: string;
  range_radio_selector: string;
  start_input_selector: string;
  end_input_selector: string;
  content_button_selector: string;
  content_option_text: string;
  submit_button_selector: string;
  max_batch: number;
  default_limit: number;
  max_limit: number;
  extension: string;
};

export type BrowserToolFieldDefinition = {
  selector?: string;
  attribute?: "text" | "href" | "src" | "content" | "datetime" | "aria_label";
  transforms?: BrowserToolTransformSpec[];
  optional?: boolean;
  multiple?: boolean;
};

/** 命名转换或 { match: 正则 }（取第一个捕获组）。 */
export type BrowserToolTransformSpec = BrowserToolTransform | { match: string };

export type BrowserToolTransform =
  | "trim"
  | "normalize_whitespace"
  | "parse_year"
  | "parse_number"
  | "parse_date"
  | "split_authors";

export type BrowserToolWaitForStep = {
  action: "wait_for";
  selector: string;
  timeout_ms?: number;
  optional?: boolean;
  visible?: boolean;
  text?: string;
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
  dedupe_by?: string;
};

export type BrowserToolRepeatStep = {
  action: "repeat";
  max: number | string;
  steps: BrowserToolStep[];
  between?: BrowserToolStep[];
  stop_after_unchanged?: number;
  stop_after_records?: number;
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
  selector?: string;
  /** 命中即暂停的 URL 片段，如登录 302 的 /login 或风控 error_code=300017。 */
  url_contains?: string;
  reason: string;
  timeout_ms?: number;
};

export type BrowserToolGraphqlFieldDefinition = {
  /** 相对命中节点的点路径；支持数字段作为数组下标。 */
  path: string;
  /** path 未命中时依次尝试的备选路径（如长文优先、正文兜底）。 */
  fallback_paths?: string[];
  /** path 指向数组时，从每个元素读取的子路径，返回字符串/数字数组。 */
  item_path?: string;
  transforms?: BrowserToolTransformSpec[];
  optional?: boolean;
};

export type BrowserToolStateReadField = {
  /** 相对命中节点的点路径。 */
  path?: string;
  fallback_paths?: string[];
  item_path?: string;
  /** 组合模板：{{ 字段名 }} 引用同记录已提取字段，{{ __page_url }} 为当前页地址。 */
  template?: string;
  transforms?: BrowserToolTransformSpec[];
  optional?: boolean;
};

export type BrowserToolStateReadStep = {
  action: "state_read";
  /** 主世界全局数据源，当前支持页面 SSR 注入的 __INITIAL_STATE__。 */
  source?: "__INITIAL_STATE__";
  extract: {
    collection: string;
    walk?: { has: string };
    fields: Record<string, BrowserToolStateReadField>;
    dedupe_by?: string;
  };
  max_items?: number | string;
  optional?: boolean;
};

export type BrowserToolGraphqlFetchStep = {
  action: "graphql_fetch";
  /** GraphQL 操作名，如 UserTweets；用于 queryId 解析和请求路径拼装。 */
  operation: string;
  variables?: Record<string, unknown>;
  features?: Record<string, boolean>;
  field_toggles?: Record<string, boolean>;
  /** 响应根路径 → values 存储，供后续步骤以 {{ values.name }} 引用。 */
  store?: Record<string, string>;
  extract?: {
    collection: string;
    /** 递归遍历响应，节点存在该点路径时命中（如 tweet_results.result）。 */
    walk?: { has: string };
    fields: Record<string, BrowserToolGraphqlFieldDefinition>;
    dedupe_by?: string;
  };
  /** 分页游标：遍历到 match_key === match_value 的节点时读取 value_path。 */
  cursor?: { match_key: string; match_value: string; value_path: string };
  max_pages?: number | string;
  page_delay_ms?: number;
  /** 页面 bundle 扫描失败时的 queryId 兜底（会随站点发布轮换）。 */
  query_id?: string;
  optional?: boolean;
};

export type BrowserToolStep =
  | { action: "if"; condition: { selector: string; visible?: boolean; text?: string }; then: BrowserToolStep[]; else?: BrowserToolStep[] }
  | { action: "finish"; outcome: "success" | "already_done"; message: string }
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
  | BrowserToolGraphqlFetchStep
  | BrowserToolStateReadStep
  | BrowserToolPauseStep;

export type BrowserToolDefinition = {
  checkin?: { entry_url: string; timezone: string };
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
  /** 声明后，成功运行中该集合的记录会自动进入订阅源暂存。 */
  feed?: { collection: string; platform: string; entry_url?: string };
  /** 增量采集：记录中发布时间字段与首次回填窗口（天）；声明后按 平台+账号 水位线过滤。 */
  since?: { field: string; lookback_days?: number };
  /** 主工作流提取卡片后，由后台串行进入详情页补全字段（不经工作流导航）。 */
  detail_extract?: {
    collection: string;
    url_field: string;
    fields: Record<string, BrowserToolFieldDefinition>;
    wait_for?: string;
    timeout_ms?: number;
    max_items?: number;
    delay_ms?: number;
    /** 记录中取内容 id 的字段，用于定位 a[href*=id] 卡片。 */
    id_field?: string;
    /** 详情页的返回按钮选择器（点击真实卡片进入，点返回回列表）。 */
    back_selector?: string;
    blockers?: Array<{ selector?: string; url_contains?: string; reason: string }>;
  };
  downloads?: BrowserToolDownloadDefinition[];
  native_exports?: BrowserToolNativeExportDefinition[];
  batch?: {
    navigation:
      | { type: "query_parameter"; parameter: string }
      | { type: "fixed_url"; url: string; input_parameter: string };
    max_keywords?: number;
    /** 数字或 "{{ parameters.x }}" 模板，便于把节奏参数暴露给用户。 */
    delay_between_keywords_ms?: number | string;
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
  /** 预算暂停不属于登录/验证拦截，不触发冷却重试。 */
  pauseReason?: "budget";
  outcome?: "success" | "already_done";
  message?: string;
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
  nativeExports?: Array<{
    query: string;
    totalRecords: number;
    exportedRecords: number;
    files: string[];
    error?: string;
  }>;
};

export type StoredBrowserTool = {
  id: string;
  enabled?: boolean;
  yaml: string;
  definition: BrowserToolDefinition;
  importedAt: number;
  updatedAt: number;
  source?: {
    type: "bundled" | "user";
    catalogVersion?: number;
    backupOf?: string;
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
  backups?: StoredBrowserTool[];
  bundledVersions?: Record<string, string>;
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

export type GetBrowserToolNativeExportCountMessage = {
  type: "GET_BROWSER_TOOL_NATIVE_EXPORT_COUNT";
  definition: BrowserToolNativeExportDefinition;
};

export type RunBrowserToolNativeExportBatchMessage = {
  type: "RUN_BROWSER_TOOL_NATIVE_EXPORT_BATCH";
  definition: BrowserToolNativeExportDefinition;
  from: number;
  to: number;
};
