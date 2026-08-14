import type { BrowserToolRunResult, ExecuteBrowserToolMessage } from "./contracts";
import { executeBrowserTool } from "./executor";

export function installBrowserToolContentRuntime(): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!isExecuteBrowserToolMessage(message)) return undefined;

    executeBrowserTool(message.definition, message.parameters)
      .then(sendResponse)
      .catch((error: unknown) => {
        const messageText = error instanceof Error ? error.message : "Browser Tool 执行失败。";
        sendResponse({ error: messageText } satisfies Partial<BrowserToolRunResult>);
      });

    return true;
  });
}

function isExecuteBrowserToolMessage(value: unknown): value is ExecuteBrowserToolMessage {
  if (!value || typeof value !== "object") return false;
  return (value as { type?: unknown }).type === "EXECUTE_BROWSER_TOOL";
}
