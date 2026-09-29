import { useEffect, useMemo, useState } from "react";
import { Eraser, FileDown, ScrollText } from "lucide-react";
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
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return (entries || [])
      .filter((entry) => minLevel === "all" || LEVEL_WEIGHT[entry.level] >= LEVEL_WEIGHT[minLevel])
      .filter((entry) => scope === "all" || entry.scope === scope)
      .filter((entry) => !keyword
        || entry.message.toLowerCase().includes(keyword)
        || entry.event.toLowerCase().includes(keyword)
        || JSON.stringify(entry.data || {}).toLowerCase().includes(keyword))
      .reverse();
  }, [entries, minLevel, scope, search]);

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
    const text = formatLogEntriesText(filtered.slice().reverse());
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `trail-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.txt`;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    window.setTimeout(() => anchor.remove(), 1_000);
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return <section className="logs-view stack">
    <div className="view-heading"><h2>运行日志</h2><ScrollText size={20} /></div>
    <p className="muted text-small">
      后台关键路径的结构化日志（批量运行、GraphQL 请求、订阅源发布），保留最新 600 条。
      敏感字段（token、cookie 等）写入前已脱敏；导出的文本可直接用于问题反馈。
    </p>
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
      <input className="input logs-search" aria-label="搜索日志" placeholder="搜索事件、消息或字段…" value={search} onChange={(e) => setSearch(e.target.value)} />
      <button className="button secondary" disabled={busy || filtered.length === 0} onClick={exportLogs}><FileDown size={15} />导出</button>
      <button className="button secondary" disabled={busy || !entries?.length} onClick={() => void clearLogs()}><Eraser size={15} />清空</button>
    </div>
    <p className="muted text-small">{filtered.length} / {entries?.length ?? 0} 条，最新在前</p>
    <div className="logs-list">
      {filtered.map((entry) => <article className={`log-entry log-${entry.level}`} key={`${entry.ts}-${entry.event}`}>
        <header>
          <span className={`log-level log-level-${entry.level}`}>{LEVEL_LABEL[entry.level]}</span>
          <span className="log-scope">{entry.scope}</span>
          <code className="log-event">{entry.event}</code>
          <time>{new Date(entry.ts).toLocaleTimeString("zh-CN", { hour12: false })}</time>
        </header>
        <p>{entry.message}</p>
        {entry.data ? <details><summary>字段</summary><pre>{JSON.stringify(entry.data, null, 2)}</pre></details> : null}
      </article>)}
      {entries && filtered.length === 0 ? <p className="muted logs-empty">没有匹配的日志。</p> : null}
      {!entries ? <p className="muted">正在读取日志…</p> : null}
    </div>
  </section>;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请重试。"; }
