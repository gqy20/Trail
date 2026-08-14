import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Download, ExternalLink, FileJson, FileUp, ListPlus, Play, RefreshCw, Settings2, Trash2, Wrench } from "lucide-react";
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
  const [keywordDraft, setKeywordDraft] = useState("");
  const [autoExportCsv, setAutoExportCsv] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<"single" | "batch">();
  const [error, setError] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const keywordFileInputRef = useRef<HTMLInputElement>(null);
  const targetTabId = useMemo(() => readTargetTabId(), []);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (targetTabId !== undefined) return;
    const handleTabChange = () => void refresh();
    chrome.tabs.onActivated.addListener(handleTabChange);
    return () => chrome.tabs.onActivated.removeListener(handleTabChange);
  }, [targetTabId]);

  const selectedTool = state?.tools.find((tool) => tool.id === selectedId);
  const isMatched = Boolean(selectedTool && state?.matchedToolIds.includes(selectedTool.id));
  const batchKeywords = useMemo(() => parseKeywordImport(keywordDraft), [keywordDraft]);
  const batchLimit = selectedTool?.definition.batch?.max_keywords || 25;
  const batchTooLarge = batchKeywords.length > batchLimit;
  const recentRuns = (state?.recentRuns || []).filter((run) => run.runId !== lastResult?.runId);

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
    setBusyAction("single");
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
      setBusyAction(undefined);
    }
  }

  async function runBatch() {
    if (!selectedTool?.definition.batch || !state?.targetTab || batchKeywords.length === 0) return;
    setBusy(true);
    setBusyAction("batch");
    setError("");
    setLastResult(undefined);
    try {
      const result = await sendMessage({
        type: "RUN_BROWSER_TOOL_BATCH",
        toolId: selectedTool.id,
        keywords: batchKeywords,
        parameters,
        tabId: state.targetTab.id,
        userInitiated: true
      });
      setLastResult(result);
      if (autoExportCsv) exportRunCsv(result);
      await refresh(selectedTool.id);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
      setBusyAction(undefined);
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

  async function loadKeywordFile(file?: File) {
    if (!file) return;
    setKeywordDraft(await file.text());
  }

  return (
    <main className="page-shell tools-shell">
      <div className="page-inner stack tools-page">
        <header className="header-row tools-header">
          <div className="brand">
            <BrandMark />
            <div>
              <h1 className="page-title">文献采集</h1>
              <div className="muted text-small">批量检索与结构化导出</div>
            </div>
          </div>
          <button className="icon-button" title="刷新页面状态" aria-label="刷新页面状态" disabled={busy} onClick={() => void refresh(selectedId)}>
            <RefreshCw size={16} />
          </button>
        </header>

        <section className="target-tab-panel">
          <span className={state?.targetTab ? "target-status online" : "target-status"} aria-hidden="true" />
          <div className="target-tab-copy">
            <span className="muted text-small">当前网页</span>
            <strong title={state?.targetTab?.title}>{state?.targetTab?.title || "未连接普通网页"}</strong>
          </div>
          {state?.targetTab?.url ? (
            <a className="icon-button" title="在标签页中打开" aria-label="在标签页中打开" href={state.targetTab.url} target="_blank" rel="noreferrer">
              <ExternalLink size={15} />
            </a>
          ) : null}
        </section>

        {error ? <div className="card error-text">{error}</div> : null}

        <div className="tools-grid">
          <aside className="stack">
            <section className="panel stack tool-library">
              <div className="header-row">
                <strong className="section-title">工具</strong>
                <span className="muted text-small">{state?.tools.length || 0} 个</span>
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
                      </span>
                      <span className={matched ? "tool-state available" : "tool-state"}>{matched ? "可用" : "其他页面"}</span>
                    </button>
                  );
                })}
                {state?.tools.length === 0 ? <p className="muted">还没有导入 Browser Tool。</p> : null}
              </div>
            </section>

            <details className="panel stack tool-config-disclosure">
              <summary>
                <span><Settings2 size={16} /> 工具配置</span>
                <span className="muted text-small">YAML</span>
              </summary>
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
            </details>
          </aside>

          <section className="stack tools-main">
            {selectedTool ? (
              <section className="panel stack tool-runner">
                <div className="header-row tool-runner-header">
                  <div className="tool-heading">
                    <span className="tool-eyebrow">当前工具 · v{selectedTool.definition.version}</span>
                    <h2 className="tool-title">{selectedTool.definition.name}</h2>
                    {selectedTool.definition.description ? <p className="muted tool-description">{selectedTool.definition.description}</p> : null}
                  </div>
                  <button className="icon-button danger" title="删除工具" aria-label="删除工具" onClick={() => void deleteTool(selectedTool)}>
                    <Trash2 size={16} />
                  </button>
                </div>

                <ParameterForm
                  definitions={selectedTool.definition.parameters || {}}
                  values={parameters}
                  onChange={(name, value) => setParameters((current) => ({ ...current, [name]: value }))}
                />

                {selectedTool.definition.batch ? (
                  <div className="batch-import stack">
                    <div className="header-row">
                      <div>
                        <div className="setting-title"><ListPlus size={17} /><strong>检索词</strong></div>
                        <div className="muted text-small">每行一个，也可导入 TXT 或 CSV</div>
                      </div>
                      <span className={batchTooLarge ? "mini-badge run-failed" : "badge"}>{batchKeywords.length}/{batchLimit}</span>
                    </div>
                    <textarea
                      className="input keyword-editor"
                      value={keywordDraft}
                      spellCheck={false}
                      placeholder={"人工智能\n机器学习\n大语言模型"}
                      onChange={(event) => setKeywordDraft(event.target.value)}
                    />
                    {batchTooLarge ? <div className="error-text text-small">当前工具最多支持 {batchLimit} 个检索词。</div> : null}
                    <input
                      ref={keywordFileInputRef}
                      className="visually-hidden"
                      type="file"
                      accept=".txt,.csv,text/plain,text/csv"
                      onChange={(event) => {
                        void loadKeywordFile(event.target.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                    <label className="batch-export-option">
                      <input type="checkbox" checked={autoExportCsv} onChange={(event) => setAutoExportCsv(event.target.checked)} />
                      完成后自动导出 CSV
                    </label>
                    <div className="toolbar">
                      <button className="button secondary" disabled={busy} onClick={() => keywordFileInputRef.current?.click()}>
                        <FileUp size={16} /> 导入文件
                      </button>
                      <button
                        className="button primary"
                        disabled={busy || !isMatched || !state?.targetTab || batchKeywords.length === 0 || batchTooLarge}
                        onClick={() => void runBatch()}
                      >
                        <Play size={16} /> {busyAction === "batch" ? "正在检索…" : `检索并提取 ${batchKeywords.length} 个词`}
                      </button>
                    </div>
                  </div>
                ) : null}

                <button className="button subtle full single-run-button" disabled={busy || !isMatched || !state?.targetTab} onClick={() => void runTool()}>
                  <Play size={15} /> {busyAction === "single" ? "正在提取…" : isMatched ? "仅提取当前结果页" : "当前网页不适用此工具"}
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

            <details className="panel stack history-panel">
              <summary>
                <strong>历史记录</strong>
                <span className="muted text-small">{recentRuns.length} 次</span>
              </summary>
              {recentRuns.map((run) => (
                <details className="run-history-item" key={run.runId}>
                  <summary>
                    <span><strong>{run.toolName}</strong><span className="muted text-small">{formatDateTime(run.savedAt)}</span></span>
                    <span className={`mini-badge run-${run.status}`}>{statusLabel(run.status)}</span>
                  </summary>
                  <RunExportActions result={run} />
                  <RunCollections data={run.data} initiallyOpen={false} />
                  {run.error ? <p className="error-text">{run.error}</p> : null}
                </details>
              ))}
              {recentRuns.length === 0 ? <p className="muted text-small">暂无其他运行记录。</p> : null}
            </details>
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
  if (entries.length === 0) return null;

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
  const recordCount = countRecords(result.data);
  return (
    <section className="panel stack run-result">
      <div className="header-row run-result-header">
        <div className="run-result-heading">
          <span className="tool-eyebrow">{title}</span>
          <strong>{recordCount} 条记录</strong>
        </div>
        <div className="run-result-controls">
          <span className={`mini-badge run-${result.status}`}>{statusLabel(result.status)}</span>
          <RunExportActions result={result} />
        </div>
      </div>
      <RunCollections data={result.data} />
      {result.warnings.length > 0 ? (
        <details className="run-warnings">
          <summary>{result.warnings.length} 条运行提示</summary>
          <ul>{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
        </details>
      ) : null}
      {result.error ? <p className="error-text">{result.error}</p> : null}
    </section>
  );
}

function RunCollections({ data, initiallyOpen = true }: { data: BrowserToolRunResult["data"]; initiallyOpen?: boolean }) {
  const entries = Object.entries(data);
  return (
    <div className="run-collections">
      {entries.map(([name, records]) => (
        <CollectionPreview name={name} records={records} initiallyOpen={initiallyOpen} key={name} />
      ))}
      {entries.length === 0 ? <span className="muted">没有提取到数据。</span> : null}
    </div>
  );
}

function CollectionPreview({ name, records, initiallyOpen }: { name: string; records: Array<Record<string, unknown>>; initiallyOpen: boolean }) {
  const columns = getOrderedColumns(records).slice(0, 10);
  return (
    <details open={initiallyOpen}>
      <summary><strong>{collectionLabel(name)}</strong><span className="muted text-small">{records.length} 条</span></summary>
      {records.length > 0 ? (
        <div className="result-table-wrap">
          <table className="result-preview-table">
            <thead>
              <tr>{columns.map((column) => <th key={column}>{columnLabel(column)}</th>)}</tr>
            </thead>
            <tbody>
              {records.slice(0, 20).map((record, index) => (
                <tr key={index}>
                  {columns.map((column) => <td data-label={columnLabel(column)} key={column}>{renderCellValue(record[column])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {records.length > 20 ? <div className="muted text-small result-preview-note">预览前 20 条，导出包含全部已保存记录。</div> : null}
        </div>
      ) : <span className="muted">没有记录。</span>}
    </details>
  );
}

function RunExportActions({ result }: { result: BrowserToolRunResult }) {
  return (
    <div className="toolbar run-export-actions">
      <button className="button secondary compact-button" onClick={() => exportRunCsv(result)}>
        <Download size={15} /> 导出 CSV
      </button>
      <button className="icon-button" title="导出 JSON" aria-label="导出 JSON" onClick={() => exportRunJson(result)}>
        <FileJson size={15} />
      </button>
    </div>
  );
}

function exportRunCsv(result: BrowserToolRunResult): void {
  const collections = Object.entries(result.data);
  const columns = [...new Set(collections.flatMap(([, records]) => getCollectionColumns(records)))];
  const includeCollection = collections.length > 1;
  const header = includeCollection ? ["_collection", ...columns] : columns;
  const rows = collections.flatMap(([collection, records]) =>
    records.map((record) => {
      const values = columns.map((column) => formatCsvValue(record[column]));
      return includeCollection ? [collection, ...values] : values;
    })
  );
  const csv = [header, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\r\n");
  downloadTextFile(`\uFEFF${csv}`, `${getRunFileBase(result)}.csv`, "text/csv;charset=utf-8");
}

function exportRunJson(result: BrowserToolRunResult): void {
  downloadTextFile(JSON.stringify(result, null, 2), `${getRunFileBase(result)}.json`, "application/json;charset=utf-8");
}

function getCollectionColumns(records: Array<Record<string, unknown>>): string[] {
  return [...new Set(records.flatMap((record) => Object.keys(record)))];
}

function getOrderedColumns(records: Array<Record<string, unknown>>): string[] {
  const columns = getCollectionColumns(records);
  const preferred = ["_query", "title", "authors", "source", "published_at", "citation_count", "download_count", "database", "url"];
  return [...preferred.filter((column) => columns.includes(column)), ...columns.filter((column) => !preferred.includes(column))];
}

function countRecords(data: BrowserToolRunResult["data"]): number {
  return Object.values(data).reduce((total, records) => total + records.length, 0);
}

function collectionLabel(name: string): string {
  return name === "literature" ? "文献" : name;
}

function columnLabel(name: string): string {
  const labels: Record<string, string> = {
    _query: "检索词",
    title: "题名",
    authors: "作者",
    source: "来源",
    published_at: "发表时间",
    citation_count: "被引",
    download_count: "下载",
    database: "类型",
    url: "链接"
  };
  return labels[name] || name;
}

function renderCellValue(value: unknown): React.ReactNode {
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    return <a className="result-link" href={value} target="_blank" rel="noreferrer">查看</a>;
  }
  return formatCellValue(value);
}

function formatCellValue(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (Array.isArray(value)) return value.map(formatCsvValue).join("；");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function formatCsvValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map(formatCsvValue).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function escapeCsvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function parseKeywordImport(source: string): string[] {
  const text = source.replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = lines.map(parseCsvRow);
  if (rows.length === 0) return [];

  const headerAliases = new Set(["检索词", "关键词", "keyword", "keywords", "query", "search_term", "search term"]);
  const headerIndex = rows[0].findIndex((cell) => headerAliases.has(cell.trim().toLowerCase()));
  const values = headerIndex >= 0
    ? rows.slice(1).map((row) => (row[headerIndex] || "").trim())
    : lines;
  return [...new Set(values.filter(Boolean))];
}

function parseCsvRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      cells.push(cell);
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell);
  return cells;
}

function getRunFileBase(result: BrowserToolRunResult): string {
  const timestamp = new Date(result.finishedAt).toISOString().replace(/[:.]/g, "-");
  return `Trail-${result.toolId}-${timestamp}`;
}

function downloadTextFile(content: string, fileName: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
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
