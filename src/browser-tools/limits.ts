export const BROWSER_TOOL_LIMITS = {
  maxYamlLength: 256_000,
  maxWorkflowSteps: 100,
  maxNestedDepth: 4,
  maxRepeat: 50,
  maxRecords: 2_000,
  maxWaitMs: 60_000,
  maxDelayMs: 5_000,
  maxSelectorLength: 1_000,
  maxTextLength: 10_000
} as const;
