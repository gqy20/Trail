import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BookOpen, Clock, FileText, FolderOpen, Play, Square } from "lucide-react";
import "../styles.css";
import { sendMessage } from "../shared/runtime";
import { formatDuration } from "../shared/time";
import type { PopupState, TrailSession } from "../shared/types";

function PopupApp() {
  const [state, setState] = useState<PopupState>();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void refresh();
  }, []);

  const defaultName = useMemo(() => {
    if (state?.currentGroup.group?.title) return state.currentGroup.group.title;
    return "Research Trail";
  }, [state]);

  async function refresh() {
    const next = await sendMessage({ type: "GET_POPUP_STATE" });
    setState(next);
    if (!name) setName(next.currentGroup.group?.title || "");
  }

  async function run(action: () => Promise<TrailSession | undefined>) {
    setBusy(true);
    setError("");
    try {
      const session = await action();
      await refresh();
      if (session?.status === "completed") {
        await chrome.tabs.create({ url: chrome.runtime.getURL(`research.html?sessionId=${session.id}`) });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trail action failed.");
    } finally {
      setBusy(false);
    }
  }

  const currentGroup = state?.currentGroup;
  const activeSession = state?.activeSession;
  const displayName = name.trim() || defaultName;

  return (
    <main className="popup-shell stack">
      <header className="header-row">
        <div className="brand">
          <span className="brand-mark">
            <BookOpen size={18} />
          </span>
          <div>
            <div>Trail</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Capture your learning trail.
            </div>
          </div>
        </div>
        <button
          className="icon-button"
          title="Open sessions"
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("sessions.html") })}
        >
          <Clock size={17} />
        </button>
      </header>

      {activeSession ? (
        <section className="panel stack">
          <span className="badge">Recording</span>
          <div>
            <strong>{activeSession.name}</strong>
            <div className="muted">{formatDuration(activeSession.startedAt)} · {activeSession.tabs.length} sources</div>
          </div>
          <button className="button full" disabled={busy} onClick={() => run(() => sendMessage({ type: "STOP_RECORDING" }))}>
            <Square size={16} /> Stop & Generate
          </button>
        </section>
      ) : (
        <section className="panel stack">
          <label className="label">
            Session Name
            <input
              className="input"
              value={name}
              placeholder={defaultName}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <div className="card stack">
            <div className="header-row">
              <div>
                <strong>{currentGroup?.hasGroup ? currentGroup.group?.title || "Untitled Group" : "New group from current tab"}</strong>
                <div className="muted">
                  {currentGroup?.hasGroup
                    ? `${currentGroup.tabs.length} tabs detected`
                    : "Start will create and name a Chrome Tab Group"}
                </div>
              </div>
              <FolderOpen size={18} />
            </div>
            <div className="source-list">
              {(currentGroup?.tabs || []).slice(0, 8).map((tab) => (
                <div className="source-item" key={`${tab.id}-${tab.url}`}>
                  <div className="source-title">{tab.title}</div>
                  <div className="source-domain">{tab.domain}</div>
                </div>
              ))}
            </div>
          </div>

          {currentGroup?.hasGroup ? (
            <>
              <button className="button full" disabled={busy} onClick={() => run(() => sendMessage({ type: "START_GROUP_RECORDING", name: displayName }))}>
                <Play size={16} /> Start Recording Group
              </button>
              <button className="button secondary full" disabled={busy} onClick={() => run(() => sendMessage({ type: "GENERATE_FROM_CURRENT_GROUP", name: displayName }))}>
                <FileText size={16} /> Generate from Group
              </button>
            </>
          ) : (
            <>
              <button className="button full" disabled={busy} onClick={() => run(() => sendMessage({ type: "START_NEW_GROUP_RECORDING", name: displayName }))}>
                <Play size={16} /> Start New Group
              </button>
              <button className="button secondary full" disabled={busy} onClick={() => run(() => sendMessage({ type: "GENERATE_FROM_CURRENT_WINDOW", name: displayName }))}>
                <FileText size={16} /> Generate from Window
              </button>
            </>
          )}
        </section>
      )}

      {error ? <div className="card" style={{ color: "#b42318" }}>{error}</div> : null}

      <section className="stack">
        <div className="header-row">
          <strong>Recent Trails</strong>
          <button className="button secondary" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("sessions.html") })}>
            View All
          </button>
        </div>
        {(state?.recentSessions || []).map((session) => (
          <button
            className="card session-card"
            key={session.id}
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(`research.html?sessionId=${session.id}`) })}
          >
            <strong>{session.name}</strong>
            <span className="muted">{session.tabs.length} sources</span>
          </button>
        ))}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>
);
