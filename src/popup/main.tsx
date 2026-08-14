import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Ban, Clock, Clipboard, FileText, FolderOpen, Play, Square, Wrench } from "lucide-react";
import { BrandMark } from "../shared/BrandMark";
import { installDevChromeMock } from "../shared/devChromeMock";
import { normalizeDomain } from "../shared/interactions";
import { sendMessage } from "../shared/runtime";
import { formatDuration } from "../shared/time";
import type { PopupState, TrailInteractionSettings, TrailSession } from "../shared/types";
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
        await chrome.tabs.create({ url: chrome.runtime.getURL(`entries/research.html?sessionId=${session.id}`) });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trail 操作失败。");
    } finally {
      setBusy(false);
    }
  }

  async function updateSettings(settings: Partial<TrailInteractionSettings>) {
    const interactionSettings = await sendMessage({ type: "UPDATE_INTERACTION_SETTINGS", settings });
    setState((current) => (current ? { ...current, interactionSettings } : current));
  }

  const currentGroup = state?.currentGroup;
  const activeSession = state?.activeSession;
  const displayName = name.trim() || defaultName;
  const currentDomain = normalizeDomain(currentGroup?.activeTab?.url ? new URL(currentGroup.activeTab.url).hostname : "");
  const copiedCount = activeSession?.events.filter((event) => event.type === "text_copied").length || 0;
  const selectedCount = activeSession?.events.filter((event) => event.type === "text_selected").length || 0;
  const clickedCount = activeSession?.events.filter((event) => event.type === "link_clicked").length || 0;

  return (
    <main className="popup-shell stack">
      <header className="header-row">
        <div className="brand">
          <BrandMark />
          <div>
            <div>Trail</div>
            <div className="muted text-small">研究路径</div>
          </div>
        </div>
        <div className="toolbar">
          <button
            className="icon-button"
            title="Browser Tools"
            aria-label="Browser Tools"
            onClick={() => {
              const targetTabId = state?.currentGroup.activeTab?.id;
              const query = targetTabId === undefined ? "" : `?targetTabId=${targetTabId}`;
              void chrome.tabs.create({ url: chrome.runtime.getURL(`entries/tools.html${query}`) });
            }}
          >
            <Wrench size={17} />
          </button>
          <button
            className="icon-button"
            title="全部记录"
            aria-label="全部记录"
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("entries/sessions.html") })}
          >
            <Clock size={17} />
          </button>
        </div>
      </header>

      {activeSession ? (
        <section className="panel recording-panel">
          <div className="recording-top">
            <div className="recording-title">
              <strong>{activeSession.name}</strong>
              <div className="muted">
                {formatDuration(activeSession.startedAt)} · {activeSession.tabs.length} 个来源 · {copiedCount} 个复制 · {selectedCount} 个选中 · {clickedCount} 次点击
              </div>
            </div>
            <span className="badge recording-badge">记录中</span>
          </div>
          <div className="recording-actions">
            <button className="button primary" disabled={busy} onClick={() => run(() => sendMessage({ type: "STOP_RECORDING" }))}>
              <Square size={16} /> 生成文档
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
                <strong>{currentGroup?.hasGroup ? currentGroup.group?.title || "未命名分组" : "新建分组"}</strong>
                <div className="muted">
                  {currentGroup?.hasGroup
                    ? `检测到 ${currentGroup.tabs.length} 个标签页`
                    : "从当前窗口创建 Chrome 分组"}
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
              <button className="button primary full" disabled={busy} onClick={() => run(() => sendMessage({ type: "START_GROUP_RECORDING", name: displayName }))}>
                <Play size={16} /> 开始记录
              </button>
              <button className="button secondary full" disabled={busy} onClick={() => run(() => sendMessage({ type: "GENERATE_FROM_CURRENT_GROUP", name: displayName }))}>
                <FileText size={16} /> 立即生成
              </button>
            </>
          ) : (
            <>
              <button className="button primary full" disabled={busy} onClick={() => run(() => sendMessage({ type: "START_NEW_GROUP_RECORDING", name: displayName }))}>
                <Play size={16} /> 新建分组并记录
              </button>
              <button className="button secondary full" disabled={busy} onClick={() => run(() => sendMessage({ type: "GENERATE_FROM_CURRENT_WINDOW", name: displayName }))}>
                <FileText size={16} /> 记录当前窗口
              </button>
            </>
          )}
        </section>
      )}

      {state ? (
        <InteractionPanel
          settings={state.interactionSettings}
          currentDomain={currentDomain}
          onChange={(settings) => void updateSettings(settings)}
        />
      ) : null}

      {error ? <div className="card error-text">{error}</div> : null}

      <section className="stack">
        <div className="header-row">
          <strong>最近记录</strong>
          <button className="button secondary" onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL("entries/sessions.html") })}>
            全部
          </button>
        </div>
        {(state?.recentSessions || []).map((session) => (
          <button
            className="card session-card"
            key={session.id}
            onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL(`entries/research.html?sessionId=${session.id}`) })}
          >
            <strong>{session.name}</strong>
            <span className="muted">{session.tabs.length} 个来源</span>
          </button>
        ))}
      </section>
    </main>
  );
}

