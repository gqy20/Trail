import { parseDocument } from "yaml";
import type {
  BrowserToolCollectionPresentation,
  BrowserToolDefinition,
  BrowserToolDownloadDefinition,
  BrowserToolFieldDefinition,
  BrowserToolGraphqlFieldDefinition,
  BrowserToolGraphqlFetchStep,
  BrowserToolParameterDefinition,
  BrowserToolPresentation,
  BrowserToolStep,
  BrowserToolTransform
} from "./contracts";
import { BROWSER_TOOL_LIMITS } from "./limits";
import { matchesBrowserTool } from "./matcher";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const COLLECTION_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const PRESENTATION_FIELD_PATTERN = /^[a-z_][a-z0-9_-]{0,63}$/;
const TRANSFORMS = new Set<BrowserToolTransform>([
  "trim",
  "normalize_whitespace",
  "parse_year",
  "parse_number",
  "parse_date",
  "split_authors"
]);

export function parseBrowserToolYaml(source: string): BrowserToolDefinition {
  if (!source.trim()) throw new Error("Browser Tool YAML 不能为空。");
  if (source.length > BROWSER_TOOL_LIMITS.maxYamlLength) throw new Error("Browser Tool YAML 过大。");

  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) throw new Error(document.errors[0].message);

  const value = document.toJS({ maxAliasCount: 10 }) as unknown;
  return validateBrowserToolDefinition(value);
}

