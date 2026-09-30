import { useEffect, useMemo, useState } from "react";
import { Eraser, FileDown } from "lucide-react";
import { sendMessage } from "../../shared/runtime";
import { formatLogEntriesText, LOG_STORE_KEY, type LogEntry, type LogLevel } from "../../logging/logger";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_LABEL: Record<LogLevel, string> = { debug: "调试", info: "信息", warn: "警告", error: "错误" };

export function LogsView() {
  const [entries, setEntries] = useState<LogEntry[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [minLevel, setMinLevel] = useState<"all" | LogLevel>("all");
  const [scope, setScope] = useState("all");
  const [platform, setPlatform] = useState("all");
  const [format, setFormat] = useState("json");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let alive = true;
    const refresh = () => void sendMessage({ type: "GET_TRAIL_LOGS" }).then((next) => {
      if (alive) setEntries(next);
    }).catch((err: unknown) => { if (alive) setError(errorText(err)); });
    refresh();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes[LOG_STORE_KEY]) refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => { alive = false; chrome.storage.onChanged.removeListener(changed); };
  }, []);

  const scopes = useMemo(() => [...new Set((entries || []).map((entry) => entry.scope))], [entries]);
  const platforms = useMemo(() => [...new Set((entries || []).map((entry) => entry.data?.platform).filter((item): item is string => typeof item === "string"))], [entries]);
  const platformName = (value: string) => value === "twitter" ? "X" : value === "xhs" ? "小红书" : value;
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return (entries || [])
      .filter((entry) => minLevel === "all" || LEVEL_WEIGHT[entry.level] >= LEVEL_WEIGHT[minLevel])
      .filter((entry) => platform === "all" || entry.data?.platform === platform)
      .filter((entry) => scope === "all" || entry.scope === scope)
      .filter((entry) => !keyword
        || entry.message.toLowerCase().includes(keyword)
        || entry.event.toLowerCase().includes(keyword)
        || JSON.stringify(entry.data || {}).toLowerCase().includes(keyword))
      .reverse();
  }, [entries, minLevel, scope, platform, search]);

  const observations = filtered.filter((entry) => ["activity.result", "activity.failed", "detail.result", "detail.blocked", "fetch.rateLimited", "fetch.auth"].includes(entry.event));
  const abnormal = observations.filter((entry) => entry.level === "warn" || entry.level === "error").length;

  async function clearLogs() {
    if (!window.confirm("清空全部运行日志？此操作不可撤销。")) return;
    setBusy(true);
    try {
      await sendMessage({ type: "CLEAR_TRAIL_LOGS" });
      setEntries(await sendMessage({ type: "GET_TRAIL_LOGS" }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  function exportLogs() {
    const chronological = filtered.slice().reverse();
    const text = format === "json" ? JSON.stringify({ exportedAt: new Date().toISOString(), filters: { minLevel, scope, platform, search }, entries: chronological }, null, 2) : formatLogEntriesText(chronological);
    const blob = new Blob([text], { type: format === "json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `trail-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.${format === "json" ? "json" : "txt"}`;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    window.setTimeout(() => anchor.remove(), 1_000);
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return <section className="logs-view stack">
    <div className="view-heading inline-view-heading"><h1>运行日志</h1><p className="muted text-small">保留最近 5000 条日志，敏感字段已脱敏。</p></div>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    <div className="logs-toolbar">
      <select className="input" aria-label="日志级别" value={minLevel} onChange={(e) => setMinLevel(e.target.value as "all" | LogLevel)}>
        <option value="all">全部级别</option>
        <option value="info">信息及以上</option>
        <option value="warn">警告及以上</option>
        <option value="error">仅错误</option>
      </select>
      <select className="input" aria-label="日志区域" value={scope} onChange={(e) => setScope(e.target.value)}>
        <option value="all">全部区域</option>
        {scopes.map((item) => <option key={item} value={item}>{item}</option>)}
      </select>
      <select className="input" aria-label="日志平台" value={platform} onChange={(e) => setPlatform(e.target.value)}><option value="all">全部平台</option>{platforms.map((item) => <option key={item} value={item}>{platformName(item)}</option>)}</select>
      <select className="input" aria-label="日志导出格式" value={format} onChange={(e) => setFormat(e.target.value)}><option value="json">JSON</option><option value="text">文本</option></select>
      <input className="input logs-search" aria-label="搜索日志" placeholder="搜索日志" value={search} onChange={(e) => setSearch(e.target.value)} />
      <button className="button secondary" disabled={busy || filtered.length === 0} onClick={exportLogs}><FileDown size={15} />导出</button>
      <button className="button secondary" disabled={busy || !entries?.length} onClick={() => void clearLogs()}><Eraser size={15} />清空</button>
    </div>
    <p className="muted text-small">{filtered.length === entries?.length ? `${filtered.length} 条` : `匹配 ${filtered.length} / ${entries?.length ?? 0} 条`} · 最新在前</p>
    {observations.length ? <p className="muted text-small">当前筛选：访问结果 {observations.filter((entry) => entry.event !== "fetch.rateLimited" && entry.event !== "fetch.auth").length} 条 · 异常事件 {abnormal} 条（同一次访问可有多条） · 429 限流 {filtered.filter((entry) => entry.event === "fetch.rateLimited").length} 次。展开查看当时配置；验证或拦截不等于封号。</p> : null}
    <div className="logs-list">
      {filtered.map((entry, index) => <details className={`log-entry log-${entry.level}`} key={`${entry.ts}-${entry.event}-${index}`}>
        <summary>
          <time title={new Date(entry.ts).toLocaleString("zh-CN", { hour12: false })}>{new Date(entry.ts).toLocaleTimeString("zh-CN", { hour12: false })}</time>
          <span className={`log-level log-level-${entry.level}`}>{LEVEL_LABEL[entry.level]}</span>
          <span className="log-scope">{typeof entry.data?.platform === "string" ? platformName(entry.data.platform) : entry.scope}</span>
          <span className="log-message">{entry.message}</span>
          <span className="log-expand" aria-hidden="true">›</span>
        </summary>
        <code className="log-event">{entry.event}</code>
        {entry.data ? <pre>{JSON.stringify(entry.data, null, 2)}</pre> : null}
      </details>)}
      {entries && filtered.length === 0 ? <p className="muted logs-empty">没有匹配的日志。</p> : null}
      {!entries ? <p className="muted">正在读取日志…</p> : null}
    </div>
  </section>;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请重试。"; }
