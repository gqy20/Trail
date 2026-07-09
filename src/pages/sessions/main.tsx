import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BookOpen, ExternalLink, Trash2 } from "lucide-react";
import "../../styles.css";
import { deleteSession, getSessions } from "../../shared/storage";
import { formatDateTime } from "../../shared/time";
import type { TrailSession } from "../../shared/types";

function SessionsApp() {
  const [sessions, setSessions] = useState<TrailSession[]>([]);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setSessions(await getSessions());
  }

  async function removeSession(sessionId: string) {
    await deleteSession(sessionId);
    await refresh();
  }

  return (
    <main className="page-shell">
      <div className="page-inner stack">
        <header className="header-row">
          <div className="brand">
            <span className="brand-mark">
              <BookOpen size={18} />
            </span>
            <div>
              <h1 style={{ margin: 0, fontSize: 26 }}>Trail Sessions</h1>
              <div className="muted">Local research trails saved in this browser.</div>
            </div>
          </div>
        </header>

        <section className="sessions-grid">
          {sessions.map((session) => (
            <article className="card session-card" key={session.id}>
              <span className="badge">{session.source === "tab_group" ? session.groupTitle || "Tab Group" : "Window"}</span>
              <strong>{session.name}</strong>
              <span className="muted">{formatDateTime(session.startedAt)} · {session.tabs.length} sources</span>
              <div className="toolbar">
                <button
                  className="button"
                  onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(`research.html?sessionId=${session.id}`) })}
                >
                  <ExternalLink size={16} /> Open
                </button>
                <button className="button secondary" onClick={() => removeSession(session.id)}>
                  <Trash2 size={16} /> Delete
                </button>
              </div>
            </article>
          ))}
        </section>

        {sessions.length === 0 ? <section className="panel">No saved trails yet.</section> : null}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SessionsApp />
  </React.StrictMode>
);
