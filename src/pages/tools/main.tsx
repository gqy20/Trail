import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/noto-sans-sc/wght.css";
import { Download, ExternalLink, FileJson, FileUp, History, Play, Plus, RefreshCw, Settings2, Trash2, Wrench, X } from "lucide-react";
import { BrandMark } from "../../shared/BrandMark";
import { installDevChromeMock } from "../../shared/devChromeMock";
import { sendMessage } from "../../shared/runtime";
import { formatDateTime } from "../../shared/time";
import type {
  BrowserToolManagerState,
  BrowserToolCollectionPresentation,
  BrowserToolDefinition,
  BrowserToolFieldPresentation,
  BrowserToolParameterDefinition,
  BrowserToolPresentation,
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
  const [inputMode, setInputMode] = useState<"direct" | "compose">("direct");
  const [composerGroups, setComposerGroups] = useState<string[]>(["", ""]);
  const [composerOperator, setComposerOperator] = useState("AND");
  const [autoExportCsv, setAutoExportCsv] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<"single" | "batch">();
  const [activeView, setActiveView] = useState<"collect" | "results" | "history" | "settings">("collect");
  const [error, setError] = useState("");
  const [catalogNotice, setCatalogNotice] = useState("");
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
  const toolUi = resolveToolUi(selectedTool?.definition);
  const directBatchKeywords = useMemo(
    () => parseBatchInput(keywordDraft, selectedTool?.definition.presentation?.batch_input?.csv_headers),
    [keywordDraft, selectedTool?.updatedAt]
  );
  const batchLimit = selectedTool?.definition.batch?.max_keywords || 25;
  const composerEnabled = toolUi.input.composer.enabled;
  const composerDefaultOperator = toolUi.input.composer.defaultOperator;
  const isComposerMode = composerEnabled && inputMode === "compose";
  const composedBatch = useMemo(
    () => composeBatchInput(composerGroups, composerOperator, batchLimit + 1),
    [composerGroups, composerOperator, batchLimit]
  );
  const batchKeywords = isComposerMode ? composedBatch.values : directBatchKeywords;
  const batchInputCount = isComposerMode ? composedBatch.total : batchKeywords.length;
  const composerIncomplete = isComposerMode && composedBatch.activeGroupCount < 2;
  const batchTooLarge = batchInputCount > batchLimit;
  const hasPrimaryParameters = Object.values(selectedTool?.definition.parameters || {}).some(
    (definition) => definition.presentation?.placement === "primary"
  );
  const lastResultDefinition = lastResult ? getToolDefinition(lastResult.toolId, state?.tools || []) : undefined;

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
    setInputMode("direct");
    setComposerGroups(["", ""]);
    setComposerOperator(composerDefaultOperator);
  }, [selectedTool?.id, selectedTool?.updatedAt, composerDefaultOperator]);

  useEffect(() => {
    document.title = `Trail · ${toolUi.title}`;
  }, [toolUi.title]);

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

  async function syncBundledTools() {
    setBusy(true);
    setError("");
    setCatalogNotice("");
    try {
      const result = await sendMessage({ type: "IMPORT_BUNDLED_BROWSER_TOOLS" });
      setCatalogNotice(formatBundledImportResult(result));
      await refresh();
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
      setActiveView("results");
      await refresh(selectedTool.id);
    } catch (err) {
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
      setBusyAction(undefined);
    }
  }

  async function runBatch() {
    if (!selectedTool?.definition.batch || !state?.targetTab || batchKeywords.length === 0 || composerIncomplete || batchTooLarge) return;
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
      setActiveView("results");
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
            <h1 className="page-title">{toolUi.title}</h1>
          </div>
          <nav className="tools-nav" aria-label={`${toolUi.title}导航`}>
            <button className={activeView === "collect" ? "tools-nav-item active" : "tools-nav-item"} onClick={() => setActiveView("collect")}>运行</button>
            {lastResult ? <button className={activeView === "results" ? "tools-nav-item active" : "tools-nav-item"} onClick={() => setActiveView("results")}>结果</button> : null}
            <button className={activeView === "history" ? "tools-nav-item active" : "tools-nav-item"} onClick={() => setActiveView("history")}>
              <History size={15} /> 历史
            </button>
            <button className={activeView === "settings" ? "icon-button active" : "icon-button"} title="设置" aria-label="设置" onClick={() => setActiveView("settings")}>
              <Settings2 size={16} />
            </button>
          </nav>
        </header>

        {error ? <div className="card error-text">{error}</div> : null}

        {activeView === "collect" ? (
          <section className="collector-view">
            <div className={isMatched ? "connection-line connected" : "connection-line"}>
              <span className={isMatched ? "target-status online" : "target-status"} aria-hidden="true" />
              <span>{isMatched ? `已连接 · ${toolUi.sourceLabel}` : "当前网页暂不支持此工具"}</span>
            </div>

            {selectedTool ? (
              <div className="collector-form">
                {selectedTool.definition.batch ? (
                  <section className="keyword-section">
                    <div className="field-heading">
                      <label htmlFor={isComposerMode ? undefined : "batch-keywords"}>{toolUi.input.label}</label>
                      <div className="field-actions">
                        {!isComposerMode ? (
                          <button className="text-button" disabled={busy} onClick={() => keywordFileInputRef.current?.click()}>
                            <FileUp size={14} /> 导入 {toolUi.input.importFormats.map((format) => format.toUpperCase()).join("/")}
                          </button>
                        ) : null}
                        {(!isComposerMode && keywordDraft) || (isComposerMode && composerGroups.some(Boolean)) ? (
                          <button
                            className="text-button muted-action"
                            disabled={busy}
                            onClick={() => isComposerMode ? setComposerGroups(["", ""]) : setKeywordDraft("")}
                          >清空</button>
                        ) : null}
                      </div>
                    </div>
                    {composerEnabled ? (
                      <div className="input-mode-switch" role="tablist" aria-label={`${toolUi.input.label}输入方式`}>
                        <button role="tab" aria-selected={!isComposerMode} className={!isComposerMode ? "active" : ""} onClick={() => setInputMode("direct")}>多条输入</button>
                        <button role="tab" aria-selected={isComposerMode} className={isComposerMode ? "active" : ""} onClick={() => setInputMode("compose")}>{toolUi.input.composer.label}</button>
                      </div>
                    ) : null}
                    {isComposerMode ? (
                      <KeywordComposer
                        groups={composerGroups}
                        operator={composerOperator}
                        operators={toolUi.input.composer.operators}
                        maxGroups={toolUi.input.composer.maxGroups}
                        groupLabel={toolUi.input.composer.groupLabel}
                        placeholder={toolUi.input.composer.placeholder}
                        preview={composedBatch.values}
                        total={composedBatch.total}
                        limit={batchLimit}
                        disabled={busy}
                        onGroupsChange={setComposerGroups}
                        onOperatorChange={setComposerOperator}
                      />
                    ) : (
                      <textarea
                        id="batch-keywords"
                        className="input keyword-editor collector-keywords"
                        value={keywordDraft}
                        spellCheck={false}
                        placeholder={toolUi.input.placeholder}
                        onChange={(event) => setKeywordDraft(event.target.value)}
                      />
                    )}
                    <input
                      ref={keywordFileInputRef}
                      className="visually-hidden"
                      type="file"
                      accept={getImportAccept(toolUi.input.importFormats)}
                      onChange={(event) => {
                        void loadKeywordFile(event.target.files?.[0]);
                        event.currentTarget.value = "";
                      }}
                    />
                    <div className="keyword-summary">
                      <span className={batchTooLarge ? "error-text" : "muted"}>{formatCount(batchInputCount, toolUi.input.countUnit, toolUi.input.itemLabel)} / {batchLimit}</span>
                      {composerIncomplete ? <span className="error-text">请至少填写两个词组</span> : null}
                      {batchTooLarge ? <span className="error-text">请减少 {batchInputCount - batchLimit} 个</span> : null}
                    </div>
                  </section>
                ) : null}

                {hasPrimaryParameters || selectedTool.definition.batch ? (
                  <section className="collection-options">
                    <PrimaryParameterControls
                      definitions={selectedTool.definition.parameters || {}}
                      values={parameters}
                      onChange={(name, value) => setParameters((current) => ({ ...current, [name]: value }))}
                    />
                    {selectedTool.definition.batch ? (
                      <label className="batch-export-option">
                        <input type="checkbox" checked={autoExportCsv} onChange={(event) => setAutoExportCsv(event.target.checked)} />
                        完成后自动导出 CSV
                      </label>
                    ) : null}
                  </section>
                ) : null}

                {selectedTool.definition.batch ? (
                  <button
                    className="button primary full collect-button"
                    disabled={busy || !isMatched || !state?.targetTab || batchKeywords.length === 0 || composerIncomplete || batchTooLarge}
                    onClick={() => void runBatch()}
                  >
                    <Play size={16} /> {busyAction === "batch"
                      ? toolUi.actions.running
                      : batchInputCount
                        ? `${toolUi.actions.run} ${formatCount(batchInputCount, toolUi.input.countUnit, toolUi.input.itemLabel)}`
                        : toolUi.actions.runEmpty}
                  </button>
                ) : (
                  <button className="button primary full collect-button" disabled={busy || !isMatched || !state?.targetTab} onClick={() => void runTool()}>
                    <Play size={16} /> {busyAction === "single" ? toolUi.actions.singleRunning : toolUi.actions.singleRun}
                  </button>
                )}

              </div>
            ) : (
              <section className="empty-tools-state">
                <Wrench size={24} />
                <strong>尚未配置采集工具</strong>
                <button className="button secondary" onClick={() => setActiveView("settings")}>前往设置</button>
              </section>
            )}
          </section>
        ) : null}

        {activeView === "results" ? (
          lastResult
            ? <RunResult result={lastResult} definition={lastResultDefinition} />
            : <EmptyResult definition={selectedTool?.definition} onBack={() => setActiveView("collect")} />
        ) : null}

        {activeView === "history" ? (
          <section className="history-view stack">
            <div className="view-heading">
              <h2>历史记录</h2>
              <span className="muted">{state?.recentRuns.length || 0} 次运行</span>
            </div>
            {(state?.recentRuns || []).map((run) => (
                <details className="panel run-history-item" key={run.runId}>
                  <summary>
                    <span><strong>{getRunTitle(run, state?.tools || [])}</strong><span className="muted text-small">{formatDateTime(run.savedAt)}</span></span>
                    <span className={`mini-badge run-${run.status}`}>{statusLabel(run.status)}</span>
                  </summary>
                  <RunExportActions result={run} />
                  <RunCollections data={run.data} presentation={getToolDefinition(run.toolId, state?.tools || [])?.presentation} initiallyOpen={false} />
                  {run.error ? <p className="error-text">{run.error}</p> : null}
                </details>
            ))}
            {state?.recentRuns.length === 0 ? <EmptyResult definition={selectedTool?.definition} onBack={() => setActiveView("collect")} /> : null}
          </section>
        ) : null}

        {activeView === "settings" ? (
          <section className="settings-view stack">
            <div className="view-heading header-row">
              <div><h2>设置</h2><span className="muted">工具和高级参数</span></div>
              <button className="icon-button" title="刷新页面状态" aria-label="刷新页面状态" disabled={busy} onClick={() => void refresh(selectedId)}><RefreshCw size={16} /></button>
            </div>

            <section className="settings-section stack">
              <div className="section-heading"><strong>当前网页</strong></div>
              <div className="settings-target-row">
                <span className={isMatched ? "target-status online" : "target-status"} />
                <span>{state?.targetTab?.title || "未连接普通网页"}</span>
                {state?.targetTab?.url ? <a className="icon-button" href={state.targetTab.url} target="_blank" rel="noreferrer" aria-label="打开当前网页"><ExternalLink size={15} /></a> : null}
              </div>
              {toolUi.actions.hasSingleRun ? (
                <button className="button secondary" disabled={busy || !isMatched || !state?.targetTab} onClick={() => void runTool()}>
                  <Play size={15} /> {busyAction === "single" ? toolUi.actions.singleRunning : toolUi.actions.singleRun}
                </button>
              ) : null}
            </section>

            <section className="settings-section stack">
              <div className="section-heading"><strong>工具</strong><span className="muted text-small">{state?.tools.length || 0} 个</span></div>
              <div className="bundled-tools-row">
                <span>
                  <strong>内置工具库</strong>
                  <small>由 browser-tools/catalog.yml 统一管理</small>
                </span>
                <button className="button secondary compact-button" disabled={busy} onClick={() => void syncBundledTools()}>
                  <RefreshCw size={14} /> 同步
                </button>
              </div>
              {catalogNotice ? <p className="muted text-small catalog-notice">{catalogNotice}</p> : null}
              <div className="tool-list">
                {(state?.tools || []).map((tool) => {
                  const matched = state?.matchedToolIds.includes(tool.id);
                  return (
                    <div className={selectedId === tool.id ? "tool-settings-row active" : "tool-settings-row"} key={tool.id}>
                      <button className="tool-select-button" onClick={() => setSelectedId(tool.id)}>
                        <span><strong>{tool.definition.name}</strong><small>v{tool.definition.version} · {tool.source?.type === "bundled" ? "内置" : "自定义"}</small></span>
                        <span className={matched ? "tool-state available" : "tool-state"}>{matched ? "当前可用" : "其他页面"}</span>
                      </button>
                      <button className="icon-button danger" aria-label={`删除${tool.definition.name}`} onClick={() => void deleteTool(tool)}><Trash2 size={15} /></button>
                    </div>
                  );
                })}
              </div>
              {selectedTool ? (
                <ParameterForm
                  definitions={Object.fromEntries(Object.entries(selectedTool.definition.parameters || {}).filter(([, definition]) => definition.presentation?.placement !== "primary"))}
                  values={parameters}
                  onChange={(name, value) => setParameters((current) => ({ ...current, [name]: value }))}
                />
              ) : null}
            </section>

            <details className="settings-section stack yaml-settings">
              <summary><strong>导入或更新 YAML 工具</strong><span className="muted text-small">高级</span></summary>
              <textarea className="input yaml-editor" value={yamlDraft} spellCheck={false} placeholder="粘贴 tool.yml，或选择本地文件" onChange={(event) => setYamlDraft(event.target.value)} />
              <input ref={fileInputRef} className="visually-hidden" type="file" accept=".yml,.yaml,text/yaml,application/yaml" onChange={(event) => void loadFile(event.target.files?.[0])} />
              <div className="toolbar">
                <button className="button secondary" onClick={() => fileInputRef.current?.click()}><FileUp size={16} /> 选择文件</button>
                <button className="button primary" disabled={busy || !yamlDraft.trim()} onClick={() => void importTool()}>导入或更新</button>
              </div>
            </details>
          </section>
        ) : null}
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
          <ParameterInput name={name} definition={definition} value={values[name]} onChange={onChange} />
        </label>
      ))}
    </div>
  );
}