export function validateBrowserToolDefinition(value: unknown): BrowserToolDefinition {
  const root = asRecord(value, "工具定义");
  if (root.schema_version !== 1) throw new Error("只支持 schema_version: 1。");

  const id = readString(root.id, "id");
  if (!ID_PATTERN.test(id)) throw new Error("id 只能包含小写字母、数字、点、下划线和连字符。");

  const match = asRecord(root.match, "match");
  const domains = readStringArray(match.domains, "match.domains");
  if (domains.length === 0) throw new Error("match.domains 至少需要一个域名。");

  const selectors = root.selectors === undefined ? undefined : readStringMap(root.selectors, "selectors");
  selectors && Object.values(selectors).forEach((selector) => validateSelector(selector));

  const parameters = root.parameters === undefined ? undefined : validateParameters(root.parameters);
  const workflowValue = asArray(root.workflow, "workflow");
  let stepCount = 0;
  const workflow = validateSteps(workflowValue, 0, () => {
    stepCount += 1;
    if (stepCount > BROWSER_TOOL_LIMITS.maxWorkflowSteps) throw new Error("workflow 步骤过多。");
  });
  if (workflow.length === 0) throw new Error("workflow 不能为空。");

  const limits = root.limits === undefined ? undefined : validateLimits(root.limits);
  const batch = root.batch === undefined ? undefined : validateBatch(root.batch);
  if (batch?.navigation.type === "fixed_url" && parameters?.[batch.navigation.input_parameter]?.type !== "string") {
    throw new Error("batch.navigation.input_parameter 必须引用已声明的字符串参数。");
  }
  const presentation = root.presentation === undefined ? undefined : validatePresentation(root.presentation);
  let feed: BrowserToolDefinition["feed"];
  if (root.feed !== undefined) {
    const source = asRecord(root.feed, "feed");
    const collection = readString(source.collection, "feed.collection");
    if (!COLLECTION_PATTERN.test(collection)) throw new Error("feed.collection 无效。");
    const platform = readString(source.platform, "feed.platform");
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(platform)) throw new Error("feed.platform 无效。");
    let entryUrl: string | undefined;
    if (source.entry_url !== undefined) {
      entryUrl = readString(source.entry_url, "feed.entry_url");
      const url = new URL(entryUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("feed.entry_url 必须是无凭证的 HTTPS URL。");
      if (!matchesBrowserTool({ match: { domains, urls: match.urls as string[] | undefined } } as BrowserToolDefinition, entryUrl)) {
        throw new Error("feed.entry_url 必须匹配工具的域名和 URL。");
      }
    }
    feed = { collection, platform, entry_url: entryUrl };
  }
  const downloads = root.downloads === undefined ? undefined : validateDownloads(root.downloads);
  const nativeExports = root.native_exports === undefined ? undefined : validateNativeExports(root.native_exports);
  let checkin: BrowserToolDefinition["checkin"];
  if (root.checkin !== undefined) {
    const source = asRecord(root.checkin, "checkin");
    const entryUrl = readString(source.entry_url, "checkin.entry_url");
    const url = new URL(entryUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("签到入口必须是无凭证的 HTTPS URL。");
    const timezone = readString(source.timezone, "checkin.timezone");
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format();
    if (!matchesBrowserTool({ match: { domains, urls: match.urls as string[] | undefined } } as BrowserToolDefinition, entryUrl)) {
      throw new Error("签到入口必须匹配工具的域名和 URL。");
    }
    checkin = { entry_url: entryUrl, timezone };
  }

  return {
    schema_version: 1,
    checkin,
    id,
    name: readString(root.name, "name"),
    description: readOptionalString(root.description, "description"),
    version: readString(root.version, "version"),
    match: {
      domains,
      urls: match.urls === undefined ? undefined : readStringArray(match.urls, "match.urls")
    },
    parameters,
    selectors,
    workflow,
    presentation,
    feed,
    downloads,
    native_exports: nativeExports,
    batch,
    limits
  };
}

function validateNativeExports(value: unknown): NonNullable<BrowserToolDefinition["native_exports"]> {
  const entries = asArray(value, "native_exports");
  if (entries.length === 0 || entries.length > 5) throw new Error("native_exports 需要包含 1-5 个定义。");
  const ids = new Set<string>();
  return entries.map((raw, index) => {
    const path = `native_exports[${index}]`;
    const source = asRecord(raw, path);
    const id = readString(source.id, `${path}.id`);
    if (!COLLECTION_PATTERN.test(id) || ids.has(id)) throw new Error(`${path}.id 无效或重复。`);
    ids.add(id);
    const readSelector = (name: string) => validatedSelector(source[name], `${path}.${name}`);
    const maxBatch = readNumber(source.max_batch, `${path}.max_batch`);
    const defaultLimit = readNumber(source.default_limit, `${path}.default_limit`);
    const maxLimit = readNumber(source.max_limit, `${path}.max_limit`);
    if (!Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 5_000) throw new Error(`${path}.max_batch 无效。`);
    if (!Number.isInteger(defaultLimit) || defaultLimit < 1 || defaultLimit > maxLimit) throw new Error(`${path}.default_limit 无效。`);
    if (!Number.isInteger(maxLimit) || maxLimit < maxBatch || maxLimit > 50_000) throw new Error(`${path}.max_limit 无效。`);
    const extension = readString(source.extension, `${path}.extension`);
    if (!/^[a-z0-9]{1,10}$/i.test(extension)) throw new Error(`${path}.extension 无效。`);
    return {
      id,
      label: validateUiText(readString(source.label, `${path}.label`), `${path}.label`),
      result_count_selector: readSelector("result_count_selector"),
      menu_button_selector: readSelector("menu_button_selector"),
      menu_item_text: validateUiText(readString(source.menu_item_text, `${path}.menu_item_text`), `${path}.menu_item_text`),
      range_radio_selector: readSelector("range_radio_selector"),
      start_input_selector: readSelector("start_input_selector"),
      end_input_selector: readSelector("end_input_selector"),
      content_button_selector: readSelector("content_button_selector"),
      content_option_text: validateUiText(readString(source.content_option_text, `${path}.content_option_text`), `${path}.content_option_text`),
      submit_button_selector: readSelector("submit_button_selector"),
      max_batch: maxBatch,
      default_limit: defaultLimit,
      max_limit: maxLimit,
      extension
    };
  });
}

function validateDownloads(value: unknown): BrowserToolDownloadDefinition[] {
  const entries = asArray(value, "downloads");
  if (entries.length === 0 || entries.length > 10) throw new Error("downloads 需要包含 1-10 个下载定义。");
  const ids = new Set<string>();
  return entries.map((raw, index) => {
    const path = `downloads[${index}]`;
    const source = asRecord(raw, path);
    const id = readString(source.id, `${path}.id`);
    if (!COLLECTION_PATTERN.test(id) || ids.has(id)) throw new Error(`${path}.id 无效或重复。`);
    ids.add(id);
    const collection = readString(source.collection, `${path}.collection`);
    if (!COLLECTION_PATTERN.test(collection)) throw new Error(`${path}.collection 无效。`);
    const detailUrlField = readString(source.detail_url_field, `${path}.detail_url_field`);
    if (!PRESENTATION_FIELD_PATTERN.test(detailUrlField)) throw new Error(`${path}.detail_url_field 无效。`);
    const titleField = readOptionalString(source.title_field, `${path}.title_field`);
    if (titleField && !PRESENTATION_FIELD_PATTERN.test(titleField)) throw new Error(`${path}.title_field 无效。`);

    const rawFormats = asRecord(source.formats, `${path}.formats`);
    const formats: BrowserToolDownloadDefinition["formats"] = {};
    const formatEntries = Object.entries(rawFormats);
    if (formatEntries.length === 0 || formatEntries.length > 8) throw new Error(`${path}.formats 需要包含 1-8 个格式。`);
    for (const [formatId, rawFormat] of formatEntries) {
      if (!COLLECTION_PATTERN.test(formatId)) throw new Error(`${path}.formats.${formatId} 名称无效。`);
      const format = asRecord(rawFormat, `${path}.formats.${formatId}`);
      const selector = readString(format.selector, `${path}.formats.${formatId}.selector`);
      validateSelector(selector);
      const extension = readOptionalString(format.extension, `${path}.formats.${formatId}.extension`);
      if (extension && !/^[a-z0-9]{1,10}$/i.test(extension)) throw new Error(`${path}.formats.${formatId}.extension 无效。`);
      formats[formatId] = {
        label: validateUiText(readString(format.label, `${path}.formats.${formatId}.label`), `${path}.formats.${formatId}.label`),
        selector,
        extension
      };
    }

    const blockers = source.blockers === undefined ? undefined : asArray(source.blockers, `${path}.blockers`).map((rawBlocker, blockerIndex) => {
      const blockerPath = `${path}.blockers[${blockerIndex}]`;
      const blocker = asRecord(rawBlocker, blockerPath);
      const selector = readString(blocker.selector, `${blockerPath}.selector`);
      validateSelector(selector);
      const status = readString(blocker.status, `${blockerPath}.status`);
      if (status !== "verification" && status !== "login" && status !== "permission") throw new Error(`${blockerPath}.status 无效。`);
      return {
        selector,
        status,
        message: validateUiText(readString(blocker.message, `${blockerPath}.message`), `${blockerPath}.message`, 200)
      } as NonNullable<BrowserToolDownloadDefinition["blockers"]>[number];
    });
    const maxItems = readOptionalNumber(source.max_items, `${path}.max_items`);
    if (maxItems !== undefined && (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 50)) throw new Error(`${path}.max_items 必须是 1-50 的整数。`);
    const delay = readOptionalNumber(source.delay_ms, `${path}.delay_ms`);
    if (delay !== undefined && (delay < 0 || delay > 10_000)) throw new Error(`${path}.delay_ms 超出范围。`);

    return {
      id,
      label: validateUiText(readString(source.label, `${path}.label`), `${path}.label`),
      collection,
      detail_url_field: detailUrlField,
      title_field: titleField,
      formats,
      blockers,
      allowed_domains: source.allowed_domains === undefined ? undefined : readStringArray(source.allowed_domains, `${path}.allowed_domains`),
      max_items: maxItems,
      delay_ms: delay
    };
  });
}

function validatePresentation(value: unknown): BrowserToolPresentation {
  const source = asRecord(value, "presentation");
  const batchInput = source.batch_input === undefined ? undefined : asRecord(source.batch_input, "presentation.batch_input");
  const composer = batchInput?.composer === undefined ? undefined : asRecord(batchInput.composer, "presentation.batch_input.composer");
  const actions = source.actions === undefined ? undefined : asRecord(source.actions, "presentation.actions");
  const results = source.results === undefined ? undefined : asRecord(source.results, "presentation.results");
  const importFormats = batchInput?.import_formats === undefined
    ? undefined
    : readStringArray(batchInput.import_formats, "presentation.batch_input.import_formats");
  importFormats?.forEach((format) => {
    if (format !== "txt" && format !== "csv") throw new Error(`presentation.batch_input.import_formats 不支持：${format}`);
  });
  const composerOperators = composer?.operators === undefined
    ? undefined
    : readStringArray(composer.operators, "presentation.batch_input.composer.operators").map((operator, index) =>
        validateUiText(operator, `presentation.batch_input.composer.operators[${index}]`, 16)
      );
  if (composerOperators && (composerOperators.length === 0 || composerOperators.length > 8)) {
    throw new Error("presentation.batch_input.composer.operators 需要包含 1-8 个连接符。");
  }
  if (composerOperators && new Set(composerOperators).size !== composerOperators.length) {
    throw new Error("presentation.batch_input.composer.operators 不能重复。");
  }
  const defaultOperator = readOptionalUiText(composer?.default_operator, "presentation.batch_input.composer.default_operator", 16);
  if (defaultOperator && !(composerOperators || ["AND", "OR"]).includes(defaultOperator)) {
    throw new Error("presentation.batch_input.composer.default_operator 必须包含在 operators 中。");
  }
  const composerMaxGroups = readOptionalNumber(composer?.max_groups, "presentation.batch_input.composer.max_groups");
  if (composerMaxGroups !== undefined && (!Number.isInteger(composerMaxGroups) || composerMaxGroups < 2 || composerMaxGroups > 6)) {
    throw new Error("presentation.batch_input.composer.max_groups 必须是 2-6 的整数。");
  }

  return {
    title: readOptionalUiText(source.title, "presentation.title"),
    source_label: readOptionalUiText(source.source_label, "presentation.source_label"),
    batch_input: batchInput
      ? {
          label: readOptionalUiText(batchInput.label, "presentation.batch_input.label"),
          placeholder: readOptionalUiText(batchInput.placeholder, "presentation.batch_input.placeholder", 500),
          item_label: readOptionalUiText(batchInput.item_label, "presentation.batch_input.item_label"),
          count_unit: readOptionalUiText(batchInput.count_unit, "presentation.batch_input.count_unit", 12),
          import_formats: importFormats as Array<"txt" | "csv"> | undefined,
          csv_headers: batchInput.csv_headers === undefined
            ? undefined
            : readStringArray(batchInput.csv_headers, "presentation.batch_input.csv_headers").map((header, index) =>
                validateUiText(header, `presentation.batch_input.csv_headers[${index}]`)
              ),
          composer: composer
            ? {
                enabled: readOptionalBoolean(composer.enabled, "presentation.batch_input.composer.enabled"),
                label: readOptionalUiText(composer.label, "presentation.batch_input.composer.label"),
                group_label: readOptionalUiText(composer.group_label, "presentation.batch_input.composer.group_label"),
                placeholder: readOptionalUiText(composer.placeholder, "presentation.batch_input.composer.placeholder", 300),
                operators: composerOperators,
                default_operator: defaultOperator,
                max_groups: composerMaxGroups
              }
            : undefined
        }
      : undefined,
    actions: actions
      ? {
          run: readOptionalUiText(actions.run, "presentation.actions.run"),
          run_empty: readOptionalUiText(actions.run_empty, "presentation.actions.run_empty"),
          running: readOptionalUiText(actions.running, "presentation.actions.running"),
          single_run: readOptionalUiText(actions.single_run, "presentation.actions.single_run"),
          single_running: readOptionalUiText(actions.single_running, "presentation.actions.single_running")
        }
      : undefined,
    results: results
      ? {
          title: readOptionalUiText(results.title, "presentation.results.title"),
          item_label: readOptionalUiText(results.item_label, "presentation.results.item_label"),
          count_unit: readOptionalUiText(results.count_unit, "presentation.results.count_unit", 12),
          empty_title: readOptionalUiText(results.empty_title, "presentation.results.empty_title"),
          empty_description: readOptionalUiText(results.empty_description, "presentation.results.empty_description", 300)
        }
      : undefined,
    collections: source.collections === undefined ? undefined : validateCollectionPresentations(source.collections)
  };
}

function validateCollectionPresentations(value: unknown): Record<string, BrowserToolCollectionPresentation> {
  const source = asRecord(value, "presentation.collections");
  const collections: Record<string, BrowserToolCollectionPresentation> = {};
  for (const [collectionName, rawCollection] of Object.entries(source)) {
    if (!COLLECTION_PATTERN.test(collectionName)) throw new Error(`presentation.collections.${collectionName} 名称无效。`);
    const collection = asRecord(rawCollection, `presentation.collections.${collectionName}`);
    const fieldsSource = collection.fields === undefined
      ? undefined
      : asRecord(collection.fields, `presentation.collections.${collectionName}.fields`);
    const fields: NonNullable<BrowserToolCollectionPresentation["fields"]> = {};
    for (const [fieldName, rawField] of Object.entries(fieldsSource || {})) {
      if (!PRESENTATION_FIELD_PATTERN.test(fieldName)) throw new Error(`presentation.collections.${collectionName}.fields.${fieldName} 名称无效。`);
      const field = asRecord(rawField, `presentation.collections.${collectionName}.fields.${fieldName}`);
      const display = field.display === undefined ? undefined : readString(field.display, `presentation.collections.${collectionName}.fields.${fieldName}.display`);
      if (display !== undefined && display !== "text" && display !== "link") throw new Error(`presentation.collections.${collectionName}.fields.${fieldName}.display 无效。`);
      const emphasis = field.emphasis === undefined ? undefined : readString(field.emphasis, `presentation.collections.${collectionName}.fields.${fieldName}.emphasis`);
      if (emphasis !== undefined && emphasis !== "primary" && emphasis !== "secondary") throw new Error(`presentation.collections.${collectionName}.fields.${fieldName}.emphasis 无效。`);
      const order = readOptionalNumber(field.order, `presentation.collections.${collectionName}.fields.${fieldName}.order`);
      if (order !== undefined && (!Number.isInteger(order) || order < 0 || order > 10_000)) throw new Error(`presentation.collections.${collectionName}.fields.${fieldName}.order 无效。`);
      fields[fieldName] = {
        label: readOptionalUiText(field.label, `presentation.collections.${collectionName}.fields.${fieldName}.label`),
        order,
        display: display as "text" | "link" | undefined,
        emphasis: emphasis as "primary" | "secondary" | undefined
      };
    }
    collections[collectionName] = {
      label: readOptionalUiText(collection.label, `presentation.collections.${collectionName}.label`),
      item_label: readOptionalUiText(collection.item_label, `presentation.collections.${collectionName}.item_label`),
      count_unit: readOptionalUiText(collection.count_unit, `presentation.collections.${collectionName}.count_unit`, 12),
      fields: fieldsSource ? fields : undefined
    };
  }
  return collections;
}

function validateBatch(value: unknown): BrowserToolDefinition["batch"] {
  const batch = asRecord(value, "batch");
  const navigation = asRecord(batch.navigation, "batch.navigation");
  let validatedNavigation: NonNullable<BrowserToolDefinition["batch"]>["navigation"];
  if (navigation.type === "query_parameter") {
    const parameter = readString(navigation.parameter, "batch.navigation.parameter");
    if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(parameter)) throw new Error("batch.navigation.parameter 无效。");
    validatedNavigation = { type: "query_parameter", parameter };
  } else if (navigation.type === "fixed_url") {
    const url = readString(navigation.url, "batch.navigation.url");
    // 模板 URL（如 https://x.com/{{ parameters.username }}）在运行时按批次渲染；
    // 校验协议时先剥掉 {{ ... }} 占位符，存储时保留原文。
    const containsTemplate = url.includes("{{");
    const parsedUrl = new URL(containsTemplate ? url.replace(/\{\{[^}]*\}\}/g, "trail") : url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("batch.navigation.url 只支持 HTTP(S)。");
    const inputParameter = readString(navigation.input_parameter, "batch.navigation.input_parameter");
    if (!COLLECTION_PATTERN.test(inputParameter)) throw new Error("batch.navigation.input_parameter 无效。");
    validatedNavigation = { type: "fixed_url", url: containsTemplate ? url : parsedUrl.href, input_parameter: inputParameter };
  } else {
    throw new Error("batch.navigation.type 只支持 query_parameter 或 fixed_url。");
  }

  const maxKeywords = readOptionalNumber(batch.max_keywords, "batch.max_keywords");
  if (maxKeywords !== undefined && (!Number.isInteger(maxKeywords) || maxKeywords < 1 || maxKeywords > BROWSER_TOOL_LIMITS.maxBatchKeywords)) {
    throw new Error(`batch.max_keywords 必须是 1-${BROWSER_TOOL_LIMITS.maxBatchKeywords} 的整数。`);
  }
  const delay = typeof batch.delay_between_keywords_ms === "string"
    ? readString(batch.delay_between_keywords_ms, "batch.delay_between_keywords_ms")
    : readOptionalNumber(batch.delay_between_keywords_ms, "batch.delay_between_keywords_ms");
  if (typeof delay === "string" && !/\{\{\s*parameters\.[a-zA-Z0-9_-]+\s*\}\}/.test(delay)) {
    throw new Error("batch.delay_between_keywords_ms 字符串必须引用 parameters 中的数字参数。");
  }
  if (typeof delay === "number" && (delay < 0 || delay > BROWSER_TOOL_LIMITS.maxBatchDelayMs)) {
    throw new Error("batch.delay_between_keywords_ms 超出范围。");
  }

  return {
    navigation: validatedNavigation,
    max_keywords: maxKeywords,
    delay_between_keywords_ms: delay
  };
}