function InteractionPanel({
  settings,
  currentDomain,
  onChange
}: {
  settings: TrailInteractionSettings;
  currentDomain: string;
  onChange: (settings: Partial<TrailInteractionSettings>) => void;
}) {
  const domainExcluded = currentDomain ? settings.excludedDomains.includes(currentDomain) : false;

  function toggleDomain() {
    if (!currentDomain) return;
    const excludedDomains = domainExcluded
      ? settings.excludedDomains.filter((domain) => domain !== currentDomain)
      : [...settings.excludedDomains, currentDomain];
    onChange({ excludedDomains });
  }

  return (
    <section className="panel stack">
      <div className="header-row">
        <div className="setting-title">
          <Clipboard size={17} />
          <strong>交互捕获</strong>
        </div>
        <Toggle
          checked={settings.captureCopy}
          label="记录网页复制"
          onChange={(captureCopy) => onChange({ captureCopy })}
        />
      </div>
      <p className="setting-copy">只在录制期间记录网页内复制的选中文本，不读取系统剪贴板。</p>
      <div className="setting-list">
        <ToggleRow
          label="保留来源上下文"
          description="记录页面章节、附近文本和大致位置，便于回看。"
          checked={settings.captureContext}
          onChange={(captureContext) => onChange({ captureContext })}
        />
        <ToggleRow
          label="记录稳定选中"
          description="选中文本停留片刻后，作为低权重关注片段保存。"
          checked={settings.captureSelection}
          onChange={(captureSelection) => onChange({ captureSelection })}
        />
        <ToggleRow
          label="记录链接点击"
          description="只保存搜索结果、外链、文档目录、GitHub 和下载链接。"
          checked={settings.captureClicks}
          onChange={(captureClicks) => onChange({ captureClicks })}
        />
        <ToggleRow
          label="复制后轻提示"
          description="显示“已记录到 Trail”，并提供撤销。"
          checked={settings.showToast}
          disabled={!settings.captureCopy}
          onChange={(showToast) => onChange({ showToast })}
        />
        <ToggleRow
          label="合并重复片段"
          description="同一页面重复复制同一段内容时，只保留一条记录。"
          checked={settings.mergeDuplicates}
          onChange={(mergeDuplicates) => onChange({ mergeDuplicates })}
        />
        <ToggleRow
          label="自动脱敏"
          description="保存前隐藏常见邮箱、token 和密钥形态。"
          checked={settings.redactSensitive}
          onChange={(redactSensitive) => onChange({ redactSensitive })}
        />
      </div>
      {currentDomain ? (
        <button className="button secondary full" onClick={toggleDomain}>
          <Ban size={16} /> {domainExcluded ? `允许 ${currentDomain}` : `不记录 ${currentDomain}`}
        </button>
      ) : null}
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled,
  onChange
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="toggle-row">
      <div>
        <strong>{label}</strong>
        <div className="muted">{description}</div>
      </div>
      <Toggle checked={checked} disabled={disabled} label={label} onChange={onChange} />
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  label,
  onChange
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={checked ? "switch is-on" : "switch"}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>
);
