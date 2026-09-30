import { useState } from "react";
import { ArrowLeft, Check, ExternalLink, FileDown, Pencil, Trash2, X } from "lucide-react";
import { deleteSession, getSession, updateSavedSession } from "../shared/storage";
import { formatDateTime } from "../shared/time";
import type { TrailSession } from "../shared/types";

export function RecentRecords({ sessions, onOpen, onAll }: { sessions: TrailSession[]; onOpen: (id: string) => void; onAll: () => void }) {
  return <section className="recent-records stack">
    <div className="section-heading"><strong>最近记录</strong><button className="button secondary" onClick={onAll}>全部记录 · {sessions.length}</button></div>
    {sessions.slice(0, 3).map((session) => <button className="record-row session-card" key={session.id} onClick={() => onOpen(session.id)}><strong>{session.name}</strong><span className="muted text-small">{recordMeta(session)}</span></button>)}
    {!sessions.length ? <p className="muted text-small">还没有记录，完成录制后会显示在这里。</p> : null}
  </section>;
}

export function RecordHistory({ sessions, sessionId, query, onQuery, onOpen, onBack }: {
  sessions: TrailSession[]; sessionId?: string; query: string; onQuery: (value: string) => void;
  onOpen: (id: string) => void; onBack: () => void;
}) {
  const [editingId, setEditingId] = useState("");
  const [editingName, setEditingName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selected = sessions.find((session) => session.id === sessionId);
  const keyword = query.trim().toLowerCase();
  const visible = sessions.filter((session) => !keyword || [session.name, session.goal, session.groupTitle,
    ...session.tabs.flatMap((tab) => [tab.title, tab.domain, tab.url]),
    ...session.events.flatMap((event) => [event.selectedText, event.targetText, event.targetUrl]),
    ...(session.pageStats || []).flatMap((stat) => [stat.title, stat.domain, stat.url])
  ].filter(Boolean).join(" ").toLowerCase().includes(keyword));

  async function act(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (err) { setError(err instanceof Error ? err.message : "操作失败。"); }
    finally { setBusy(false); }
  }

  function actions(session: TrailSession) {
    return <div className="record-actions">
      {editingId === session.id ? <>
        <input className="input" aria-label="记录新名称" autoFocus value={editingName} disabled={busy} onChange={(event) => setEditingName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && editingName.trim()) void rename(session.id); if (event.key === "Escape") setEditingId(""); }} />
        <button className="icon-button" aria-label="保存名称" disabled={busy || !editingName.trim()} onClick={() => void rename(session.id)}><Check size={14} /></button>
        <button className="icon-button" aria-label="取消重命名" disabled={busy} onClick={() => setEditingId("")}><X size={14} /></button>
      </> : <>
        <button className="icon-button" aria-label={`重命名 ${session.name}`} disabled={busy} onClick={() => { setEditingId(session.id); setEditingName(session.name); }}><Pencil size={14} /></button>
        <button className="icon-button danger" aria-label={`删除 ${session.name}`} disabled={busy} onClick={() => {
          if (!window.confirm(`删除“${session.name}”？`)) return;
          void act(async () => { await deleteSession(session.id); if (sessionId) onBack(); });
        }}><Trash2 size={14} /></button>
      </>}
    </div>;
  }

  function rename(id: string) {
    return act(async () => {
      const current = await getSession(id);
      if (!current) throw new Error("这条记录已被删除。");
      const name = editingName.trim();
      await updateSavedSession({ ...current, name, groupTitle: current.source === "tab_group" ? name : current.groupTitle, updatedAt: Date.now() });
      setEditingId("");
    });
  }

  function exportMarkdown(session: TrailSession) {
    const url = URL.createObjectURL(new Blob([session.markdown || ""], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = `${session.name.replace(/[<>:"/\\|?*]/g, "_") || "研究记录"}.md`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return <section className="record-history stack">
    <div className="record-history-heading"><button className="button secondary" onClick={onBack}><ArrowLeft size={14} />{sessionId ? "返回记录" : "研究路径"}</button><h1>{sessionId ? "记录摘要" : "全部记录"}</h1><span className="muted text-small">{sessionId ? "" : `${sessions.length} 条`}</span></div>
    {error ? <p role="alert" className="error-text text-small">{error}</p> : null}
    {sessionId ? selected ? <>
      <div className="record-detail-heading"><h2>{selected.name}</h2>{actions(selected)}</div>
      <p className="muted text-small">{recordMeta(selected)} · {selected.events.filter((event) => event.type === "text_copied").length} 个复制 · {selected.events.filter((event) => event.type === "text_selected").length} 个选中</p>
      {selected.goal ? <p>{selected.goal}</p> : null}
      <div className="record-actions"><button className="button action" onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL(`entries/research.html?sessionId=${selected.id}`) })}><ExternalLink size={14} />展开文档</button><button className="button secondary" disabled={!selected.markdown} onClick={() => exportMarkdown(selected)}><FileDown size={14} />导出 Markdown</button></div>
      <div className="section-heading"><strong>来源 · {selected.tabs.length}</strong></div>
      <div className="record-sources">{selected.tabs.map((tab, index) => <div className="record-source" key={`${tab.url}-${index}`}><strong>{/^https?:\/\//i.test(tab.url) ? <a href={tab.url} target="_blank" rel="noreferrer">{tab.title}</a> : tab.title}</strong><span className="muted text-small">{tab.domain}</span></div>)}</div>
      <details className="record-clips" open><summary>关注片段 · {selected.events.filter((event) => event.selectedText).length}</summary>{selected.events.filter((event) => event.selectedText).map((event) => <blockquote key={event.id}><p>{event.selectedText}</p><span className="muted text-small">{event.title || event.domain} · {event.type === "text_copied" ? "已复制" : "已选中"}</span></blockquote>)}{!selected.events.some((event) => event.selectedText) ? <p className="muted text-small">没有关注片段。</p> : null}</details>
    </> : <p className="muted">这条记录已被删除。</p> : <>
      <input className="input" aria-label="搜索研究记录" placeholder="搜索名称、来源或关注片段" value={query} onChange={(event) => onQuery(event.target.value)} />
      <div className="record-list">{visible.map((session) => <article className="record-list-item" key={session.id}><button className="record-row" onClick={() => onOpen(session.id)}><strong>{session.name}</strong><span className="muted text-small">{recordMeta(session)}</span></button>{actions(session)}</article>)}</div>
      {!visible.length ? <p className="muted text-small">{sessions.length ? "没有匹配的记录。" : "还没有研究记录。"}</p> : null}
    </>}
  </section>;
}

function recordMeta(session: TrailSession) { return `${formatDateTime(session.updatedAt || session.startedAt)} · ${session.tabs.length} 个来源`; }
