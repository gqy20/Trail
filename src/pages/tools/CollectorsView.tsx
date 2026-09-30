import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { sendMessage } from "../../shared/runtime";
import type { CollectorState } from "../../collector/types";
import { CollectorPanel } from "./CollectorPanel";

/**
 * 跨渠道统一采集页：X / 小红书等渠道集中管理，
 * 不需要选中工具或打开对应网站即可查看状态与立即采集；
 * 账号名单持久化在 follows 存储，导入一次长期有效。
 */
export function CollectorsView() {
  const [state, setState] = useState<CollectorState>();
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    const refresh = () => void sendMessage({ type: "GET_COLLECTOR_STATE" }).then((next) => {
      if (alive) setState(next);
    }).catch((err: unknown) => { if (alive) setError(errorText(err)); });
    refresh();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && (changes["trail.collectors.v1"] || changes["trail.follows.v1"] || changes["trail.browserTools"])) refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => { alive = false; chrome.storage.onChanged.removeListener(changed); };
  }, []);

  const items = state?.items || [];
  return <section className="collectors-view stack">
    <div className="view-heading inline-view-heading"><h1>账号采集</h1><p className="muted text-small">按名单定时采集，记录暂存到发布页。</p></div>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {!state ? <p className="muted">正在读取渠道…</p> : null}
    {items.map((item) => (
      <CollectorPanel key={item.toolId} toolId={item.toolId} platform={item.platform} name={item.name} />
    ))}
    {state && items.length === 0 ? <div className="panel stack">
      <p>还没有采集渠道。</p>
      <button className="button secondary" onClick={() => void sendMessage({ type: "IMPORT_BUNDLED_BROWSER_TOOLS" }).then(() => undefined)}><RefreshCw size={15} /> 同步内置工具</button>
    </div> : null}
  </section>;
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请重试。"; }
