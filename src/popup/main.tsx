import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Clock, FileText, FolderOpen, Play, Square } from "lucide-react";
import { BrandMark } from "../shared/BrandMark";
import { installDevChromeMock } from "../shared/devChromeMock";
import { sendMessage } from "../shared/runtime";
import { formatDuration } from "../shared/time";
import type { PopupState, TrailSession } from "../shared/types";
import "../styles.css";

installDevChromeMock();

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
    return "研究记录";
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
      setError(err instanceof Error ? err.message : "Trail 操作失败。");
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
          <BrandMark />
          <div>
            <div>Trail</div>
            <div className="muted" style={{ fontSize: 12 }}>
              记录你的研究路径
            </div>
          </div>
        </div>
        <button
          className="icon-button"
          title="打开历史记录"
          onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("sessions.html") })}
        >
          <Clock size={17} />
        </button>
      </header>

      {activeSession ? (
        <section className="panel recording-panel">
          <div className="recording-top">
            <div className="recording-title">
              <strong>{activeSession.name}</strong>
              <div className="muted">
                {formatDuration(activeSession.startedAt)} · {activeSession.tabs.length} 个来源
              </div>
            </div>
            <span className="badge recording-badge">记录中</span>
          </div>
          <div className="recording-actions">
            <button className="button" disabled={busy} onClick={() => run(() => sendMessage({ type: "STOP_RECORDING" }))}>
              <Square size={16} /> 停止并生成
            </button>
          </div>
        </section>
      ) : (
        <section className="panel stack">
          <label className="label">
            记录名称
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
                <strong>{currentGroup?.hasGroup ? currentGroup.group?.title || "未命名分组" : "从当前标签页创建新分组"}</strong>
                <div className="muted">
                  {currentGroup?.hasGroup
                    ? `检测到 ${currentGroup.tabs.length} 个标签页`
                    : "开始记录时会自动创建并命名 Chrome 分组"}
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
                <Play size={16} /> 开始记录分组
              </button>
              <button className="button secondary full" disabled={busy} onClick={() => run(() => sendMessage({ type: "GENERATE_FROM_CURRENT_GROUP", name: displayName }))}>
                <FileText size={16} /> 直接生成分组文档
              </button>
            </>
          ) : (
            <>
              <button className="button full" disabled={busy} onClick={() => run(() => sendMessage({ type: "START_NEW_GROUP_RECORDING", name: displayName }))}>
                <Play size={16} /> 创建分组并记录
              </button>
              <button className="button secondary full" disabled={busy} onClick={() => run(() => sendMessage({ type: "GENERATE_FROM_CURRENT_WINDOW", name: displayName }))}>
                <FileText size={16} /> 直接生成窗口文档
              </button>
            </>
          )}
        </section>
      )}

      {error ? <div className="card error-text">{error}</div> : null}

      <section className="stack">
        <div className="header-row">
          <strong>最近记录</strong>
          <button className="button secondary" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("sessions.html") })}>
            查看全部
          </button>
        </div>
        {(state?.recentSessions || []).map((session) => (
          <button
            className="card session-card"
            key={session.id}
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(`research.html?sessionId=${session.id}`) })}
          >
            <strong>{session.name}</strong>
            <span className="muted">{session.tabs.length} 个来源</span>
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
