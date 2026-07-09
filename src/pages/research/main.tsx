import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Copy, Download } from "lucide-react";
import { BrandMark } from "../../shared/BrandMark";
import { installDevChromeMock } from "../../shared/devChromeMock";
import { getSession } from "../../shared/storage";
import { formatDateTime } from "../../shared/time";
import type { TrailSession } from "../../shared/types";
import "../../styles.css";

installDevChromeMock();

function ResearchApp() {
  const [session, setSession] = useState<TrailSession>();

  useEffect(() => {
    const sessionId = new URLSearchParams(location.search).get("sessionId");
    void getSession(sessionId || "sample-session").then(setSession);
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
      <main className="page-shell research-shell">
        <div className="panel">没有找到这条记录。</div>
      </main>
    );
  }

  return (
    <main className="page-shell research-shell">
      <div className="research-workspace">
        <aside className="sidebar stack">
          <section className="panel stack">
            <span className="badge">{session.source === "tab_group" ? "标签页分组" : "浏览器窗口"}</span>
            <h1 style={{ margin: 0, fontSize: 24 }}>{session.name}</h1>
            <div className="muted">
              {formatDateTime(session.startedAt)} · {session.tabs.length} 个来源
            </div>
            <div className="toolbar">
              <button className="button primary" onClick={copyMarkdown}>
                <Copy size={16} /> 复制
              </button>
              <button className="button secondary" onClick={downloadMarkdown}>
                <Download size={16} /> 下载
              </button>
            </div>
          </section>

          <section className="panel stack">
            <strong>来源</strong>
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

        <section className="content research-content stack">
          <div className="header-row">
            <div className="brand">
              <BrandMark />
              <strong>研究文档</strong>
            </div>
            <button className="button secondary" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("sessions.html") })}>
              全部记录
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