function KeywordComposer({
  groups,
  operator,
  operators,
  maxGroups,
  groupLabel,
  placeholder,
  preview,
  total,
  limit,
  disabled,
  onGroupsChange,
  onOperatorChange
}: {
  groups: string[];
  operator: string;
  operators: string[];
  maxGroups: number;
  groupLabel: string;
  placeholder: string;
  preview: string[];
  total: number;
  limit: number;
  disabled: boolean;
  onGroupsChange: (groups: string[]) => void;
  onOperatorChange: (operator: string) => void;
}) {
  function updateGroup(index: number, value: string) {
    onGroupsChange(groups.map((group, groupIndex) => groupIndex === index ? value : group));
  }

  function removeGroup(index: number) {
    onGroupsChange(groups.filter((_, groupIndex) => groupIndex !== index));
  }

  return (
    <div id="batch-keywords" className="keyword-composer">
      <div className="composer-toolbar">
        <label>
          <span>连接符</span>
          <select className="input composer-operator" value={operator} disabled={disabled} onChange={(event) => onOperatorChange(event.target.value)}>
            {operators.map((item) => <option value={item} key={item}>{item}</option>)}
          </select>
        </label>
        <button className="text-button" disabled={disabled || groups.length >= maxGroups} onClick={() => onGroupsChange([...groups, ""])}>
          <Plus size={14} /> 添加{groupLabel}
        </button>
      </div>
      <div className="composer-groups">
        {groups.map((group, index) => (
          <div className="composer-group" key={index}>
            <div className="composer-group-heading">
              <label htmlFor={`composer-group-${index}`}>{groupLabel} {index + 1}</label>
              {groups.length > 2 ? (
                <button className="icon-button compact-icon-button" disabled={disabled} aria-label={`删除${groupLabel} ${index + 1}`} onClick={() => removeGroup(index)}>
                  <X size={14} />
                </button>
              ) : null}
            </div>
            <textarea
              id={`composer-group-${index}`}
              className="input composer-group-input"
              value={group}
              disabled={disabled}
              spellCheck={false}
              placeholder={placeholder}
              onChange={(event) => updateGroup(index, event.target.value)}
            />
          </div>
        ))}
      </div>
      <div className={total > limit ? "composer-preview over-limit" : "composer-preview"}>
        <div><strong>组合预览</strong><span>{total > 0 ? `${total} 条` : "等待输入"}</span></div>
        {preview.length > 0 ? (
          <ol>
            {preview.slice(0, 4).map((item, index) => <li key={`${index}-${item}`}><code>{item}</code></li>)}
          </ol>
        ) : <p>每个词组一行一个词，系统会生成全部跨组组合。</p>}
        {total > 4 ? <small>另有 {total - 4} 条未显示</small> : null}
      </div>
    </div>
  );
}

