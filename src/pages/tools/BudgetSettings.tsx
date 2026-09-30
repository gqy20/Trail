import { useEffect, useState } from "react";
import { useTransientNotice } from "./feedback";
import { sendMessage } from "../../shared/runtime";
import type { BudgetConfig, BudgetState } from "../../collector/budget";

export function BudgetSettings() {
  const [states, setStates] = useState<BudgetState[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const refresh = () => void sendMessage({ type: "GET_ACTIVITY_BUDGET" }).then((next) => { if (alive) setStates(next); }).catch((err: unknown) => { if (alive) setError(err instanceof Error ? err.message : "读取预算失败。"); });
    refresh();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === "local" && ["trail.activityBudget.v2", "trail.activityBudgetConfig.v1", "trail.browserTools"].some((key) => key in changes)) refresh(); };
    chrome.storage.onChanged.addListener(changed);
    const timer = window.setInterval(refresh, 60_000);
    return () => { alive = false; window.clearInterval(timer); chrome.storage.onChanged.removeListener(changed); };
  }, []);
  return <details className="settings-section budget-settings stack"><summary>采集预算 · 每平台默认 6 小时浏览量</summary>
    <p className="muted text-small">按平台独立计算近 24 小时访问尝试：主页 2 分钟、详情 1 分钟。此为浏览量估算，并非实际运行时间；额度逐笔恢复，暂停任务需手动继续。</p>
    {error ? <p role="alert" className="error-text text-small">{error}</p> : null}
    {states.map((state) => <BudgetRow key={state.platform} state={state} />)}
    {!states.length ? <p className="muted text-small">安装账号采集工具后可配置对应平台预算。</p> : null}
  </details>;
}

function BudgetRow({ state }: { state: BudgetState }) {
  const [draft, setDraft] = useState<BudgetConfig>(state.config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useTransientNotice();
  useEffect(() => { setDraft(state.config); }, [state.config.hours, state.config.profileIntervalSeconds, state.config.detailIntervalSeconds, state.config.profileLimit, state.config.detailLimit]);
  const dirty = (["hours", "profileIntervalSeconds", "detailIntervalSeconds", "profileLimit", "detailLimit"] as const).some((key) => (draft[key] ?? 0) !== (state.config[key] ?? 0));
  const label = state.platform === "twitter" ? "X" : state.platform === "xhs" ? "小红书" : state.platform;
  return <section className="budget-row stack"><div className="section-heading"><strong>{label}</strong><span className="muted text-small">{state.used} / {state.limit} 分钟 · 主页 {state.profile}{state.config.profileLimit ? ` / ${state.config.profileLimit}` : ""} 次 · 详情 {state.detail}{state.config.detailLimit ? ` / ${state.config.detailLimit}` : ""} 次</span></div>
    <div className="budget-config-row">
      <label>浏览量<input className="input" aria-label={`${label}浏览量预算小时`} type="number" min={1} max={24} step={1} value={draft.hours} disabled={busy} onChange={(e) => { setNotice(""); setDraft({ ...draft, hours: Number(e.target.value) }); }} />小时</label>
      <label>主页间隔<input className="input" aria-label={`${label}主页间隔秒`} type="number" min={1} max={3600} value={draft.profileIntervalSeconds} disabled={busy} onChange={(e) => { setNotice(""); setDraft({ ...draft, profileIntervalSeconds: Number(e.target.value) }); }} />秒</label>
      <label>详情间隔<input className="input" aria-label={`${label}详情间隔秒`} type="number" min={1} max={3600} value={draft.detailIntervalSeconds} disabled={busy} onChange={(e) => { setNotice(""); setDraft({ ...draft, detailIntervalSeconds: Number(e.target.value) }); }} />秒</label>
      {(["profile", "detail"] as const).map((kind) => <label key={kind}>{kind === "profile" ? "主页" : "详情"}上限<input className="input" aria-label={`${label}${kind === "profile" ? "主页" : "详情"}次数上限`} type="number" min={0} max={10000} value={draft[`${kind}Limit`] ?? 0} disabled={busy} onChange={(e) => { setNotice(""); setDraft({ ...draft, [`${kind}Limit`]: Number(e.target.value) }); }} />次</label>)}
      <button className="button secondary" disabled={busy} onClick={async () => {
        setBusy(true); setError(""); setNotice("");
        try { await sendMessage({ type: "SAVE_ACTIVITY_BUDGET", platform: state.platform, config: draft }); setNotice("已保存"); }
        catch (err) { setError(err instanceof Error ? err.message : "保存失败。"); }
        finally { setBusy(false); }
      }}>保存预算</button>
      {dirty ? <span className="muted text-small">未保存</span> : null}
      {notice ? <span className="muted text-small" role="status">{notice}</span> : null}
    </div>
    <p className="muted text-small">次数上限为 0 时仅按浏览量限制；次数与浏览量任一达到上限即暂停。修改仅影响当前平台，已用额度保留。</p>
    {state.nextAvailableAt ? <p className="muted text-small">最早 {new Date(state.nextAvailableAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} 可再次访问主页；不会自动继续。</p> : null}
    {error ? <p role="alert" className="error-text text-small">{error}</p> : null}
  </section>;
}
