import { useEffect, useRef, useState } from "react";
import { Clock, Download, Plus, X } from "lucide-react";
import { sendMessage } from "../../shared/runtime";
import type { CollectorItem, FollowEntry } from "../../collector/types";

export function CollectorPanel({ toolId, platform, name }: { toolId: string; platform: string; name: string }) {
  const [item, setItem] = useState<CollectorItem>();
  const [follows, setFollows] = useState<FollowEntry[]>();
  const [handle, setHandle] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
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

  async function act(fn: () => Promise<string | undefined>) {
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
  return <div className="panel collector-panel stack">
    <div className="section-heading">
      <strong>{name}</strong>
      <label className="feed-config-toggle">
        <input
          type="checkbox"
          checked={job?.enabled === true}
          disabled={busy || job?.status === "running"}
          onChange={(e) => void act(() => sendMessage({ type: "CONFIGURE_COLLECTOR", toolId, enabled: e.target.checked, intervalHours: interval }).then(() => e.target.checked ? "已开启定时采集。" : "已关闭定时采集。"))}
        />
        <span>每 <input
          className="collector-interval"
          type="number"
          min={1}
          max={48}
          value={interval}
          disabled={busy || job?.status === "running"}
          onChange={(e) => void act(() => sendMessage({ type: "CONFIGURE_COLLECTOR", toolId, enabled: job?.enabled === true, intervalHours: Number(e.target.value) }).then(() => `间隔已设为 ${Math.min(48, Math.max(1, Math.round(Number(e.target.value) || 4)))} 小时。`))}
        /> 小时</span>
      </label>
    </div>

    {error ? <p role="alert" className="error-text text-small">{error}</p> : null}
    {notice ? <p className="text-small">{notice}</p> : null}
    {job?.message ? <p className={job.status === "needs_user" || job.status === "failed" ? "error-text text-small" : "muted text-small"}>{job.message}</p> : null}
    {job?.lastAttemptAt ? <p className="muted text-small">{formatRunTime(job.lastAttemptAt)}{job.approvedHash ? "" : " · 开启后按设定间隔自动采集"}</p> : null}

    <div className="collector-follows">
      <div className="collector-follows-head">
        <span className="muted text-small">关注 {follows?.length ?? "…"}</span>
        <div className="collector-follows-actions">
          <button className="button secondary" disabled={busy} onClick={() => void act(() => sendMessage({ type: "RUN_COLLECTOR_NOW", toolId }).then(() => "采集已启动，进度见运行页。"))}><Clock size={15} />采集</button>
          <button className="button secondary" title="导入 txt/csv（handle,priority,name 或每行一个账号）" disabled={busy} onClick={() => fileInputRef.current?.click()}><Download size={15} />导入</button>
          <input ref={fileInputRef} className="visually-hidden" type="file" accept=".txt,.csv,text/csv,text/plain" onChange={async (event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            await act(() => file.text().then((text) => sendMessage({ type: "IMPORT_FOLLOWS", platform, text })).then((result) => `导入完成：新增 ${result.added}、更新 ${result.updated}，共 ${result.total} 个。`));
          }} />
        </div>
      </div>
      <div className="collector-chips">
        {(follows || []).map((entry) => (
          <span className="collector-chip" key={`${entry.platform}-${entry.handle}`} title={entry.displayName || entry.handle}>
            @{entry.handle}
            <button aria-label={`移除 ${entry.handle}`} disabled={busy} onClick={() => void act(() => sendMessage({ type: "REMOVE_FOLLOW", platform: entry.platform, handle: entry.handle }).then(() => undefined))}><X size={12} /></button>
          </span>
        ))}
        {follows && follows.length === 0 ? <span className="muted text-small">还没有账号，导入名单或逐个添加。</span> : null}
      </div>
      <div className="collector-add">
        <input className="input" placeholder={`@${platform === "twitter" ? "handle" : "账号"}`} value={handle} disabled={busy} onChange={(e) => setHandle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && handle.trim()) void act(async () => {
              await sendMessage({ type: "ADD_FOLLOW", platform, handle: handle.trim() });
              setHandle("");
              return `已添加 @${handle.trim().replace(/^@/, "")}。`;
            });
          }} />
        <button className="button secondary" disabled={busy || !handle.trim()} onClick={() => void act(async () => {
          const value = handle.trim();
          await sendMessage({ type: "ADD_FOLLOW", platform, handle: value });
          setHandle("");
          return `已添加 @${value.replace(/^@/, "")}。`;
        })}><Plus size={15} />添加</button>
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
