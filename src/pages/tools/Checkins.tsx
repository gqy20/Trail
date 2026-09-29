import { useEffect, useState } from "react";
import { CheckCircle2, ExternalLink, Play, RefreshCw } from "lucide-react";
import { sendMessage } from "../../shared/runtime";
import type { CheckinItem, CheckinState } from "../../checkin/types";
import { localClock } from "../../checkin/schedule";

export function CheckinsView() {
  const [state, setState] = useState<CheckinState>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    let alive = true;
    const refresh = () => void sendMessage({ type: "GET_CHECKIN_STATE" }).then((next) => {
      if (alive) setState(next);
    }).catch((err: unknown) => { if (alive) setError(errorText(err)); });
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && (changes["trail.checkins.v1"] || changes["trail.browserTools"])) refresh();
    };
    refresh();
    chrome.storage.onChanged.addListener(changed);
    return () => { alive = false; chrome.storage.onChanged.removeListener(changed); };
  }, []);

  async function act(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    setError("");
    try { await fn(); setState(await sendMessage({ type: "GET_CHECKIN_STATE" })); }
    catch (err) { setError(errorText(err)); }
    finally { setBusy(undefined); }
  }

  return <section className="checkins-view stack">
    <div className="view-heading"><h2>每日签到</h2><CheckCircle2 size={20} /></div>
    <p className="muted text-small">复用浏览器登录态，到点自动签到；错过的任务在浏览器下次启动后补跑，需要验证时暂停。</p>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {!state ? <p className="muted">正在读取签到工具…</p> : null}
    {state?.items.map((item) => <CheckinCard key={item.toolId} item={item} busy={busy !== undefined}
      onRun={() => void act(item.toolId, () => sendMessage({ type: "RUN_CHECKIN", toolId: item.toolId }))}
      onOpen={() => void act(item.toolId, () => sendMessage({ type: "OPEN_CHECKIN_PAGE", toolId: item.toolId }))}
      onSave={(enabled, time) => void act(item.toolId, () => sendMessage({ type: "CONFIGURE_CHECKIN", toolId: item.toolId, enabled, time }))}
    />)}
    {state?.items.length === 0 ? <div className="panel stack"><p>还没有签到工具。</p>
      <button className="button secondary" disabled={busy !== undefined} onClick={() => void act("sync", () => sendMessage({ type: "IMPORT_BUNDLED_BROWSER_TOOLS" }))}><RefreshCw size={15} /> 同步内置工具</button>
    </div> : null}
  </section>;
}

function CheckinCard({ item, busy, onRun, onOpen, onSave }: {
  item: CheckinItem; busy: boolean; onRun: () => void; onOpen: () => void;
  onSave: (enabled: boolean, time: string) => void;
}) {
  const { job } = item;
  const [time, setTime] = useState(job.time);
  useEffect(() => setTime(job.time), [job.time]);
  const today = job.lastSuccessDay === localClock(Date.now(), item.timezone).day;
  const running = job.status === "running";
  const badge = today ? "已签" : running ? "签到中" : job.status === "needs_user" ? "需处理" : job.status === "failed" ? "失败" : "待签";
  const account = job.result?.data.account?.[0];
  const meta = [
    account?.points !== undefined ? `积分 ${account.points}` : null,
    account?.days !== undefined ? `连签 ${account.days} 天` : null,
    account?.days_left !== undefined ? `剩余 ${account.days_left} 天` : null,
    formatRunTime(job.lastAttemptAt)
  ].filter(Boolean).join(" · ");

  return <article className="panel checkin-card stack">
    <div className="checkin-head">
      <a className="checkin-title" href={item.entryUrl} target="_blank" rel="noreferrer" title={safeHost(item.entryUrl)}>{item.name.replace(/每日签到$/, "")}</a>
      <span className={`mini-badge ${today ? "run-completed" : ""}`}>{badge}</span>
    </div>
    {meta ? <p className="checkin-meta muted text-small">{meta}</p> : null}
    {job.status === "needs_user" || job.status === "failed" ? (job.message ? <p className="error-text text-small">{job.message}</p> : null) : null}
    <div className="checkin-schedule">
      <label><input type="checkbox" checked={job.enabled} disabled={busy || running} onChange={(e) => onSave(e.target.checked, time)} /> 自动</label>
      <input type="time" aria-label={`${item.name}签到时间`} value={time} disabled={busy || running} onChange={(e) => setTime(e.target.value)} />
      {time !== job.time ? <button className="button secondary" disabled={busy || !time} onClick={() => onSave(job.enabled, time)}>保存</button> : null}
    </div>
    <div className="checkin-actions">
      <button className="button primary" disabled={busy || running || today} onClick={onRun}><Play size={15} />{running ? "签到中…" : job.status === "needs_user" ? "重试" : "签到"}</button>
      <button className="button secondary" disabled={busy} onClick={onOpen}><ExternalLink size={15} />打开</button>
    </div>
  </article>;
}

function formatRunTime(at: number | undefined): string {
  if (!at) return "";
  const date = new Date(at);
  const sameDay = date.toDateString() === new Date().toDateString();
  return sameDay
    ? date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function safeHost(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请重试。"; }
