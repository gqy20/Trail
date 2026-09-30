import { useEffect, useRef, useState } from "react";
import { ChevronRight, Clock, FileDown, FileUp, History, Plus, X } from "lucide-react";
import { exportFollowsCsv } from "../../collector/follows";
import { TaskStatus, useTransientNotice } from "./feedback";
import { sendMessage } from "../../shared/runtime";
import type { CollectorItem, FollowEntry } from "../../collector/types";

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
      <button className="button action collector-run" disabled={busy || running} onClick={() => void act(() => sendMessage({ type: "RUN_COLLECTOR_NOW", toolId }).then(() => "已启动"), "collect")}><Clock size={14} />{running ? "采集中" : "采集"}</button>
      {feedbackArea !== "accounts" && notice ? <span className="muted text-small" role="status">{notice}</span> : null}
      <input ref={fileInputRef} className="visually-hidden" type="file" accept=".txt,.csv,text/csv,text/plain" onChange={async (event) => {
        const file = event.target.files?.[0];
        event.currentTarget.value = "";
        if (!file) return;
        await act(() => file.text().then((text) => sendMessage({ type: "IMPORT_FOLLOWS", platform, text })).then((result) => `新增 ${result.added}，共 ${result.total} 个。`));
      }} />
    </div>

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

function errorText(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请重试。"; }
