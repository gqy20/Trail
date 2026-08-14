import type { BrowserToolDefinition } from "./contracts";

const TEMPLATE_PATTERN = /\{\{\s*(parameters|selectors)\.([a-zA-Z0-9_-]+)\s*\}\}|\$\{(parameters|selectors)\.([a-zA-Z0-9_-]+)\}/g;

export function resolveTemplate(
  value: string,
  definition: BrowserToolDefinition,
  parameters: Record<string, unknown>
): string {
  const rendered = value.replace(TEMPLATE_PATTERN, (_match, firstScope, firstName, secondScope, secondName) => {
    const scope = (firstScope || secondScope) as "parameters" | "selectors";
    const name = (firstName || secondName) as string;
    const resolved = scope === "parameters" ? parameters[name] : definition.selectors?.[name];
    if (resolved === undefined || resolved === null) throw new Error(`模板变量不存在：${scope}.${name}`);
    return String(resolved);
  });

  if (/\{\{|\$\{/.test(rendered)) throw new Error(`模板无法解析：${value}`);
  return rendered;
}

export function resolveParameters(
  definition: BrowserToolDefinition,
  supplied: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [name, parameter] of Object.entries(definition.parameters || {})) {
    const value = supplied[name] ?? parameter.default;
    if (value === undefined || value === null || value === "") {
      if (parameter.required) throw new Error(`缺少必填参数：${parameter.label || name}`);
      continue;
    }

    if (typeof value !== parameter.type) throw new Error(`参数 ${name} 类型应为 ${parameter.type}。`);
    if (typeof value === "number") {
      if (parameter.min !== undefined && value < parameter.min) throw new Error(`参数 ${name} 小于最小值。`);
      if (parameter.max !== undefined && value > parameter.max) throw new Error(`参数 ${name} 大于最大值。`);
    }
    result[name] = value;
  }

  const unknown = Object.keys(supplied).filter((name) => !(name in (definition.parameters || {})));
  if (unknown.length > 0) throw new Error(`包含未声明参数：${unknown.join(", ")}`);
  return result;
}
