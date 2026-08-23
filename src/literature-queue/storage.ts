import type { LiteratureQueue, LiteratureQueuePreferences } from "./types";

const LITERATURE_QUEUE_KEY = "trail.literatureQueue";
const LITERATURE_QUEUE_PREFERENCES_KEY = "trail.literatureQueuePreferences";

export async function getLiteratureQueue(): Promise<LiteratureQueue | undefined> {
  const result = await chrome.storage.local.get(LITERATURE_QUEUE_KEY);
  return result[LITERATURE_QUEUE_KEY] as LiteratureQueue | undefined;
}

export async function saveLiteratureQueue(queue: LiteratureQueue): Promise<void> {
  await chrome.storage.local.set({ [LITERATURE_QUEUE_KEY]: { ...queue, updatedAt: Date.now() } });
}

export async function clearLiteratureQueue(): Promise<void> {
  await chrome.storage.local.remove(LITERATURE_QUEUE_KEY);
}

export async function getLiteratureQueuePreferences(): Promise<LiteratureQueuePreferences> {
  const result = await chrome.storage.local.get(LITERATURE_QUEUE_PREFERENCES_KEY);
  const stored = result[LITERATURE_QUEUE_PREFERENCES_KEY] as Partial<LiteratureQueuePreferences> | undefined;
  return { concurrency: clampConcurrency(stored?.concurrency) };
}

export async function saveLiteratureQueuePreferences(preferences: LiteratureQueuePreferences): Promise<void> {
  await chrome.storage.local.set({
    [LITERATURE_QUEUE_PREFERENCES_KEY]: { concurrency: clampConcurrency(preferences.concurrency) }
  });
}

function clampConcurrency(value: unknown): number {
  const concurrency = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 2;
  return Math.max(1, Math.min(4, concurrency));
}