function PrimaryParameterControls({
  definitions,
  values,
  onChange
}: {
  definitions: Record<string, BrowserToolParameterDefinition>;
  values: Record<string, unknown>;
  onChange: (name: string, value: unknown) => void;
}) {
  const entries = Object.entries(definitions).filter(([, definition]) => definition.presentation?.placement === "primary");
  if (entries.length === 0) return null;
  return (
    <div className="primary-parameters">
      {entries.map(([name, definition]) => {
        const ui = definition.presentation;
        if (ui?.style === "sentence") {
          return (
            <label className="parameter-sentence" key={name}>
              {ui.prefix ? <span>{ui.prefix}</span> : null}
              <ParameterInput name={name} definition={definition} value={values[name]} onChange={onChange} compact />
              {ui.suffix ? <span>{ui.suffix}</span> : null}
            </label>
          );
        }
        return (
          <label className="label primary-parameter-field" key={name}>
            {definition.label || name}
            <ParameterInput name={name} definition={definition} value={values[name]} onChange={onChange} />
          </label>
        );
      })}
    </div>
  );
}

function ParameterInput({
  name,
  definition,
  value,
  onChange,
  compact = false
}: {
  name: string;
  definition: BrowserToolParameterDefinition;
  value: unknown;
  onChange: (name: string, value: unknown) => void;
  compact?: boolean;
}) {
  if (definition.type === "boolean") {
    return <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(name, event.target.checked)} />;
  }
  return (
    <input
      className={compact ? "parameter-compact-input" : "input"}
      type={definition.type === "number" ? "number" : "text"}
      min={definition.min}
      max={definition.max}
      value={value === undefined ? "" : String(value)}
      onChange={(event) => onChange(name, definition.type === "number" ? (event.target.value === "" ? undefined : Number(event.target.value)) : event.target.value)}
    />
  );
}

