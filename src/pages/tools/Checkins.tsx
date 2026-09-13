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
    <p className="muted text-small">在网站登录一次，Trail 会复用当前浏览器的登录状态。自动签到按设定时间后执行，浏览器关闭期间的任务在下次启动后补跑。</p>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {!state ? <p className="muted">正在读取签到工具…</p> : null}
    {state?.items.map((item) => <CheckinCard key={item.toolId} item={item} busy={busy !== undefined}
      onRun={() => void act(item.toolId, () => sendMessage({ type: "RUN_CHECKIN", toolId: item.toolId }))}
      onOpen={() => void act(item.toolId, () => sendMessage({ type: "OPEN_CHECKIN_PAGE", toolId: item.toolId }))}
      onSave={(enabled, time) => void act(item.toolId, () => sendMessage({ type: "CONFIGURE_CHECKIN", toolId: item.toolId, enabled, time }))}
    />)}
    {state?.items.length === 0 ? <div className="panel stack"><p>还没有签到工具，先同步内置工具库。</p>
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
  const status = today ? "今日已完成" : ({ idle: "待签到", running: "正在签到", success: "待签到", already_done: "待签到", needs_user: "需要处理", failed: "执行失败" }[job.status]);
  const account = job.result?.data.account?.[0];
  return <article className="panel checkin-card stack">
    <div className="view-heading"><h3>{item.name}</h3><span className={`mini-badge ${today ? "run-completed" : ""}`}>{status}</span></div>
    <div className="checkin-domain muted text-small">{new URL(item.entryUrl).hostname}</div>
    {account ? <dl className="checkin-stats">
      {account.points !== undefined ? <div><dt>积分</dt><dd>{String(account.points)}</dd></div> : null}
      {account.days !== undefined ? <div><dt>连续签到</dt><dd>{String(account.days)} 天</dd></div> : null}
      {account.days_left !== undefined ? <div><dt>剩余时间</dt><dd>{String(account.days_left)} 天</dd></div> : null}
    </dl> : null}
    {job.message ? <p className={job.status === "needs_user" || job.status === "failed" ? "error-text text-small" : "muted text-small"}>{job.message}</p> : null}
    {job.lastAttemptAt ? <p className="muted text-small">最近运行：{new Date(job.lastAttemptAt).toLocaleString("zh-CN")}</p> : null}
    <div className="checkin-schedule">
      <label><input type="checkbox" checked={job.enabled} disabled={busy || running} onChange={(e) => onSave(e.target.checked, time)} /> 每日自动签到</label>
      <label className="checkin-time">时间 <input type="time" aria-label={`${item.name}签到时间`} value={time} disabled={busy || running} onChange={(e) => setTime(e.target.value)} /></label>
      {time !== job.time ? <button className="button secondary" disabled={busy || !time} onClick={() => onSave(job.enabled, time)}>保存</button> : null}
    </div>
    <p className="muted text-small">{item.timezone} · 约 5 分钟内触发 · 需要登录或验证时暂停</p>
    <div className="checkin-actions">
      <button className="button primary" disabled={busy || running || today} onClick={onRun}><Play size={15} />{running ? "正在签到…" : job.status === "needs_user" ? "已处理，重试" : "立即签到"}</button>
      <button className="button secondary" disabled={busy} onClick={onOpen}><ExternalLink size={15} />打开网站</button>
    </div>
  </article>;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请重试。"; }