function validateParameters(value: unknown): Record<string, BrowserToolParameterDefinition> {
  const source = asRecord(value, "parameters");
  const result: Record<string, BrowserToolParameterDefinition> = {};
  for (const [name, rawDefinition] of Object.entries(source)) {
    if (!COLLECTION_PATTERN.test(name)) throw new Error(`无效参数名：${name}`);
    const definition = asRecord(rawDefinition, `parameters.${name}`);
    const type = definition.type;
    if (type !== "string" && type !== "number" && type !== "boolean") {
      throw new Error(`parameters.${name}.type 无效。`);
    }
    result[name] = {
      type,
      label: readOptionalString(definition.label, `parameters.${name}.label`),
      required: readOptionalBoolean(definition.required, `parameters.${name}.required`),
      default: validateParameterDefault(definition.default, type, name),
      min: readOptionalNumber(definition.min, `parameters.${name}.min`),
      max: readOptionalNumber(definition.max, `parameters.${name}.max`),
      presentation: definition.presentation === undefined
        ? undefined
        : validateParameterPresentation(definition.presentation, name)
    };
  }
  return result;
}

function validateParameterPresentation(value: unknown, name: string): BrowserToolParameterDefinition["presentation"] {
  const source = asRecord(value, `parameters.${name}.presentation`);
  const placement = source.placement === undefined ? undefined : readString(source.placement, `parameters.${name}.presentation.placement`);
  if (placement !== undefined && placement !== "primary" && placement !== "advanced" && placement !== "hidden") throw new Error(`parameters.${name}.presentation.placement 无效。`);
  const style = source.style === undefined ? undefined : readString(source.style, `parameters.${name}.presentation.style`);
  if (style !== undefined && style !== "field" && style !== "sentence") throw new Error(`parameters.${name}.presentation.style 无效。`);
  return {
    placement: placement as "primary" | "advanced" | undefined,
    style: style as "field" | "sentence" | undefined,
    prefix: readOptionalUiText(source.prefix, `parameters.${name}.presentation.prefix`),
    suffix: readOptionalUiText(source.suffix, `parameters.${name}.presentation.suffix`)
  };
}