function EmptyResult({ definition, onBack }: { definition?: BrowserToolDefinition; onBack: () => void }) {
  const ui = resolveToolUi(definition);
  return (
    <section className="empty-result">
      <strong>{ui.results.emptyTitle}</strong>
      <span className="muted">{ui.results.emptyDescription}</span>
      <button className="button secondary" onClick={onBack}>{ui.actions.run}</button>
    </section>
  );
}

function RunResult({ result, definition }: { result: BrowserToolRunResult; definition?: BrowserToolDefinition }) {
  const ui = resolveToolUi(definition);
  const recordCount = countRecords(result.data);
  return (
    <section className="panel stack run-result">
      <div className="header-row run-result-header">
        <div className="run-result-heading">
          <span className="tool-eyebrow">{ui.results.title}</span>
          <strong>{formatCount(recordCount, ui.results.countUnit, ui.results.itemLabel)}</strong>
        </div>
        <div className="run-result-controls">
          <span className={`mini-badge run-${result.status}`}>{statusLabel(result.status)}</span>
          <RunExportActions result={result} />
        </div>
      </div>
      <RunCollections data={result.data} presentation={definition?.presentation} />
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

function RunCollections({
  data,
  presentation,
  initiallyOpen = true
}: {
  data: BrowserToolRunResult["data"];
  presentation?: BrowserToolPresentation;
  initiallyOpen?: boolean;
}) {
  const entries = Object.entries(data);
  return (
    <div className="run-collections">
      {entries.map(([name, records]) => (
        <CollectionPreview
          name={name}
          records={records}
          presentation={presentation?.collections?.[name]}
          initiallyOpen={initiallyOpen}
          showHeader={entries.length > 1}
          key={name}
        />
      ))}
      {entries.length === 0 ? <span className="muted">没有提取到数据。</span> : null}
    </div>
  );
}

function CollectionPreview({
  name,
  records,
  presentation,
  initiallyOpen,
  showHeader
}: {
  name: string;
  records: Array<Record<string, unknown>>;
  presentation?: BrowserToolCollectionPresentation;
  initiallyOpen: boolean;
  showHeader: boolean;
}) {
  const columns = getOrderedColumns(records, presentation).slice(0, 10);
  const content = records.length > 0 ? (
    <div className="result-table-wrap">
      <table className="result-preview-table">
        <thead>
          <tr>{columns.map((column) => <th key={column}>{getFieldLabel(column, presentation)}</th>)}</tr>
        </thead>
        <tbody>
          {records.slice(0, 20).map((record, index) => (
            <tr key={index}>
              {columns.map((column) => {
                const fieldPresentation = presentation?.fields?.[column];
                return (
                  <td
                    className={fieldPresentation?.emphasis ? `field-${fieldPresentation.emphasis}` : undefined}
                    data-label={getFieldLabel(column, presentation)}
                    key={column}
                  >
                    {renderCellValue(record[column], fieldPresentation)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {records.length > 20 ? <div className="muted text-small result-preview-note">预览前 20 条，导出包含全部已保存记录。</div> : null}
    </div>
  ) : <span className="muted">没有记录。</span>;

  return showHeader ? (
    <details open={initiallyOpen}>
      <summary><strong>{presentation?.label || name}</strong><span className="muted text-small">{formatCount(records.length, presentation?.count_unit || "条", presentation?.item_label || "记录")}</span></summary>
      {content}
    </details>
  ) : (
    <div className="collection-preview">{content}</div>
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

function getOrderedColumns(
  records: Array<Record<string, unknown>>,
  presentation?: BrowserToolCollectionPresentation
): string[] {
  const columns = getCollectionColumns(records);
  return columns
    .map((column, index) => ({ column, index, order: presentation?.fields?.[column]?.order ?? Number.MAX_SAFE_INTEGER }))
    .sort((left, right) => left.order - right.order || left.index - right.index)
    .map(({ column }) => column);
}

function countRecords(data: BrowserToolRunResult["data"]): number {
  return Object.values(data).reduce((total, records) => total + records.length, 0);
}

function getFieldLabel(name: string, presentation?: BrowserToolCollectionPresentation): string {
  return presentation?.fields?.[name]?.label || name;
}

function renderCellValue(value: unknown, presentation?: BrowserToolFieldPresentation): React.ReactNode {
  const isUrl = typeof value === "string" && /^https?:\/\//i.test(value);
  if (presentation?.display === "link" || (presentation?.display !== "text" && isUrl)) {
    return isUrl ? <a className="result-link" href={value} target="_blank" rel="noreferrer">打开</a> : formatCellValue(value);
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

function parseBatchInput(source: string, csvHeaders?: string[]): string[] {
  const text = source.replace(/^\uFEFF/, "").trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const rows = lines.map(parseCsvRow);
  if (rows.length === 0) return [];

  const headerAliases = new Set((csvHeaders || ["input", "value", "term", "query", "keyword"]).map((header) => header.toLowerCase()));
  const headerIndex = rows[0].findIndex((cell) => headerAliases.has(cell.trim().toLowerCase()));
  const values = headerIndex >= 0
    ? rows.slice(1).map((row) => (row[headerIndex] || "").trim())
    : lines;
  return [...new Set(values.filter(Boolean))];
}

function composeBatchInput(groups: string[], operator: string, maxGenerated: number): {
  values: string[];
  total: number;
  activeGroupCount: number;
} {
  const termGroups = groups
    .map((group) => [...new Set(group.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))])
    .filter((group) => group.length > 0);
  const total = termGroups.reduce((count, group) => Math.min(Number.MAX_SAFE_INTEGER, count * group.length), termGroups.length ? 1 : 0);
  if (termGroups.length < 2) return { values: [], total, activeGroupCount: termGroups.length };

  let combinations: string[][] = [[]];
  for (const group of termGroups) {
    const next: string[][] = [];
    for (const combination of combinations) {
      for (const term of group) {
        next.push([...combination, term]);
        if (next.length >= maxGenerated) break;
      }
      if (next.length >= maxGenerated) break;
    }
    combinations = next;
  }

  return {
    values: combinations.map((parts) => parts.join(` ${operator} `)),
    total,
    activeGroupCount: termGroups.length
  };
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

type ResolvedToolUi = {
  title: string;
  sourceLabel: string;
  input: {
    label: string;
    placeholder: string;
    itemLabel: string;
    countUnit: string;
    importFormats: Array<"txt" | "csv">;
    composer: {
      enabled: boolean;
      label: string;
      groupLabel: string;
      placeholder: string;
      operators: string[];
      defaultOperator: string;
      maxGroups: number;
    };
  };
  actions: {
    run: string;
    runEmpty: string;
    running: string;
    singleRun: string;
    singleRunning: string;
    hasSingleRun: boolean;
  };
  results: {
    title: string;
    itemLabel: string;
    countUnit: string;
    emptyTitle: string;
    emptyDescription: string;
  };
};

function resolveToolUi(definition?: BrowserToolDefinition): ResolvedToolUi {
  const presentation = definition?.presentation;
  return {
    title: presentation?.title || definition?.name || "数据采集",
    sourceLabel: presentation?.source_label || definition?.name || "当前网页",
    input: {
      label: presentation?.batch_input?.label || "批量输入",
      placeholder: presentation?.batch_input?.placeholder || "每行输入一项",
      itemLabel: presentation?.batch_input?.item_label || "输入项",
      countUnit: presentation?.batch_input?.count_unit || "个",
      importFormats: presentation?.batch_input?.import_formats || ["txt", "csv"],
      composer: {
        enabled: presentation?.batch_input?.composer?.enabled === true,
        label: presentation?.batch_input?.composer?.label || "组合生成",
        groupLabel: presentation?.batch_input?.composer?.group_label || "词组",
        placeholder: presentation?.batch_input?.composer?.placeholder || "每行输入一个词",
        operators: presentation?.batch_input?.composer?.operators || ["AND", "OR"],
        defaultOperator: presentation?.batch_input?.composer?.default_operator || presentation?.batch_input?.composer?.operators?.[0] || "AND",
        maxGroups: presentation?.batch_input?.composer?.max_groups || 4
      }
    },
    actions: {
      run: presentation?.actions?.run || "开始运行",
      runEmpty: presentation?.actions?.run_empty || "输入内容后开始",
      running: presentation?.actions?.running || "正在运行…",
      singleRun: presentation?.actions?.single_run || "运行当前页面",
      singleRunning: presentation?.actions?.single_running || "正在运行当前页面…",
      hasSingleRun: Boolean(presentation?.actions?.single_run)
    },
    results: {
      title: presentation?.results?.title || "本次结果",
      itemLabel: presentation?.results?.item_label || "记录",
      countUnit: presentation?.results?.count_unit || "条",
      emptyTitle: presentation?.results?.empty_title || "还没有运行结果",
      emptyDescription: presentation?.results?.empty_description || "完成一次运行后，结果会显示在这里。"
    }
  };
}

function getToolDefinition(toolId: string, tools: StoredBrowserTool[]): BrowserToolDefinition | undefined {
  return tools.find((tool) => tool.id === toolId)?.definition;
}

function getRunTitle(result: BrowserToolRunResult, tools: StoredBrowserTool[]): string {
  const definition = getToolDefinition(result.toolId, tools);
  const ui = resolveToolUi(definition);
  return `${ui.sourceLabel} · ${formatCount(countRecords(result.data), ui.results.countUnit, ui.results.itemLabel)}`;
}

function formatCount(count: number, unit: string, label: string): string {
  return `${count} ${unit}${label}`;
}

function formatBundledImportResult(result: { installed: number; updated: number; preserved: number; disabled: number }): string {
  const changes = [
    result.installed ? `新增 ${result.installed}` : "",
    result.updated ? `更新 ${result.updated}` : "",
    result.preserved ? `保留 ${result.preserved}` : ""
  ].filter(Boolean);
  return changes.length > 0 ? `同步完成：${changes.join("，")}。` : "内置工具已经是最新版本。";
}

function getImportAccept(formats: Array<"txt" | "csv">): string {
  return formats.flatMap((format) => format === "csv" ? [".csv", "text/csv"] : [".txt", "text/plain"]).join(",");
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
