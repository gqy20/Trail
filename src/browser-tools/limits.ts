export const BROWSER_TOOL_LIMITS = {
  maxYamlLength: 256_000,
  maxWorkflowSteps: 100,
  maxNestedDepth: 4,
  maxRepeat: 50,
  maxRecords: 2_000,
  maxWaitMs: 60_000,
  maxDelayMs: 5_000,
  maxBatchKeywords: 100,
  /** 批量输入间隔上限；风控保守渠道（如小红书）需要 15 秒以上的用户间隔。 */
  maxBatchDelayMs: 60_000,
  maxSelectorLength: 1_000,
  maxTextLength: 10_000
} as const;