function validateParameterDefault(
  value: unknown,
  type: BrowserToolParameterDefinition["type"],
  name: string
): string | number | boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== type) throw new Error(`parameters.${name}.default 类型不正确。`);
  return value as string | number | boolean;
}

function validateSteps(values: unknown[], depth: number, countStep: () => void): BrowserToolStep[] {
  if (depth > BROWSER_TOOL_LIMITS.maxNestedDepth) throw new Error("repeat 嵌套过深。");

  return values.map((value, index) => {
    countStep();
    const path = `workflow[${index}]`;
    const step = asRecord(value, path);
    const action = readString(step.action, `${path}.action`);

    switch (action) {
      case "wait_for":
        return {
          action,
          visible: readOptionalBoolean(step.visible, `${path}.visible`),
          text: readOptionalUiText(step.text, `${path}.text`, 300),
          selector: validatedSelector(step.selector, `${path}.selector`),
          timeout_ms: validatedTimeout(step.timeout_ms, `${path}.timeout_ms`),
          optional: readOptionalBoolean(step.optional, `${path}.optional`)
        };
      case "fill":
        return {
          action,
          selector: validatedSelector(step.selector, `${path}.selector`),
          value: readString(step.value, `${path}.value`, true),
          clear: readOptionalBoolean(step.clear, `${path}.clear`)
        };
      case "select":
        return {
          action,
          selector: validatedSelector(step.selector, `${path}.selector`),
          value: readString(step.value, `${path}.value`, true)
        };
      case "click": {
        const change = step.wait_for_change === undefined ? undefined : asRecord(step.wait_for_change, `${path}.wait_for_change`);
        return {
          action,
          selector: validatedSelector(step.selector, `${path}.selector`),
          optional: readOptionalBoolean(step.optional, `${path}.optional`),
          stop_repeat_on_missing: readOptionalBoolean(step.stop_repeat_on_missing, `${path}.stop_repeat_on_missing`),
          wait_for_change: change
            ? {
                selector: validatedSelector(change.selector, `${path}.wait_for_change.selector`),
                timeout_ms: validatedTimeout(change.timeout_ms, `${path}.wait_for_change.timeout_ms`)
              }
            : undefined
        };
      }
      case "wait": {
        const duration = readNumber(step.duration_ms, `${path}.duration_ms`);
        if (duration < 0 || duration > BROWSER_TOOL_LIMITS.maxWaitMs) throw new Error(`${path}.duration_ms 超出范围。`);
        return { action, duration_ms: duration };
      }
      case "scroll": {
        const delta = readOptionalNumber(step.delta_y, `${path}.delta_y`);
        const position = step.position === undefined ? undefined : readString(step.position, `${path}.position`);
        if ((delta === undefined) === (position === undefined)) throw new Error(`${path} 必须且只能声明 delta_y 或 position。`);
        if (delta !== undefined && (!Number.isInteger(delta) || Math.abs(delta) > 5_000)) throw new Error(`${path}.delta_y 超出范围。`);
        if (position !== undefined && position !== "top" && position !== "bottom") throw new Error(`${path}.position 无效。`);
        return {
          action,
          selector: step.selector === undefined ? undefined : validatedSelector(step.selector, `${path}.selector`),
          delta_y: delta,
          position: position as "top" | "bottom" | undefined
        };
      }
      case "wait_for_change":
        return {
          action,
          selector: validatedSelector(step.selector, `${path}.selector`),
          timeout_ms: validatedTimeout(step.timeout_ms, `${path}.timeout_ms`),
          optional: readOptionalBoolean(step.optional, `${path}.optional`)
        };
      case "pause_if_present":
        return {
          action,
          selector: validatedSelector(step.selector, `${path}.selector`),
          reason: validateUiText(readString(step.reason, `${path}.reason`), `${path}.reason`, 300),
          timeout_ms: validatedTimeout(step.timeout_ms, `${path}.timeout_ms`)
        };
      case "extract": {
        const collection = readString(step.collection, `${path}.collection`);
        if (!COLLECTION_PATTERN.test(collection)) throw new Error(`${path}.collection 无效。`);
        const fieldsSource = asRecord(step.fields, `${path}.fields`);
        const fields: Record<string, BrowserToolFieldDefinition> = {};
        for (const [fieldName, rawField] of Object.entries(fieldsSource)) {
          if (!COLLECTION_PATTERN.test(fieldName)) throw new Error(`${path}.fields.${fieldName} 名称无效。`);
          const field = asRecord(rawField, `${path}.fields.${fieldName}`);
          const attribute = field.attribute === undefined ? "text" : readString(field.attribute, `${path}.fields.${fieldName}.attribute`);
          if (!["text", "href", "content", "datetime", "aria_label"].includes(attribute)) {
            throw new Error(`${path}.fields.${fieldName}.attribute 不在白名单内。`);
          }
          const transforms = field.transforms === undefined ? undefined : readStringArray(field.transforms, `${path}.fields.${fieldName}.transforms`);
          transforms?.forEach((transform) => {
            if (!TRANSFORMS.has(transform as BrowserToolTransform)) throw new Error(`未知转换：${transform}`);
          });
          fields[fieldName] = {
            selector: field.selector === undefined ? undefined : validatedSelector(field.selector, `${path}.fields.${fieldName}.selector`),
            attribute: attribute as BrowserToolFieldDefinition["attribute"],
            transforms: transforms as BrowserToolTransform[] | undefined,
            optional: readOptionalBoolean(field.optional, `${path}.fields.${fieldName}.optional`),
            multiple: readOptionalBoolean(field.multiple, `${path}.fields.${fieldName}.multiple`)
          };
        }
        if (Object.keys(fields).length === 0) throw new Error(`${path}.fields 不能为空。`);
        const dedupeBy = readOptionalString(step.dedupe_by, `${path}.dedupe_by`);
        if (dedupeBy && !(dedupeBy in fields)) throw new Error(`${path}.dedupe_by 必须引用已声明字段。`);
        return {
          action,
          collection,
          selector: validatedSelector(step.selector, `${path}.selector`),
          fields,
          dedupe_by: dedupeBy
        };
      }
      case "repeat": {
        const max = typeof step.max === "string" ? readString(step.max, `${path}.max`) : readNumber(step.max, `${path}.max`);
        if (typeof max === "number" && (!Number.isInteger(max) || max < 1 || max > BROWSER_TOOL_LIMITS.maxRepeat)) {
          throw new Error(`${path}.max 必须是 1-${BROWSER_TOOL_LIMITS.maxRepeat} 的整数或参数模板。`);
        }
        if (typeof max === "string" && !/\{\{\s*parameters\.[a-zA-Z0-9_-]+\s*\}\}|\$\{parameters\.[a-zA-Z0-9_-]+\}/.test(max)) {
          throw new Error(`${path}.max 字符串必须引用 parameters 中的数字参数。`);
        }
        const progress = step.progress === undefined ? undefined : asRecord(step.progress, `${path}.progress`);
        const stopAfterUnchanged = readOptionalNumber(step.stop_after_unchanged, `${path}.stop_after_unchanged`);
        if (stopAfterUnchanged !== undefined && (!Number.isInteger(stopAfterUnchanged) || stopAfterUnchanged < 1 || stopAfterUnchanged > 10)) {
          throw new Error(`${path}.stop_after_unchanged 必须是 1-10 的整数。`);
        }
        const stopAfterRecords = readOptionalNumber(step.stop_after_records, `${path}.stop_after_records`);
        if (stopAfterRecords !== undefined && (!Number.isInteger(stopAfterRecords) || stopAfterRecords < 1 || stopAfterRecords > BROWSER_TOOL_LIMITS.maxRecords)) {
          throw new Error(`${path}.stop_after_records 必须是 1-${BROWSER_TOOL_LIMITS.maxRecords} 的整数。`);
        }
        const progressScope = progress ? readString(progress.scope, `${path}.progress.scope`) : undefined;
        if (progressScope && !COLLECTION_PATTERN.test(progressScope)) throw new Error(`${path}.progress.scope 无效。`);
        return {
          action,
          max,
          steps: validateSteps(asArray(step.steps, `${path}.steps`), depth + 1, countStep),
          between:
            step.between === undefined
              ? undefined
              : validateSteps(asArray(step.between, `${path}.between`), depth + 1, countStep),
          stop_after_unchanged: stopAfterUnchanged,
          stop_after_records: stopAfterRecords,
          progress: progress
            ? {
                scope: progressScope!,
                label: validateUiText(readString(progress.label, `${path}.progress.label`), `${path}.progress.label`),
                item_label: readOptionalUiText(progress.item_label, `${path}.progress.item_label`)
              }
            : undefined
        };
      }
      case "pause_for_user":
        return { action, reason: readString(step.reason, `${path}.reason`) };
      case "if": {
        const condition = asRecord(step.condition, `${path}.condition`);
        return {
          action,
          condition: {
            selector: validatedSelector(condition.selector, `${path}.condition.selector`),
            visible: readOptionalBoolean(condition.visible, `${path}.condition.visible`),
            text: readOptionalUiText(condition.text, `${path}.condition.text`, 300)
          },
          then: validateSteps(asArray(step.then, `${path}.then`), depth + 1, countStep),
          else: step.else === undefined ? undefined : validateSteps(asArray(step.else, `${path}.else`), depth + 1, countStep)
        };
      }
      case "finish": {
        const outcome = readString(step.outcome, `${path}.outcome`);
        if (outcome !== "success" && outcome !== "already_done") throw new Error("finish.outcome 无效。");
        return { action, outcome, message: validateUiText(readString(step.message, `${path}.message`), `${path}.message`, 300) };
      }
      case "graphql_fetch": {
        const operation = readString(step.operation, `${path}.operation`);
        if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(operation)) throw new Error(`${path}.operation 无效。`);
        const queryId = readOptionalString(step.query_id, `${path}.query_id`);
        if (queryId !== undefined && !/^[A-Za-z0-9_-]{3,80}$/.test(queryId)) throw new Error(`${path}.query_id 无效。`);
        const maxPages = typeof step.max_pages === "string"
          ? readString(step.max_pages, `${path}.max_pages`)
          : readOptionalNumber(step.max_pages, `${path}.max_pages`);
        if (typeof maxPages === "string" && !/\{\{\s*(parameters|values)\.[a-zA-Z0-9_-]+\s*\}\}/.test(maxPages)) {
          throw new Error(`${path}.max_pages 字符串必须引用参数或存储值。`);
        }
        if (typeof maxPages === "number" && (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 20)) {
          throw new Error(`${path}.max_pages 必须是 1-20 的整数。`);
        }
        const pageDelay = readOptionalNumber(step.page_delay_ms, `${path}.page_delay_ms`);
        if (pageDelay !== undefined && (pageDelay < 0 || pageDelay > BROWSER_TOOL_LIMITS.maxWaitMs)) {
          throw new Error(`${path}.page_delay_ms 超出范围。`);
        }
        const variables = step.variables === undefined ? undefined : validateGraphqlValueMap(step.variables, `${path}.variables`);
        const features = step.features === undefined ? undefined : validateGraphqlFlagMap(step.features, `${path}.features`);
        const fieldToggles = step.field_toggles === undefined ? undefined : validateGraphqlFlagMap(step.field_toggles, `${path}.field_toggles`);
        const store = step.store === undefined ? undefined : readStringMap(step.store, `${path}.store`);

        let extract: BrowserToolGraphqlFetchStep["extract"];
        if (step.extract !== undefined) {
          const source = asRecord(step.extract, `${path}.extract`);
          const collection = readString(source.collection, `${path}.extract.collection`);
          if (!COLLECTION_PATTERN.test(collection)) throw new Error(`${path}.extract.collection 无效。`);
          const walk = source.walk === undefined ? undefined : asRecord(source.walk, `${path}.extract.walk`);
          const walkHas = walk === undefined ? undefined : readString(walk.has, `${path}.extract.walk.has`);
          const fieldsSource = asRecord(source.fields, `${path}.extract.fields`);
          const fields: Record<string, BrowserToolGraphqlFieldDefinition> = {};
          for (const [fieldName, rawField] of Object.entries(fieldsSource)) {
            if (!COLLECTION_PATTERN.test(fieldName)) throw new Error(`${path}.extract.fields.${fieldName} 名称无效。`);
            const field = asRecord(rawField, `${path}.extract.fields.${fieldName}`);
            const fieldPath = readString(field.path, `${path}.extract.fields.${fieldName}.path`);
            if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(fieldPath)) throw new Error(`${path}.extract.fields.${fieldName}.path 无效。`);
            const fallbackPaths = field.fallback_paths === undefined ? undefined : readStringArray(field.fallback_paths, `${path}.extract.fields.${fieldName}.fallback_paths`);
            fallbackPaths?.forEach((fallback) => {
              if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(fallback)) throw new Error(`${path}.extract.fields.${fieldName}.fallback_paths 含无效路径。`);
            });
            const itemPath = field.item_path === undefined ? undefined : readString(field.item_path, `${path}.extract.fields.${fieldName}.item_path`);
            const transforms = field.transforms === undefined ? undefined : readStringArray(field.transforms, `${path}.extract.fields.${fieldName}.transforms`);
            transforms?.forEach((transform) => {
              if (!TRANSFORMS.has(transform as BrowserToolTransform)) throw new Error(`未知转换：${transform}`);
            });
            fields[fieldName] = {
              path: fieldPath,
              fallback_paths: fallbackPaths,
              item_path: itemPath,
              transforms: transforms as BrowserToolTransform[] | undefined,
              optional: readOptionalBoolean(field.optional, `${path}.extract.fields.${fieldName}.optional`)
            };
          }
          if (Object.keys(fields).length === 0) throw new Error(`${path}.extract.fields 不能为空。`);
          const dedupeBy = readOptionalString(source.dedupe_by, `${path}.extract.dedupe_by`);
          if (dedupeBy && !(dedupeBy in fields)) throw new Error(`${path}.extract.dedupe_by 必须引用已声明字段。`);
          extract = { collection, walk: walkHas ? { has: walkHas } : undefined, fields, dedupe_by: dedupeBy };
        }

        let cursor: BrowserToolGraphqlFetchStep["cursor"];
        if (step.cursor !== undefined) {
          const source = asRecord(step.cursor, `${path}.cursor`);
          cursor = {
            match_key: readString(source.match_key, `${path}.cursor.match_key`),
            match_value: readString(source.match_value, `${path}.cursor.match_value`),
            value_path: readString(source.value_path, `${path}.cursor.value_path`)
          };
        }

        return {
          action,
          operation,
          variables,
          features,
          field_toggles: fieldToggles,
          store,
          extract,
          cursor,
          max_pages: maxPages,
          page_delay_ms: pageDelay,
          query_id: queryId,
          optional: readOptionalBoolean(step.optional, `${path}.optional`)
        };
      }
      default:
        throw new Error(`${path}.action 不支持：${action}`);
    }
  });
}

