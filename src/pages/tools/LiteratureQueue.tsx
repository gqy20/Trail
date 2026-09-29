import React, { useEffect, useMemo, useRef, useState } from "react";
import { Download, ExternalLink, FileUp, Pause, Play, RotateCcw, Trash2 } from "lucide-react";
import { parseLiteratureCsv } from "../../literature-queue/csv";
import {
  clearLiteratureQueue,
  getLiteratureQueue,
  getLiteratureQueuePreferences,
  saveLiteratureQueue,
  saveLiteratureQueuePreferences
} from "../../literature-queue/storage";
import type {
  LiteratureDecision,
  LiteratureDownloadProgress,
  LiteratureQueue,
  LiteratureQueueItem,
  LiteratureQueueStatus
} from "../../literature-queue/types";
import { sendMessage } from "../../shared/runtime";

type QueueScope = "all" | LiteratureDecision;

export function LiteratureQueueView() {
  const [queue, setQueue] = useState<LiteratureQueue>();
  const [scope, setScope] = useState<QueueScope>("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<LiteratureDownloadProgress>();
  const [concurrency, setConcurrency] = useState(2);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void getLiteratureQueue().then(setQueue);
    void getLiteratureQueuePreferences().then((preferences) => setConcurrency(preferences.concurrency));
  }, []);

  useEffect(() => {
    const listener = (message: unknown) => {
      if (isLiteratureProgress(message)) setProgress(message);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  const scopedItems = useMemo(
    () => queue?.items.filter((item) => scope === "all" || item.decision === scope) || [],
    [queue, scope]
  );
  const runnableItems = scopedItems.filter((item) => item.status !== "completed" && Boolean(item.downloadUrl || item.pdfUrl || item.doi));
  const summary = summarize(queue?.items || []);

  async function importFile(file?: File) {
    if (!file) return;
    setError("");
    try {
      if (queue && !window.confirm(`用“${file.name}”替换当前下载队列？`)) return;
      const next = parseLiteratureCsv(await file.text(), file.name);
      await saveLiteratureQueue(next);
      setQueue(next);
      setProgress(undefined);
    } catch (err) {
      setError(toErrorMessage(err));
    }
  }

  async function startDownload() {
    if (!queue || runnableItems.length === 0) return;
    setBusy(true);
    setError("");
    setProgress({
      type: "LITERATURE_DOWNLOAD_PROGRESS",
      state: "running",
      completed: 0,
      total: runnableItems.length,
      active: 0,
      succeeded: 0,
      needsUser: 0,
      failed: 0,
      concurrency
    });
    const runningIds = new Set(runnableItems.map((item) => item.id));
    const runningQueue: LiteratureQueue = {
      ...queue,
      items: queue.items.map((item) => runningIds.has(item.id) ? { ...item, status: "resolving", error: undefined } : item)
    };
    setQueue(runningQueue);
    await saveLiteratureQueue(runningQueue);
    try {
      const result = await sendMessage({
        type: "DOWNLOAD_LITERATURE_QUEUE",
        items: runnableItems.map(({ id, title, doi, pdfUrl, downloadUrl }) => ({ id, title, doi, pdfUrl, downloadUrl })),
        concurrency,
        userInitiated: true
      });
      const resultById = new Map(result.items.map((item) => [item.id, item]));
      const next: LiteratureQueue = {
        ...runningQueue,
        updatedAt: Date.now(),
        items: runningQueue.items.map((item) => {
          const update = resultById.get(item.id);
          return update ? { ...item, ...update } : item;
        })
      };
      await saveLiteratureQueue(next);
      setQueue(next);
    } catch (err) {
      const next = {
        ...runningQueue,
        items: runningQueue.items.map((item) => runningIds.has(item.id) ? { ...item, status: "pending" as const } : item)
      };
      await saveLiteratureQueue(next);
      setQueue(next);
      setError(toErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    if (!busy || !progress) return;
    setError("");
    const targetState = progress.state === "paused" ? "running" : "paused";
    setProgress((current) => current ? { ...current, state: targetState } : current);
    try {
      const response = progress.state === "paused"
        ? await sendMessage({ type: "RESUME_LITERATURE_DOWNLOAD" })
        : await sendMessage({ type: "PAUSE_LITERATURE_DOWNLOAD" });
      setProgress((current) => current ? { ...current, state: response.paused ? "paused" : "running" } : current);
    } catch (err) {
      setProgress((current) => current ? { ...current, state: progress.state } : current);
      setError(toErrorMessage(err));
    }
  }

  async function updateConcurrency(value: number) {
    const next = Math.max(1, Math.min(4, value));
    setConcurrency(next);
    await saveLiteratureQueuePreferences({ concurrency: next });
  }

  async function resetFailures() {
    if (!queue) return;
    const next = {
      ...queue,
      items: queue.items.map((item) => ["failed", "needs_user", "resolving"].includes(item.status)
        ? { ...item, status: item.downloadUrl || item.pdfUrl || item.doi ? "pending" as const : "needs_search" as const, error: undefined }
        : item)
    };
    await saveLiteratureQueue(next);
    setQueue(next);
  }

  async function clearQueue() {
    if (!queue || !window.confirm("清空当前文献下载队列？已下载文件不会被删除。")) return;
    await clearLiteratureQueue();
    setQueue(undefined);
    setProgress(undefined);
  }

  if (!queue) {
    return (
      <section className="literature-queue-view literature-queue-empty">
        <div className="queue-empty-mark"><Download size={22} /></div>
        <strong>导入文献清单</strong>
        <p>支持 CSV，自动识别 title、doi、pdf_url、download_url 和 decision，并按 DOI 或题名去重。</p>
        <button className="button primary" onClick={() => fileInputRef.current?.click()}><FileUp size={16} /> 选择 CSV</button>
        <input ref={fileInputRef} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
        {error ? <p className="error-text text-small">{error}</p> : null}
      </section>
    );
  }

  return (
    <section className="literature-queue-view">
      <div className="queue-heading">
        <div><span className="tool-eyebrow">文献下载队列</span><h2>{queue.sourceName}</h2><p>{queue.sourceRows} 条原始记录 · 去重后 {queue.items.length} 篇</p></div>
        <div className="queue-heading-actions">
          <button className="icon-button" title="重新导入 CSV" disabled={busy} onClick={() => fileInputRef.current?.click()}><FileUp size={15} /></button>
          <button className="icon-button danger" title="清空队列" disabled={busy} onClick={() => void clearQueue()}><Trash2 size={15} /></button>
        </div>
      </div>
      <input ref={fileInputRef} className="visually-hidden" type="file" accept=".csv,text/csv" onChange={(event) => { void importFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />

      <p className="checkin-meta muted text-small">{[
        `可处理 ${summary.actionable}`,
        summary.completed ? `完成 ${summary.completed}` : null,
        summary.needsSearch ? `待检索 ${summary.needsSearch}` : null,
        summary.needsUser + summary.failed ? `需处理 ${summary.needsUser + summary.failed}` : null
      ].filter(Boolean).join(" · ")}</p>

      <div className="queue-controls">
        <div className="input-mode-switch" role="tablist" aria-label="下载范围">
          {(["all", "include", "maybe"] as QueueScope[]).map((item) => (
            <button role="tab" aria-selected={scope === item} className={scope === item ? "active" : ""} onClick={() => setScope(item)} key={item}>
              {scopeLabel(item)} {countScope(queue.items, item)}
            </button>
          ))}
        </div>
        <div className="queue-run-settings">
          <label title="同一时间打开的解析页面数，建议 1–2">
            并行
            <select className="input" value={concurrency} disabled={busy} onChange={(event) => void updateConcurrency(Number(event.target.value))}>
              {[1, 2, 3, 4].map((value) => <option value={value} key={value}>{value}</option>)}
            </select>
          </label>
        </div>
      </div>

      {busy && progress ? (
        <div className="queue-progress" aria-live="polite">
          <div className="queue-progress-heading">
            <span className={progress.state === "paused" ? "progress-pause-dot" : "progress-spinner"} />
            <strong>{progress.state === "paused" ? "下载已暂停" : "正在解析并下载"}</strong>
            <span>{progress.completed}/{progress.total}</span>
            <button className="button secondary compact-button" onClick={() => void togglePause()}>
              {progress.state === "paused" ? <><Play size={14} /> 继续</> : <><Pause size={14} /> 暂停</>}
            </button>
          </div>
          <div className="queue-progress-metrics">
            <span>活跃 {progress.active}/{progress.concurrency}</span>
            <span>成功 {progress.succeeded}</span>
            <span>需处理 {progress.needsUser}</span>
            <span>失败 {progress.failed}</span>
          </div>
          <p title={progress.currentTitle}>{progress.currentTitle || "准备下载…"}</p>
          <div><span style={{ width: `${progress.total ? Math.round(progress.completed / progress.total * 100) : 0}%` }} /></div>
        </div>
      ) : null}

      <div className="queue-list">
        {scopedItems.slice(0, 60).map((item) => <QueueRow item={item} key={item.id} />)}
        {scopedItems.length > 60 ? <p className="queue-list-note">显示前 60 篇，共 {scopedItems.length} 篇。</p> : null}
      </div>

      <div className="queue-footer">
        <button className="button secondary" disabled={busy || summary.needsUser + summary.failed === 0} onClick={() => void resetFailures()}><RotateCcw size={15} /> 重置失败项</button>
        <button className="button secondary" disabled={busy} onClick={() => exportQueue(queue)}><Download size={15} /> 导出报告</button>
        <button className="button primary queue-start" disabled={busy || runnableItems.length === 0} onClick={() => void startDownload()}>
          <Download size={16} /> {busy ? "正在处理…" : `处理 ${runnableItems.length} 篇`}
        </button>
      </div>
      {error ? <p className="error-text text-small">{error}</p> : null}
    </section>
  );
}

function QueueRow({ item }: { item: LiteratureQueueItem }) {
  const openUrl = item.resolverUrl || (item.doi ? `https://doi.org/${item.doi}` : buildSearchUrl(item.title));
  return (
    <article className="queue-row">
      <span className={`queue-status status-${item.status}`}>{statusLabel(item.status)}</span>
      <div className="queue-row-main">
        <strong title={item.title}>{stripTags(item.title)}</strong>
        <span>{item.doi || routeLabel(item)}{item.sourceRows > 1 ? ` · 合并 ${item.sourceRows} 条` : ""}</span>
        {item.error ? <small title={item.error}>{item.error}</small> : null}
      </div>
      <a className="icon-button" href={openUrl} target="_blank" rel="noreferrer" title="打开来源或检索页面"><ExternalLink size={14} /></a>
    </article>
  );
}

function summarize(items: LiteratureQueueItem[]) {
  return {
    actionable: items.filter((item) => Boolean(item.downloadUrl || item.pdfUrl || item.doi)).length,
    completed: items.filter((item) => item.status === "completed").length,
    needsSearch: items.filter((item) => item.status === "needs_search").length,
    needsUser: items.filter((item) => item.status === "needs_user").length,
    failed: items.filter((item) => item.status === "failed").length
  };
}

function countScope(items: LiteratureQueueItem[], scope: QueueScope): number {
  return scope === "all" ? items.length : items.filter((item) => item.decision === scope).length;
}

function scopeLabel(scope: QueueScope): string {
  if (scope === "include") return "纳入";
  if (scope === "maybe") return "待定";
  return "全部";
}

function statusLabel(status: LiteratureQueueStatus): string {
  switch (status) {
    case "pending": return "等待";
    case "resolving": return "解析中";
    case "completed": return "完成";
    case "needs_search": return "待检索";
    case "needs_user": return "需处理";
    case "failed": return "失败";
  }
}

function routeLabel(item: LiteratureQueueItem): string {
  if (item.downloadUrl || item.pdfUrl) return "已有全文入口";
  return "按题名检索";
}

function buildSearchUrl(title: string): string {
  const plainTitle = stripTags(title);
  return /[\u3400-\u9fff]/u.test(plainTitle)
    ? `https://kns.cnki.net/kns8s/defaultresult/index?kw=${encodeURIComponent(plainTitle)}`
    : "https://www.webofscience.com/wos/woscc/basic-search";
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function exportQueue(queue: LiteratureQueue): void {
  const headers = ["title", "doi", "decision", "status", "pdf_path", "download_url", "pdf_url", "error"];
  const rows = queue.items.map((item) => [item.title, item.doi, item.decision, item.status, item.filename, item.downloadUrl, item.pdfUrl, item.error]);
  const csv = [headers, ...rows].map((row) => row.map((value) => escapeCsv(String(value || ""))).join(",")).join("\r\n");
  const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `Trail-literature-downloads-${new Date().toISOString().slice(0, 10)}.csv`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function escapeCsv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function isLiteratureProgress(value: unknown): value is LiteratureDownloadProgress {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "LITERATURE_DOWNLOAD_PROGRESS");
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "无法处理文献下载队列。";
}
