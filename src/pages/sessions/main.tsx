import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Check, ExternalLink, Pencil, Search, Trash2, X } from "lucide-react";
import { BrandMark } from "../../shared/BrandMark";
import { installDevChromeMock } from "../../shared/devChromeMock";
import { deleteSession, getSessions, updateSavedSession } from "../../shared/storage";
import { formatDateTime } from "../../shared/time";
import type { TrailSession } from "../../shared/types";
import "../../styles.css";

installDevChromeMock();

function SessionsApp() {
  const [sessions, setSessions] = useState<TrailSession[]>([]);
  const [query, setQuery] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingName, setEditingName] = useState("");

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setSessions(await getSessions());
  }

  async function removeSession(sessionId: string) {
    if (!confirm("删除这条研究记录？")) return;
    await deleteSession(sessionId);
    await refresh();
  }

  function startRename(session: TrailSession) {
    setEditingId(session.id);
    setEditingName(session.name);
  }

  async function saveRename(session: TrailSession) {
    const name = editingName.trim();
    if (!name) return;

    await updateSavedSession({
      ...session,
      name,
      groupTitle: session.source === "tab_group" ? name : session.groupTitle,
      updatedAt: Date.now()
    });
    setEditingId("");
    setEditingName("");
    await refresh();
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleSessions = normalizedQuery
    ? sessions.filter((session) => {
        const haystack = [
          session.name,
          session.groupTitle,
          session.source,
          ...session.tabs.flatMap((tab) => [tab.title, tab.domain, tab.url]),
          ...(session.pageStats || []).flatMap((stat) => [stat.title, stat.domain, stat.url, stat.level]),
          ...session.events.flatMap((event) => [
            event.selectedText || "",
            event.targetText || "",
            event.targetUrl || "",
            event.targetDomain || ""
          ])
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return haystack.includes(normalizedQuery);
      })
    : sessions;

  return (
    <main className="page-shell sessions-shell">
      <div className="sessions-workspace stack">
        <header className="header-row">
          <div className="brand">
            <BrandMark />
            <div>
              <h1 className="page-title">研究记录</h1>
              <div className="muted">本地保存，可搜索来源、关注片段和路径点击</div>
            </div>
          </div>
          <label className="search-box">
            <Search size={16} />
            <input value={query} placeholder="搜索记录" onChange={(event) => setQuery(event.target.value)} />
          </label>
        </header>

        <section className="sessions-grid">
          {visibleSessions.map((session) => {
            const copiedCount = session.events.filter((event) => event.type === "text_copied").length;
            const selectedCount = session.events.filter((event) => event.type === "text_selected").length;
            const clickCount = session.events.filter((event) => event.type === "link_clicked").length;
            return (
              <article className="card session-card" key={session.id}>
                <div className="session-main">
                  <span className="badge">{session.source === "tab_group" ? session.groupTitle || "标签页分组" : "浏览器窗口"}</span>
                  {editingId === session.id ? (
                    <input
                      className="input compact"
                      autoFocus
                      value={editingName}
                      onChange={(event) => setEditingName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void saveRename(session);
                        if (event.key === "Escape") setEditingId("");
                      }}
                    />
                  ) : (
                    <strong>{session.name}</strong>
                  )}
                  <span className="muted">
                    {formatDateTime(session.updatedAt || session.startedAt)} · {session.tabs.length} 个来源 · {copiedCount} 个复制 · {selectedCount} 个选中 · {clickCount} 次点击
                  </span>
                </div>
                <div className="session-actions">
                  {editingId === session.id ? (
                    <>
                      <button className="button primary" onClick={() => saveRename(session)}>
                        <Check size={16} /> 保存
                      </button>
                      <button className="button secondary" onClick={() => setEditingId("")}>
                        <X size={16} /> 取消
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="button primary"
                        onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(`entries/research.html?sessionId=${session.id}`) })}
                      >
                        <ExternalLink size={16} /> 打开
                      </button>
                      <button className="button secondary" onClick={() => startRename(session)}>
                        <Pencil size={16} /> 重命名
                      </button>
                      <button className="button subtle danger" onClick={() => removeSession(session.id)}>
                        <Trash2 size={16} /> 删除
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </section>

        {sessions.length === 0 ? <section className="panel">还没有研究记录。</section> : null}
        {sessions.length > 0 && visibleSessions.length === 0 ? <section className="panel">没有匹配的记录。</section> : null}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SessionsApp />
  </React.StrictMode>
);