function validateGraphqlValueMap(value: unknown, path: string): Record<string, unknown> {
  const source = asRecord(value, path);
  const result: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(source)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) throw new Error(`${path}.${name} 名称无效。`);
    if (typeof raw === "string") {
      if (raw.length > 2_000) throw new Error(`${path}.${name} 过长。`);
      result[name] = readString(raw, `${path}.${name}`);
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      result[name] = raw;
    } else {
      throw new Error(`${path}.${name} 只能是字符串、数字或布尔值。`);
    }
  }
  return result;
}

function validateGraphqlFlagMap(value: unknown, path: string): Record<string, boolean> {
  const source = asRecord(value, path);
  const result: Record<string, boolean> = {};
  for (const [name, raw] of Object.entries(source)) {
    if (!/^[A-Za-z0-9_]{1,128}$/.test(name)) throw new Error(`${path}.${name} 名称无效。`);
    if (typeof raw !== "boolean") throw new Error(`${path}.${name} 必须是布尔值。`);
    result[name] = raw;
  }
  if (Object.keys(result).length > 120) throw new Error(`${path} 键过多。`);
  return result;
}

function validateLimits(value: unknown): BrowserToolDefinition["limits"] {
  const limits = asRecord(value, "limits");
  const delay = readOptionalNumber(limits.delay_between_actions_ms, "limits.delay_between_actions_ms");
  const maxRecords = readOptionalNumber(limits.max_records, "limits.max_records");
  if (delay !== undefined && (delay < 0 || delay > BROWSER_TOOL_LIMITS.maxDelayMs)) throw new Error("动作间隔超出范围。");
  if (maxRecords !== undefined && (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > BROWSER_TOOL_LIMITS.maxRecords)) {
    throw new Error("max_records 超出范围。");
  }
  return {
    delay_between_actions_ms: delay,
    max_records: maxRecords,
    require_user_activation: readOptionalBoolean(limits.require_user_activation, "limits.require_user_activation")
  };
}

