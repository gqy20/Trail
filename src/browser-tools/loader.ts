import { parseDocument } from "yaml";
import type {
  BrowserToolDefinition,
  BrowserToolFieldDefinition,
  BrowserToolParameterDefinition,
  BrowserToolStep,
  BrowserToolTransform
} from "./contracts";
import { BROWSER_TOOL_LIMITS } from "./limits";

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,79}$/;
const COLLECTION_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
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
    batch,
    limits
  };
}

function validateBatch(value: unknown): BrowserToolDefinition["batch"] {
  const batch = asRecord(value, "batch");
  const navigation = asRecord(batch.navigation, "batch.navigation");
  if (navigation.type !== "query_parameter") throw new Error("batch.navigation.type 目前只支持 query_parameter。");
  const parameter = readString(navigation.parameter, "batch.navigation.parameter");
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(parameter)) throw new Error("batch.navigation.parameter 无效。");

  const maxKeywords = readOptionalNumber(batch.max_keywords, "batch.max_keywords");
  if (maxKeywords !== undefined && (!Number.isInteger(maxKeywords) || maxKeywords < 1 || maxKeywords > BROWSER_TOOL_LIMITS.maxBatchKeywords)) {
    throw new Error(`batch.max_keywords 必须是 1-${BROWSER_TOOL_LIMITS.maxBatchKeywords} 的整数。`);
  }
  const delay = readOptionalNumber(batch.delay_between_keywords_ms, "batch.delay_between_keywords_ms");
  if (delay !== undefined && (delay < 0 || delay > BROWSER_TOOL_LIMITS.maxBatchDelayMs)) {
    throw new Error("batch.delay_between_keywords_ms 超出范围。");
  }

  return {
    navigation: { type: "query_parameter", parameter },
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
      max: readOptionalNumber(definition.max, `parameters.${name}.max`)
    };
  }
  return result;
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
      case "wait_for_change":
        return {
          action,
          selector: validatedSelector(step.selector, `${path}.selector`),
          timeout_ms: validatedTimeout(step.timeout_ms, `${path}.timeout_ms`),
          optional: readOptionalBoolean(step.optional, `${path}.optional`)
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
          if (!["text", "href", "content", "datetime"].includes(attribute)) {
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
        return {
          action,
          max,
          steps: validateSteps(asArray(step.steps, `${path}.steps`), depth + 1, countStep),
          between:
            step.between === undefined
              ? undefined
              : validateSteps(asArray(step.between, `${path}.between`), depth + 1, countStep)
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
