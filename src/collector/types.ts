import type { BrowserToolRunResult } from "../browser-tools/contracts";

export type FollowEntry = {
  platform: string;
  handle: string;
  displayName?: string;
  priority?: number;
};

export type CollectorJob = {
  enabled: boolean;
  /** 采集间隔（小时）。 */
  intervalHours: number;
  approvedHash?: string;
  status: "idle" | "running" | "ok" | "needs_user" | "failed";
  message?: string;
  lastSuccessAt?: number;
  lastAttemptAt?: number;
  attemptDay?: string;
  attempts?: number;
  tabId?: number;
  result?: BrowserToolRunResult;
};

export type CollectorItem = {
  toolId: string;
  name: string;
  platform: string;
  entryUrl: string;
  intervalSupported: boolean;
  followsCount: number;
  job: CollectorJob;
};

export type CollectorState = { items: CollectorItem[] };

export type FollowsImportResult = { added: number; updated: number; total: number };
