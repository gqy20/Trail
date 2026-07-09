import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import { Clipboard, Copy, Download, Eye, Pencil, Save, Trash2 } from "lucide-react";
import { BrandMark } from "../../shared/BrandMark";
import { installDevChromeMock } from "../../shared/devChromeMock";
import { getSession, updateSavedSession } from "../../shared/storage";
import { formatDateTime } from "../../shared/time";
import type { TrailEvent, TrailSession } from "../../shared/types";
import "../../styles.css";

installDevChromeMock();

function ResearchApp() {
  const [session, setSession] = useState<TrailSession>();
  const [draftMarkdown, setDraftMarkdown] = useState("");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [saveState, setSaveState] = useState<"saved" | "dirty" | "saving">("saved");

  useEffect(() => {
    const sessionId = new URLSearchParams(location.search).get("sessionId");
    void getSession(sessionId || "sample-session").then((next) => {
      setSession(next);
      setDraftMarkdown(next?.markdown || "");
    });
  }, []);

  const copiedEvents = useMemo(
    () => session?.events.filter((event) => event.type === "text_copied" && event.selectedText) || [],
    [session]
  );

  async function copyMarkdown() {
    if (draftMarkdown) await navigator.clipboard.writeText(draftMarkdown);
  }

  function downloadMarkdown() {
    if (!draftMarkdown || !session) return;
    const blob = new Blob([draftMarkdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${toFileName(session.name || "trail")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function saveMarkdown() {
    if (!session) return;

    setSaveState("saving");
    const next: TrailSession = {
      ...session,
      markdown: draftMarkdown,
      updatedAt: Date.now()
    };

    await updateSavedSession(next);
    setSession(next);
    setSaveState("saved");
  }

  async function removeCopiedEvent(eventId: string) {
    if (!session) return;
    const next: TrailSession = {
      ...session,
      events: session.events.filter((event) => event.id !== eventId),
      updatedAt: Date.now()
    };
    await updateSavedSession(next);
    setSession(next);
  }

  function updateDraft(value: string) {
    setDraftMarkdown(value);
    setSaveState(value === (session?.markdown || "") ? "saved" : "dirty");
  }

  if (!session) {
    return (
      <main className="page-shell research-shell">
        <div className="panel">没有找到这条研究记录。</div>
      </main>
    );
  }

  const statusText = saveState === "saving" ? "保存中" : saveState === "dirty" ? "未保存" : "已保存";

  return (
    <main className="page-shell research-shell">
      <div className="research-workspace">
        <aside className="sidebar stack">
          <section className="panel stack">
            <span className="badge">{session.source === "tab_group" ? "标签页分组" : "浏览器窗口"}</span>
            <h1 className="sidebar-title">{session.name}</h1>
            <div className="muted">
              {formatDateTime(session.startedAt)} · {session.tabs.length} 个来源
            </div>
            <div className="muted">{session.updatedAt ? `更新于 ${formatDateTime(session.updatedAt)}` : statusText}</div>
            <div className="toolbar">
              <button className="button primary" disabled={saveState !== "dirty"} onClick={saveMarkdown}>
                <Save size={16} /> 保存
              </button>
              <button className="button primary" onClick={copyMarkdown}>
                <Copy size={16} /> 复制
              </button>
              <button className="button secondary" onClick={downloadMarkdown}>
                <Download size={16} /> 下载
              </button>
            </div>
          </section>

          <CopiedPanel events={copiedEvents} onRemove={(eventId) => void removeCopiedEvent(eventId)} />

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
              <div>
                <strong>研究文档</strong>
                <div className="muted text-small">{statusText}</div>
              </div>
            </div>
            <div className="toolbar">
              <div className="segmented" aria-label="文档模式">
                <button className={mode === "preview" ? "segment active" : "segment"} onClick={() => setMode("preview")}>
                  <Eye size={15} /> 预览
                </button>
                <button className={mode === "edit" ? "segment active" : "segment"} onClick={() => setMode("edit")}>
                  <Pencil size={15} /> 编辑
                </button>
              </div>
              <button className="button secondary" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("entries/sessions.html") })}>
                全部记录
              </button>
            </div>
          </div>
          {mode === "preview" ? (
            <article className="markdown-preview">
              <ReactMarkdown
                components={{
                  a({ href, children }) {
                    return (
                      <a href={href} target="_blank" rel="noreferrer">
                        {children}
                      </a>
                    );
                  }
                }}
              >
                {draftMarkdown}
              </ReactMarkdown>
            </article>
          ) : (
            <textarea
              className="markdown-editor"
              value={draftMarkdown}
              spellCheck={false}
              onChange={(event) => updateDraft(event.target.value)}
            />
          )}
        </section>
      </div>
    </main>
  );
}

function CopiedPanel({ events, onRemove }: { events: TrailEvent[]; onRemove: (eventId: string) => void }) {
  return (
    <section className="panel stack">
      <div className="header-row">
        <div className="setting-title">
          <Clipboard size={17} />
          <strong>复制片段</strong>
        </div>
        <span className="badge">{events.length}</span>
      </div>
      {events.length === 0 ? (
        <p className="setting-copy">录制期间复制网页文本后，关键片段会出现在这里。</p>
      ) : (
        <div className="copy-event-list">
          {events.map((event) => (
            <article className="copy-event" key={event.id}>
              <div className="copy-event-meta">
                <span>{event.sectionTitle || event.domain || "网页片段"}</span>
                <button className="icon-button compact danger" title="删除片段" aria-label="删除片段" onClick={() => onRemove(event.id)}>
                  <Trash2 size={14} />
                </button>
              </div>
              <p>{event.selectedText}</p>
              <a href={event.url} target="_blank" rel="noreferrer">
                {event.domain || "打开来源"}
              </a>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ResearchApp />
  </React.StrictMode>
);

function toFileName(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, "-")
      .slice(0, 80) || "trail"
  );
}
