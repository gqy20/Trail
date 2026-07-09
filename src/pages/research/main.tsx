import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Copy, Download, History } from "lucide-react";
import "../../styles.css";
import { getSession } from "../../shared/storage";
import { formatDateTime } from "../../shared/time";
import type { TrailSession } from "../../shared/types";

function ResearchApp() {
  const [session, setSession] = useState<TrailSession>();

  useEffect(() => {
    const sessionId = new URLSearchParams(location.search).get("sessionId");
    if (sessionId) void getSession(sessionId).then(setSession);
  }, []);

  async function copyMarkdown() {
    if (session?.markdown) await navigator.clipboard.writeText(session.markdown);
  }

  function downloadMarkdown() {
    if (!session?.markdown) return;
    const blob = new Blob([session.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${session.name || "trail"}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (!session) {
    return (
      <main className="page-shell">
        <div className="page-inner panel">Session not found.</div>
      </main>
    );
  }

  return (
    <main className="page-shell">
      <div className="page-inner split">
        <aside className="sidebar stack">
          <section className="panel stack">
            <span className="badge">{session.source === "tab_group" ? "Tab Group" : "Window"}</span>
            <h1 style={{ margin: 0, fontSize: 24 }}>{session.name}</h1>
            <div className="muted">{formatDateTime(session.startedAt)} · {session.tabs.length} sources</div>
            <div className="toolbar">
              <button className="button" onClick={copyMarkdown}>
                <Copy size={16} /> Copy
              </button>
              <button className="button secondary" onClick={downloadMarkdown}>
                <Download size={16} /> Download
              </button>
            </div>
          </section>

          <section className="panel stack">
            <strong>Sources</strong>
            <div className="source-list">
              {session.tabs.map((tab) => (
                <a className="source-item" href={tab.url} key={`${tab.url}-${tab.capturedAt}`} target="_blank" rel="noreferrer">
                  <span className="source-title">{tab.title}</span>
                  <span className="source-domain">{tab.domain}</span>
                </a>
              ))}
            </div>
          </section>
        </aside>

        <section className="content stack">
          <div className="header-row">
            <div className="brand">
              <span className="brand-mark">
                <History size={18} />
              </span>
              <strong>Research Document</strong>
            </div>
            <button className="button secondary" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("sessions.html") })}>
              All Sessions
            </button>
          </div>
          <pre className="markdown-preview">{session.markdown}</pre>
        </section>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ResearchApp />
  </React.StrictMode>
);
