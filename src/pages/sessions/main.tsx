import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ExternalLink, Trash2 } from "lucide-react";
import { BrandMark } from "../../shared/BrandMark";
import { installDevChromeMock } from "../../shared/devChromeMock";
import { deleteSession, getSessions } from "../../shared/storage";
import { formatDateTime } from "../../shared/time";
import type { TrailSession } from "../../shared/types";
import "../../styles.css";

installDevChromeMock();

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
    <main className="page-shell sessions-shell">
      <div className="sessions-workspace stack">
        <header className="header-row">
          <div className="brand">
            <BrandMark />
            <div>
              <h1 style={{ margin: 0, fontSize: 26 }}>研究记录</h1>
              <div className="muted">本地保存</div>
            </div>
          </div>
        </header>

        <section className="sessions-grid">
          {sessions.map((session) => (
            <article className="card session-card" key={session.id}>
              <div className="session-main">
                <span className="badge">{session.source === "tab_group" ? session.groupTitle || "标签页分组" : "浏览器窗口"}</span>
                <strong>{session.name}</strong>
                <span className="muted">
                  {formatDateTime(session.startedAt)} · {session.tabs.length} 个来源
                </span>
              </div>
              <div className="session-actions">
                <button
                  className="button primary"
                  onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(`research.html?sessionId=${session.id}`) })}
                >
                  <ExternalLink size={16} /> 打开
                </button>
                <button className="button subtle danger" onClick={() => removeSession(session.id)}>
                  <Trash2 size={16} /> 删除
                </button>
              </div>
            </article>
          ))}
        </section>

        {sessions.length === 0 ? <section className="panel">暂无记录。</section> : null}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SessionsApp />
  </React.StrictMode>
);
