import { parseDocument } from "yaml";
import type {
  BrowserToolCollectionPresentation,
  BrowserToolDefinition,
  BrowserToolDownloadDefinition,
  BrowserToolFieldDefinition,
  BrowserToolParameterDefinition,
  BrowserToolPresentation,
  BrowserToolStep,
  BrowserToolTransform
} from "./contracts";
import { BROWSER_TOOL_LIMITS } from "./limits";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const COLLECTION_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const PRESENTATION_FIELD_PATTERN = /^[a-z_][a-z0-9_-]{0,63}$/;
const TRANSFORMS = new Set<BrowserToolTransform>([
  "trim",
  "normalize_whitespace",
  "parse_year",
  "parse_number",
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
  const downloads = root.downloads === undefined ? undefined : validateDownloads(root.downloads);

  return {
    schema_version: 1,
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
    downloads,
    batch,
    limits
  };
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
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("batch.navigation.url 只支持 HTTP(S)。");
    const inputParameter = readString(navigation.input_parameter, "batch.navigation.input_parameter");
    if (!COLLECTION_PATTERN.test(inputParameter)) throw new Error("batch.navigation.input_parameter 无效。");
    validatedNavigation = { type: "fixed_url", url: parsedUrl.href, input_parameter: inputParameter };
  } else {
    throw new Error("batch.navigation.type 只支持 query_parameter 或 fixed_url。");
  }

  const maxKeywords = readOptionalNumber(batch.max_keywords, "batch.max_keywords");
  if (maxKeywords !== undefined && (!Number.isInteger(maxKeywords) || maxKeywords < 1 || maxKeywords > BROWSER_TOOL_LIMITS.maxBatchKeywords)) {
    throw new Error(`batch.max_keywords 必须是 1-${BROWSER_TOOL_LIMITS.maxBatchKeywords} 的整数。`);
  }
  const delay = readOptionalNumber(batch.delay_between_keywords_ms, "batch.delay_between_keywords_ms");
  if (delay !== undefined && (delay < 0 || delay > BROWSER_TOOL_LIMITS.maxBatchDelayMs)) {
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
        return {
          action,
          collection,
          selector: validatedSelector(step.selector, `${path}.selector`),
          fields
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
      default:
        throw new Error(`${path}.action 不支持：${action}`);
    }
  });
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