function validatedTimeout(value: unknown, path: string): number | undefined {
  const timeout = readOptionalNumber(value, path);
  if (timeout !== undefined && (timeout < 0 || timeout > BROWSER_TOOL_LIMITS.maxWaitMs)) throw new Error(`${path} 超出范围。`);
  return timeout;
}

function validatedSelector(value: unknown, path: string): string {
  const selector = readString(value, path);
  validateSelector(selector);
  return selector;
}

function validateSelector(selector: string): void {
  if (selector.length > BROWSER_TOOL_LIMITS.maxSelectorLength) throw new Error("CSS selector 过长。");
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} 必须是对象。`);
  return value as Record<string, unknown>;
}

function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} 必须是数组。`);
  return value;
}

function readString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) throw new Error(`${path} 必须是字符串。`);
  return value;
}

function readOptionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : readString(value, path);
}

function readOptionalUiText(value: unknown, path: string, maxLength = 120): string | undefined {
  return value === undefined ? undefined : validateUiText(readString(value, path), path, maxLength);
}

function validateUiText(value: string, path: string, maxLength = 120): string {
  if (value.length > maxLength) throw new Error(`${path} 不能超过 ${maxLength} 个字符。`);
  return value;
}

function readStringArray(value: unknown, path: string): string[] {
  return asArray(value, path).map((item, index) => readString(item, `${path}[${index}]`));
}

function readStringMap(value: unknown, path: string): Record<string, string> {
  return Object.fromEntries(Object.entries(asRecord(value, path)).map(([key, item]) => [key, readString(item, `${path}.${key}`)]));
}

function readNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} 必须是有限数字。`);
  return value;
}

function readOptionalNumber(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : readNumber(value, path);
}

function readOptionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${path} 必须是布尔值。`);
  return value;
}
