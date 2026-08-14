import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ExternalLink, FileUp, Play, RefreshCw, Trash2, Wrench } from "lucide-react";
import { BrandMark } from "../../shared/BrandMark";
import { installDevChromeMock } from "../../shared/devChromeMock";
import { sendMessage } from "../../shared/runtime";
import { formatDateTime } from "../../shared/time";
import type {
  BrowserToolManagerState,
  BrowserToolParameterDefinition,
  BrowserToolRunResult,
  StoredBrowserTool
} from "../../browser-tools/contracts";
import "../../styles.css";

installDevChromeMock();

function BrowserToolsApp() {
  const [state, setState] = useState<BrowserToolManagerState>();
  const [selectedId, setSelectedId] = useState("");
  const [yamlDraft, setYamlDraft] = useState("");
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  const [lastResult, setLastResult] = useState<BrowserToolRunResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const targetTabId = useMemo(() => readTargetTabId(), []);

  useEffect(() => {
    void refresh();
  }, []);

  const selectedTool = state?.tools.find((tool) => tool.id === selectedId);
  const isMatched = Boolean(selectedTool && state?.matchedToolIds.includes(selectedTool.id));

  useEffect(() => {
    if (!selectedTool) {
      setParameters({});
      return;
    }
    setParameters(
      Object.fromEntries(
        Object.entries(selectedTool.definition.parameters || {})
          .filter(([, definition]) => definition.default !== undefined)
          .map(([name, definition]) => [name, definition.default])
      )
    );
  }, [selectedTool?.id]);

  async function refresh(preferredId?: string) {
    setError("");
    try {
      const next = await sendMessage({ type: "GET_BROWSER_TOOL_STATE", tabId: targetTabId });
      setState(next);
      setSelectedId((current) => {
        if (preferredId && next.tools.some((tool) => tool.id === preferredId)) return preferredId;
        if (current && next.tools.some((tool) => tool.id === current)) return current;
        return next.matchedToolIds[0] || next.tools[0]?.id || "";
      });
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }

  async function importTool() {
    if (!yamlDraft.trim()) return;
    setBusy(true);
    setError("");
    try {
      const imported = await sendMessage({ type: "IMPORT_BROWSER_TOOL", yaml: yamlDraft });
      setYamlDraft("");
      await refresh(imported.id);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function runTool() {
    if (!selectedTool || !state?.targetTab) return;
    setBusy(true);
    setError("");
    setLastResult(undefined);
    try {
      const result = await sendMessage({
        type: "RUN_STORED_BROWSER_TOOL",
        toolId: selectedTool.id,
        parameters,
        tabId: state.targetTab.id,
        userInitiated: true
      });
      setLastResult(result);
      await refresh(selectedTool.id);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTool(tool: StoredBrowserTool) {
    if (!window.confirm(`删除 Browser Tool“${tool.definition.name}”？`)) return;
    setBusy(true);
    try {
      await sendMessage({ type: "DELETE_BROWSER_TOOL", toolId: tool.id });
      await refresh();
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadFile(file?: File) {
    if (!file) return;
    setYamlDraft(await file.text());
  }

  return (
    <main className="page-shell tools-shell">
      <div className="page-inner stack tools-page">
        <header className="header-row tools-header">
          <div className="brand">
            <BrandMark />
            <div>
              <h1 className="page-title">Browser Tools</h1>
              <div className="muted">用 YAML 驱动当前浏览器页面</div>
            </div>
          </div>
          <button className="button secondary" disabled={busy} onClick={() => void refresh(selectedId)}>
            <RefreshCw size={16} /> 刷新
          </button>
        </header>

        <section className="panel target-tab-panel">
          <div>
            <div className="muted text-small">目标标签页</div>
            <strong>{state?.targetTab?.title || "未找到普通网页标签页"}</strong>
            <div className="muted tool-url">{state?.targetTab?.url || "请从 Trail popup 打开 Browser Tools。"}</div>
          </div>
          {state?.targetTab?.url ? (
            <a className="button secondary" href={state.targetTab.url} target="_blank" rel="noreferrer">
              <ExternalLink size={15} /> 打开
            </a>
          ) : null}
        </section>

        {error ? <div className="card error-text">{error}</div> : null}

        <div className="tools-grid">
          <aside className="stack">
            <section className="panel stack">
              <div className="header-row">
                <strong>已安装工具</strong>
                <span className="badge">{state?.tools.length || 0}</span>
              </div>
              <div className="tool-list">
                {(state?.tools || []).map((tool) => {
                  const matched = state?.matchedToolIds.includes(tool.id);
                  return (
                    <button
                      className={selectedId === tool.id ? "tool-list-item active" : "tool-list-item"}
                      key={tool.id}
                      onClick={() => setSelectedId(tool.id)}
                    >
                      <span>
                        <strong>{tool.definition.name}</strong>
                        <span className="muted text-small">{tool.id}</span>
                      </span>
                      <span className={matched ? "mini-badge tool-match" : "mini-badge"}>{matched ? "当前可用" : "不匹配"}</span>
                    </button>
                  );
                })}
                {state?.tools.length === 0 ? <p className="muted">还没有导入 Browser Tool。</p> : null}
              </div>
            </section>

            <section className="panel stack">
              <strong>导入 YAML</strong>
              <textarea
                className="input yaml-editor"
                value={yamlDraft}
                spellCheck={false}
                placeholder="粘贴 tool.yml，或从本地选择文件"
                onChange={(event) => setYamlDraft(event.target.value)}
              />
              <input
                ref={fileInputRef}
                className="visually-hidden"
                type="file"
                accept=".yml,.yaml,text/yaml,application/yaml"
                onChange={(event) => void loadFile(event.target.files?.[0])}
              />
              <div className="toolbar">
                <button className="button secondary" onClick={() => fileInputRef.current?.click()}>
                  <FileUp size={16} /> 选择文件
                </button>
                <button className="button primary" disabled={busy || !yamlDraft.trim()} onClick={() => void importTool()}>
                  导入或更新
                </button>
              </div>
            </section>
          </aside>

          <section className="stack">
            {selectedTool ? (
              <section className="panel stack">
                <div className="header-row">
                  <div>
                    <div className="setting-title">
                      <Wrench size={18} />
                      <h2 className="tool-title">{selectedTool.definition.name}</h2>
                    </div>
                    <div className="muted">{selectedTool.definition.description || selectedTool.id}</div>
                  </div>
                  <button className="icon-button danger" title="删除工具" onClick={() => void deleteTool(selectedTool)}>
                    <Trash2 size={16} />
                  </button>
                </div>

                <div className="tool-meta">
                  <span className="mini-badge">v{selectedTool.definition.version}</span>
                  {selectedTool.definition.match.domains.map((domain) => (
                    <span className="mini-badge" key={domain}>{domain}</span>
                  ))}
                </div>

                <ParameterForm
                  definitions={selectedTool.definition.parameters || {}}
                  values={parameters}
                  onChange={(name, value) => setParameters((current) => ({ ...current, [name]: value }))}
                />

                <button className="button primary full" disabled={busy || !isMatched || !state?.targetTab} onClick={() => void runTool()}>
                  <Play size={16} /> {busy ? "运行中…" : isMatched ? "在目标标签页运行" : "当前页面不匹配"}
                </button>
              </section>
            ) : (
              <section className="panel empty-tools-state">
                <Wrench size={24} />
                <strong>选择或导入一个 Browser Tool</strong>
                <span className="muted">工具会在匹配的目标标签页中运行。</span>
              </section>
            )}

            {lastResult ? <RunResult result={lastResult} title="本次运行" /> : null}

            <section className="panel stack">
              <div className="header-row">
                <strong>最近运行</strong>
                <span className="badge">{state?.recentRuns.length || 0}</span>
              </div>
              {(state?.recentRuns || []).map((run) => (
                <details className="run-history-item" key={run.runId}>
                  <summary>
                    <span><strong>{run.toolName}</strong><span className="muted text-small">{formatDateTime(run.savedAt)}</span></span>
                    <span className={`mini-badge run-${run.status}`}>{statusLabel(run.status)}</span>
                  </summary>
                  <RunCollections data={run.data} />
                  {run.error ? <p className="error-text">{run.error}</p> : null}
                </details>
              ))}
              {state?.recentRuns.length === 0 ? <p className="muted">运行结果会保存在本地。</p> : null}
            </section>
          </section>
        </div>
      </div>
    </main>
  );
}

function ParameterForm({
  definitions,
  values,
  onChange
}: {
  definitions: Record<string, BrowserToolParameterDefinition>;
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}) {
  const entries = Object.entries(definitions);
  if (entries.length === 0) return <p className="muted">这个工具不需要参数。</p>;

  return (
    <div className="tool-parameter-grid">
      {entries.map(([name, definition]) => (
        <label className="label" key={name}>
          {definition.label || name}{definition.required ? " *" : ""}
          {definition.type === "boolean" ? (
            <input
              type="checkbox"
              checked={Boolean(values[name])}
              onChange={(event) => onChange(name, event.target.checked)}
            />
          ) : (
            <input
              className="input"
              type={definition.type === "number" ? "number" : "text"}
              min={definition.min}
              max={definition.max}
              value={values[name] === undefined ? "" : String(values[name])}
              onChange={(event) =>
                onChange(
                  name,
                  definition.type === "number"
                    ? event.target.value === ""
                      ? undefined
                      : Number(event.target.value)
                    : event.target.value
                )
              }
            />
          )}
        </label>
      ))}
    </div>
  );
}

function RunResult({ result, title }: { result: BrowserToolRunResult; title: string }) {
  return (
    <section className="panel stack">
      <div className="header-row">
        <strong>{title}</strong>
        <span className={`mini-badge run-${result.status}`}>{statusLabel(result.status)}</span>
      </div>
      <RunCollections data={result.data} />
      {result.warnings.map((warning) => <p className="muted" key={warning}>{warning}</p>)}
      {result.error ? <p className="error-text">{result.error}</p> : null}
    </section>
  );
}

function RunCollections({ data }: { data: BrowserToolRunResult["data"] }) {
  const entries = Object.entries(data);
  return (
    <div className="run-collections">
      {entries.map(([name, records]) => (
        <details key={name}>
          <summary><strong>{name}</strong><span className="badge">{records.length}</span></summary>
          <pre>{JSON.stringify(records.slice(0, 20), null, 2)}</pre>
        </details>
      ))}
      {entries.length === 0 ? <span className="muted">没有提取到数据。</span> : null}
    </div>
  );
}

function statusLabel(status: BrowserToolRunResult["status"]): string {
  switch (status) {
    case "completed": return "已完成";
    case "paused": return "等待用户";
    case "partial": return "部分完成";
    case "cancelled": return "已取消";
    case "failed": return "失败";
  }
}

function readTargetTabId(): number | undefined {
  const raw = new URLSearchParams(location.search).get("targetTabId");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Browser Tool 操作失败。";
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserToolsApp />
  </React.StrictMode>
);
