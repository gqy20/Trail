import { useEffect, useRef, useState } from "react";
import { ChevronRight, Clock, FileDown, FileUp, History, Pause, Play, Plus, Square, X } from "lucide-react";
import { exportFollowsCsv } from "../../collector/follows";
import { TaskStatus, useTransientNotice } from "./feedback";
import { sendMessage } from "../../shared/runtime";
import type { CollectorItem, FollowEntry } from "../../collector/types";
import type { BatchRunState } from "../../background/runControl";

/** 批量运行状态在 session 存储中的键（与 runControl 的 STATE_KEY 对应）。 */
const batchRunKey = (toolId: string) => `trail.browserToolBatchRun.v1.${toolId}`;

export function CollectorPanel({ toolId, platform, name }: { toolId: string; platform: string; name: string }) {
  const [item, setItem] = useState<CollectorItem>();
  const [follows, setFollows] = useState<FollowEntry[]>();
  const [handle, setHandle] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useTransientNotice();
  const [feedbackArea, setFeedbackArea] = useState<"accounts" | "collect" | "settings">("collect");
  const [busy, setBusy] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [runState, setRunState] = useState<BatchRunState | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    const refresh = () => void Promise.all([
      sendMessage({ type: "GET_COLLECTOR_STATE" }),
      sendMessage({ type: "GET_FOLLOWS", platform })
    ]).then(([state, list]) => {
      if (!alive) return;
      setItem(state.items.find((entry) => entry.toolId === toolId));
      setFollows(list);
    }).catch((err: unknown) => { if (alive) setError(errorText(err)); });
    refresh();
    const changed = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && (_changes["trail.collectors.v1"] || _changes["trail.follows.v1"])) refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => { alive = false; chrome.storage.onChanged.removeListener(changed); };
  }, [toolId, platform]);

  // 批量运行进度：跟随 session 存储中的心跳与游标推进实时更新。
  useEffect(() => {
    let alive = true;
    const load = () => void sendMessage({ type: "GET_BATCH_RUN_STATE", toolId })
      .then((next) => { if (alive) setRunState(next); })
      .catch(() => undefined);
    load();
    const changed = (_changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "session" && _changes[batchRunKey(toolId)]) load();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => { alive = false; chrome.storage.onChanged.removeListener(changed); };
  }, [toolId]);

  async function act(fn: () => Promise<string | undefined>, area: "accounts" | "collect" | "settings" = "accounts") {
    setFeedbackArea(area);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await fn();
      if (message) setNotice(message);
      const [state, list] = await Promise.all([
        sendMessage({ type: "GET_COLLECTOR_STATE" }),
        sendMessage({ type: "GET_FOLLOWS", platform })
      ]);
      setItem(state.items.find((entry) => entry.toolId === toolId));
      setFollows(list);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const job = item?.job;
  const interval = job?.intervalHours ?? 4;
  const running = job?.status === "running";
  const selectedHandles = selected.filter((handle) => follows?.some((entry) => entry.handle === handle));
  const needsAttention = job?.status === "needs_user" || job?.status === "failed";

  const runTotal = runState?.keywords.length ?? 0;
  const runDone = runState?.completedKeywords ?? 0;
  const runRecords = runState ? Object.values(runState.data).reduce((sum, list) => sum + list.length, 0) : 0;
  const runActive = runState?.status === "running" || runState?.status === "paused";
  const currentKeyword = runState && runState.nextIndex < runState.keywords.length ? runState.keywords[runState.nextIndex] : undefined;
  const currentName = currentKeyword
    ? follows?.find((entry) => entry.handle === currentKeyword)?.displayName || (platform === "twitter" ? `@${currentKeyword}` : currentKeyword)
    : undefined;

  /** 暂停/停止/继续不经过 act（不锁面板）：响应要么即时，要么由进度行与任务状态自行呈现。 */
  function controlRun(action: "pause" | "stop" | "resume") {
    setFeedbackArea("collect");
    setError("");
    if (action === "pause") {
      void sendMessage({ type: "PAUSE_BATCH_RUN", toolId })
        .then(() => setNotice("已请求暂停，当前账号完成后挂起。"))
        .catch((err: unknown) => setError(errorText(err)));
      return;
    }
    if (action === "stop") {
      if (!window.confirm("停止采集？已完成账号的记录会保留并进入结果。")) return;
      void sendMessage({ type: "STOP_BATCH_RUN", toolId })
        .then(() => setNotice("已请求停止。"))
        .catch((err: unknown) => setError(errorText(err)));
      return;
    }
    // 继续会运行到本轮结束（可能数分钟），不等待结果；进度行与任务状态会实时反映。
    setNotice("已继续采集。");
    void sendMessage({ type: "RESUME_BATCH_RUN", toolId, userInitiated: true, asCollector: true })
      .catch((err: unknown) => { setError(errorText(err)); setNotice(""); });
  }

  function exportAccounts() {
    const url = URL.createObjectURL(new Blob(["\uFEFF", exportFollowsCsv(follows || [])], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${platform}-accounts.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return <div className="panel collector-panel stack">
    <div className="collector-head">
      <div className="collector-title-row"><strong>{name}</strong>
        {running || needsAttention ? <TaskStatus tone={running ? "running" : job?.status === "failed" ? "failed" : "attention"}>{running ? "采集中" : job?.status === "failed" ? "失败" : "需处理"}</TaskStatus> : null}
        {job?.lastAttemptAt || (!needsAttention && job?.message) ? <span className="muted text-small">{job.lastAttemptAt ? `上次采集 ${formatRunTime(job.lastAttemptAt)}` : ""}{!needsAttention && job.message ? `${job.lastAttemptAt ? " · " : ""}${job.message}` : ""}</span> : null}
      </div>
      <div className="collector-schedule" title="到点自动采集">
        <label>
        <input type="checkbox" checked={job?.enabled === true} disabled={busy || running}
          onChange={(e) => void act(() => sendMessage({ type: "CONFIGURE_COLLECTOR", toolId, enabled: e.target.checked, intervalHours: interval }).then(() => "已保存"), "settings")} />
        自动采集</label><span>每</span>
        <input className="collector-interval" aria-label={`${name}采集间隔`} type="number" min={1} max={48} value={interval} disabled={busy || running}
          onChange={(e) => void act(() => sendMessage({ type: "CONFIGURE_COLLECTOR", toolId, enabled: job?.enabled === true, intervalHours: Number(e.target.value) }).then(() => "已保存"), "settings")} />
        <span>小时</span>
      </div>
      <button className="button action collector-run" disabled={busy || running} onClick={() => {
        setFeedbackArea("collect");
        setError("");
        setNotice("已启动。");
        void sendMessage({ type: "RUN_COLLECTOR_NOW", toolId }).catch((err: unknown) => { setError(errorText(err)); setNotice(""); });
      }}><Clock size={14} />{running ? "采集中" : "采集"}</button>
      {feedbackArea !== "accounts" && notice ? <span className="muted text-small" role="status">{notice}</span> : null}
      <input ref={fileInputRef} className="visually-hidden" type="file" accept=".txt,.csv,text/csv,text/plain" onChange={async (event) => {
        const file = event.target.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        await act(() => file.text().then((text) => sendMessage({ type: "IMPORT_FOLLOWS", platform, text })).then((result) => result.added === result.total ? `导入 ${result.total} 个账号。` : `新增 ${result.added}，共 ${result.total} 个。`));
      }} />
    </div>

    {runState && runActive ? <div className="collector-progress" data-status={runState.status}>
      <div className="collector-progress-meta">
        <strong className="collector-progress-label">{progressLabel(runState)}</strong>
        <span className="muted text-small">
          {runState.status === "running"
            ? `第 ${Math.min(runDone + 1, runTotal)}/${runTotal} 个${currentName ? `：${currentName}` : ""} · 已采 ${runRecords} 条`
            : `第 ${Math.min(runDone + 1, runTotal)}/${runTotal} 个${currentName ? `：${currentName}` : ""} · 已采 ${runRecords} 条，点继续从中断处接着采`}
        </span>
      </div>
      <div className="collector-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={runTotal} aria-valuenow={runDone} aria-label={`${name}采集进度`}>
        <div className="collector-progress-fill" style={{ width: `${runTotal > 0 ? Math.round((runDone / runTotal) * 100) : 0}%` }} />
      </div>
      <div className="collector-progress-actions">
        {runState.status === "running"
          ? <button className="button secondary compact-button" disabled={Boolean(runState.pendingControl)} onClick={() => controlRun("pause")}><Pause size={13} />暂停</button>
          : <button className="button secondary compact-button" onClick={() => controlRun("resume")}><Play size={13} />继续</button>}
        <button className="button secondary compact-button account-delete" disabled={Boolean(runState.pendingControl)} onClick={() => controlRun("stop")}><Square size={12} />停止</button>
      </div>
    </div> : null}

    {error && feedbackArea !== "accounts" ? <p role="alert" className="error-text text-small">{error}</p> : null}
    {needsAttention && job?.message ? <details className="task-feedback-details"><summary>查看需处理原因</summary><p className="error-text text-small">{job.message}</p></details> : null}
    <div className="account-manager" data-open={accountsOpen}>
      <div className="account-header">
      <button className="account-disclosure" aria-expanded={accountsOpen} aria-controls={`accounts-${toolId}`} onClick={() => setAccountsOpen((open) => !open)}><ChevronRight size={13} />账号名单 · {follows?.length ?? 0} 个</button>
      <div className="account-toolbar">
<button className="button secondary compact-button" title="合并导入账号名单（TXT / CSV）" disabled={busy} onClick={() => fileInputRef.current?.click()}><FileUp size={15} />导入账号</button>

        {feedbackArea === "accounts" && notice ? <span className="muted text-small" role="status">{notice}</span> : null}
        <button className="button secondary compact-button" disabled={!follows?.length || busy} onClick={exportAccounts}><FileDown size={14} />导出账号</button>
        {!selecting ? <button className="button secondary compact-button" disabled={!follows?.length || busy || running} onClick={() => { setSelected([]); setSelecting(true); setAccountsOpen(true); }}>批量删除</button> : <>
          <label><input type="checkbox" aria-label={`${name}全选账号`} checked={Boolean(follows?.length) && selectedHandles.length === follows?.length} disabled={busy || running} onChange={(e) => setSelected(e.target.checked ? (follows || []).map((entry) => entry.handle) : [])} />全选</label>
          <button className="button secondary compact-button account-delete" disabled={!selectedHandles.length || busy || running} onClick={() => {
            if (!window.confirm(`删除已选的 ${selectedHandles.length} 个账号？`)) return;
            void act(async () => {
              await sendMessage({ type: "REMOVE_FOLLOWS", platform, handles: selectedHandles });
              setSelected([]);
              setSelecting(false);
              return undefined;
            });
          }}>删除已选（{selectedHandles.length}）</button>
          <button className="button secondary compact-button" disabled={busy} onClick={() => { setSelecting(false); setSelected([]); }}>取消</button>
        </>}
      </div>
      </div>
      {error && feedbackArea === "accounts" ? <p role="alert" className="error-text text-small">{error}</p> : null}
      <div id={`accounts-${toolId}`} hidden={!accountsOpen}>
    <div className="collector-chips">
      {(follows || []).map((entry) => (
        <span className="collector-chip" key={`${entry.platform}-${entry.handle}`} title={entry.displayName || entry.handle}>
          {selecting ? <input type="checkbox" aria-label={`选择 ${entry.handle}`} checked={selectedHandles.includes(entry.handle)} disabled={busy || running} onChange={(e) => setSelected((current) => e.target.checked ? [...current, entry.handle] : current.filter((handle) => handle !== entry.handle))} /> : null}
          <span title={entry.handle}>{entry.displayName || `@${entry.handle}`}</span>
          {!selecting ? <>
            <button aria-label={`回填 ${entry.handle}`} title="回填历史内容" disabled={busy} onClick={() => {
              const input = window.prompt(`回填 @${entry.handle} 到多少天前？（1-3650，输 0 取消）`, "30");
              if (!input) return;
              const days = Number(input);
              if (!Number.isInteger(days) || days < 1 || days > 3650) return;
              void act(() => sendMessage({ type: "BACKFILL_ACCOUNT", platform: entry.platform, handle: entry.handle, days }).then((r) => r.message || "回填已触发。"));
            }}><History size={11} /></button>
            <button aria-label={`移除 ${entry.handle}`} disabled={busy} onClick={() => void act(() => sendMessage({ type: "REMOVE_FOLLOW", platform: entry.platform, handle: entry.handle }).then(() => undefined))}><X size={11} /></button>
          </> : null}
        </span>
      ))}
      {follows && follows.length === 0 ? <span className="muted text-small">还没有账号</span> : null}
    </div>

    <div className="collector-add">
      <input className="input collector-add-input" aria-label={`${name}添加账号`} placeholder={`@${platform === "twitter" ? "handle" : "账号"}`} value={handle} disabled={busy} onChange={(e) => setHandle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && handle.trim()) void act(async () => {
            await sendMessage({ type: "ADD_FOLLOW", platform, handle: handle.trim() });
            setHandle("");
            return undefined;
          });
        }} />
      <button className="icon-button" title="添加" disabled={busy || !handle.trim()} onClick={() => void act(async () => {
        const value = handle.trim();
        await sendMessage({ type: "ADD_FOLLOW", platform, handle: value });
        setHandle("");
        return undefined;
      })}><Plus size={15} /></button>
    </div>
      </div>
    </div>
  </div>;
}

function formatRunTime(at: number): string {
  const date = new Date(at);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 暂停/停止请求已受理但还没到边界时，如实显示“正在收尾”。 */
function progressLabel(runState: BatchRunState): string {
  if (runState.pendingControl === "stop") return "正在停止…";
  if (runState.pendingControl === "pause") return "正在暂停…";
  return runState.status === "running" ? "正在采集" : "已暂停";
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请重试。"; }
