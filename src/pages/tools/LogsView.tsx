import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, Eraser, FileDown } from "lucide-react";
import { sendMessage } from "../../shared/runtime";
import { downloadFile } from "../../shared/download";
import { formatLogEntriesText, LOG_STORE_KEY, type LogEntry, type LogLevel } from "../../logging/logger";

const LEVEL_WEIGHT: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_LABEL: Record<LogLevel, string> = { debug: "调试", info: "信息", warn: "警告", error: "错误" };
/** 首屏渲染的最新条数；滚动到底部自动增量加载剩余条目，避免 5000 条一次性渲染卡住首屏。 */
const INITIAL_VISIBLE = 300;
const VISIBLE_STEP = 500;

export function LogsView() {
  const [entries, setEntries] = useState<LogEntry[]>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [minLevel, setMinLevel] = useState<"all" | LogLevel>("all");
  const [scope, setScope] = useState("all");
  const [platform, setPlatform] = useState("all");
  const [format, setFormat] = useState("json");
  const [search, setSearch] = useState("");
  const [copiedKey, setCopiedKey] = useState<string>();
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const loadMoreRef = useRef<HTMLDivElement>(null);

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

  // 滚动到底部（哨兵进入视口）时增量加载更早日志，首屏只渲染最新一段。
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver((observerEntries) => {
      if (!observerEntries.some((item) => item.isIntersecting)) return;
      setVisibleCount((current) => (current >= filtered.length ? current : Math.min(current + VISIBLE_STEP, filtered.length)));
    }, { rootMargin: "400px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [filtered.length]);

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
    void downloadFile(`trail-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.${format === "json" ? "json" : "txt"}`, blob);
  }

  /** 单条日志文本：时间 级别 区域 事件 + 消息 + 数据 JSON，可直接贴给别人定位问题。 */
  function entryText(entry: LogEntry): string {
    const time = new Date(entry.ts).toLocaleString("zh-CN", { hour12: false });
    return `[${time}] [${LEVEL_LABEL[entry.level]}] [${entry.scope}] ${entry.event}\n${entry.message}${entry.data ? `\n${JSON.stringify(entry.data, null, 2)}` : ""}`;
  }

  async function writeClipboard(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.append(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  async function copyEntry(entry: LogEntry, key: string) {
    if (!await writeClipboard(entryText(entry))) {
      setError("复制失败，请展开日志后手动选择文本。");
      return;
    }
    setCopiedKey(key);
    window.setTimeout(() => setCopiedKey((current) => current === key ? undefined : current), 1_500);
  }

  async function copyFiltered() {
    const chronological = filtered.slice().reverse();
    if (chronological.length === 0) return;
    if (!await writeClipboard(formatLogEntriesText(chronological))) setError("复制失败，请改用导出。");
  }

  const selectedEntries = useMemo(
    () => filtered.filter((_, index) => selected.has(entryKeyOf(index))),
    [filtered, selected]
  );

  function entryKeyOf(index: number): string {
    return `${filtered[index]?.ts}-${filtered[index]?.event}-${index}`;
  }

  function toggleSelected(key: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function exitSelecting() {
    setSelecting(false);
    setSelected(new Set());
  }

  /** 复制/导出已选日志（保持时间正序）。 */
  async function copySelected() {
    if (selectedEntries.length === 0) return;
    if (!await writeClipboard(formatLogEntriesText(selectedEntries.slice().reverse()))) setError("复制失败，请改用导出。");
  }

  function exportSelected() {
    const chronological = selectedEntries.slice().reverse();
    if (chronological.length === 0) return;
    const text = format === "json" ? JSON.stringify({ exportedAt: new Date().toISOString(), selected: chronological.length, entries: chronological }, null, 2) : formatLogEntriesText(chronological);
    const blob = new Blob([text], { type: format === "json" ? "application/json;charset=utf-8" : "text/plain;charset=utf-8" });
    void downloadFile(`trail-logs-selected-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.${format === "json" ? "json" : "txt"}`, blob);
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
      {selecting ? <>
        <label className="logs-select-all"><input type="checkbox" checked={selected.size > 0 && selected.size === filtered.length} onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((_, index) => entryKeyOf(index))) : new Set())} />全选</label>
        <span className="muted text-small">已选 {selectedEntries.length} 条</span>
        <button className="button secondary" disabled={selected.size === 0} onClick={() => void copySelected()}><Copy size={15} />复制已选</button>
        <button className="button secondary" disabled={selected.size === 0} onClick={exportSelected}><FileDown size={15} />导出已选</button>
        <button className="button secondary" onClick={exitSelecting}>取消</button>
      </> : <>
        <button className="button secondary" disabled={busy || filtered.length === 0} onClick={() => void copyFiltered()}><Copy size={15} />复制</button>
        <button className="button secondary" disabled={busy || filtered.length === 0} onClick={exportLogs}><FileDown size={15} />导出</button>
        <button className="button secondary" disabled={busy || filtered.length === 0} onClick={() => { setSelecting(true); setSelected(new Set()); }}>选择</button>
      </>}
      <button className="button secondary" disabled={busy || !entries?.length} onClick={() => void clearLogs()}><Eraser size={15} />清空</button>
    </div>
    <p className="muted text-small">{filtered.length === entries?.length ? `${filtered.length} 条` : `匹配 ${filtered.length} / ${entries?.length ?? 0} 条`} · 最新在前{visibleCount < filtered.length ? ` · 已渲染 ${visibleCount} 条，滚动到底继续加载` : ""}</p>
    {observations.length ? <p className="muted text-small">当前筛选：访问结果 {observations.filter((entry) => entry.event !== "fetch.rateLimited" && entry.event !== "fetch.auth").length} 条 · 异常事件 {abnormal} 条（同一次访问可有多条） · 429 限流 {filtered.filter((entry) => entry.event === "fetch.rateLimited").length} 次。展开查看当时配置；验证或拦截不等于封号。</p> : null}
    <div className="logs-list" data-selecting={selecting}>
      {filtered.slice(0, visibleCount).map((entry, index) => {
        const entryKey = `${entry.ts}-${entry.event}-${index}`;
        return <details className={`log-entry log-${entry.level}`} key={entryKey}>
        <summary>
          {selecting ? <input type="checkbox" aria-label="选择此日志" checked={selected.has(entryKey)} onClick={(e) => e.stopPropagation()} onChange={() => toggleSelected(entryKey)} /> : null}
          <time title={new Date(entry.ts).toLocaleString("zh-CN", { hour12: false })}>{new Date(entry.ts).toLocaleTimeString("zh-CN", { hour12: false })}</time>
          <span className={`log-level log-level-${entry.level}`}>{LEVEL_LABEL[entry.level]}</span>
          <span className="log-scope">{typeof entry.data?.platform === "string" ? platformName(entry.data.platform) : entry.scope}</span>
          <span className="log-message">{entry.message}</span>
          <button className="log-copy" type="button" aria-label="复制此日志" title="复制此日志"
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); void copyEntry(entry, entryKey); }}>
            {copiedKey === entryKey ? <Check size={13} /> : <Copy size={13} />}
          </button>
          <span className="log-expand" aria-hidden="true">›</span>
        </summary>
        <code className="log-event">{entry.event}</code>
        {entry.data ? <pre>{JSON.stringify(entry.data, null, 2)}</pre> : null}
      </details>;
      })}
      <div ref={loadMoreRef} aria-hidden="true" />
      {visibleCount < filtered.length ? <p className="muted text-small logs-empty">正在加载更早日志…</p> : null}
      {entries && filtered.length === 0 ? <p className="muted logs-empty">没有匹配的日志。</p> : null}
      {!entries ? <p className="muted">正在读取日志…</p> : null}
    </div>
  </section>;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请重试。"; }
