import type { TrailSession } from "./types";

const ACTIVE_SESSION_KEY = "trail.activeSession";
const SESSIONS_KEY = "trail.sessions";
const MAX_SESSIONS = 50;

export async function getActiveSession(): Promise<TrailSession | undefined> {
  const result = await chrome.storage.local.get(ACTIVE_SESSION_KEY);
  return result[ACTIVE_SESSION_KEY] as TrailSession | undefined;
}

export async function setActiveSession(session?: TrailSession): Promise<void> {
  if (!session) {
    await chrome.storage.local.remove(ACTIVE_SESSION_KEY);
    return;
  }

  await chrome.storage.local.set({ [ACTIVE_SESSION_KEY]: session });
}

export async function getSessions(): Promise<TrailSession[]> {
  const result = await chrome.storage.local.get(SESSIONS_KEY);
  return (result[SESSIONS_KEY] as TrailSession[] | undefined) || [];
}

export async function saveSession(session: TrailSession): Promise<void> {
  const sessions = await getSessions();
  const next = [session, ...sessions.filter((item) => item.id !== session.id)].slice(0, MAX_SESSIONS);
  await chrome.storage.local.set({ [SESSIONS_KEY]: next });
}

export async function updateSavedSession(session: TrailSession): Promise<void> {
  const sessions = await getSessions();
  await chrome.storage.local.set({
    [SESSIONS_KEY]: sessions.map((item) => (item.id === session.id ? session : item))
  });
}

export async function getSession(sessionId: string): Promise<TrailSession | undefined> {
  const sessions = await getSessions();
  return sessions.find((session) => session.id === sessionId);
}

export async function deleteSession(sessionId: string): Promise<void> {
  const sessions = await getSessions();
  await chrome.storage.local.set({
    [SESSIONS_KEY]: sessions.filter((session) => session.id !== sessionId)
  });
}
