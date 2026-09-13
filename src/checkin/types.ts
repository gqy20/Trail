import type { BrowserToolRunResult } from "../browser-tools/contracts";

export type CheckinJob = {
  enabled: boolean;
  time: string;
  approvedHash?: string;
  status: "idle" | "running" | "success" | "already_done" | "needs_user" | "failed";
  message?: string;
  lastSuccessDay?: string;
  attemptDay?: string;
  attempts?: number;
  lastAttemptAt?: number;
  tabId?: number;
  result?: BrowserToolRunResult;
};

export type CheckinItem = {
  toolId: string;
  name: string;
  entryUrl: string;
  timezone: string;
  job: CheckinJob;
};

export type CheckinState = { items: CheckinItem[] };
