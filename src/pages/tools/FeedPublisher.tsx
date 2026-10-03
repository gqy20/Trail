import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { sendMessage } from "../../shared/runtime";
import type { FeedPublisherConfig, FeedPublisherSnapshot } from "../../publisher/types";

const SAMPLE_POSTS: unknown[] = [
  {
    id: "twitter:1783612345678901234",
    platform: "twitter",
    handle: "example",
    author: "Example User",
    text: "这是一条用于验证发布链路的示例推文。首次真实采集后可以在暂存前删除。",
    url: "https://x.com/example/status/1783612345678901234",
    created_at: new Date(Date.now() - 3600_000).toISOString(),
    fetched_at: new Date().toISOString(),
    metrics: { likes: 12, retweets: 3 },
    media: []
  },
  {
    id: "xhs:example-note-id",
    platform: "xhs",
    handle: "示例博主",
    author: "示例博主",
    title: "示例笔记标题",
    text: "这是一条用于验证发布链路的示例笔记。",
    url: "https://www.xiaohongshu.com/explore/example-note-id",
    created_at: new Date(Date.now() - 7200_000).toISOString(),
    fetched_at: new Date().toISOString(),
    metrics: { likes: 45, collects: 8 }
  }
];

export function FeedPublisherView() {
  const [snapshot, setSnapshot] = useState<FeedPublisherSnapshot>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [operation, setOperation] = useState("");
  const [busy, setBusy] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [draft, setDraft] = useState<FeedPublisherConfig>(defaultConfig());
  const hydrated = useRef(false);
  const ownerRef = useRef<HTMLInputElement>(null);
  const repoRef = useRef<HTMLInputElement>(null);
  const branchRef = useRef<HTMLInputElement>(null);
  const tokenRef = useRef<HTMLInputElement>(null);
  const pagesRef = useRef<HTMLInputElement>(null);

  /** 以 DOM 实际值为准读取表单：密码管理器/自动填充可能改写输入框但不触发 React onChange。 */
  function currentDraft(): FeedPublisherConfig {
    const read = (ref: React.RefObject<HTMLInputElement | null>, fallback: string) => ref.current?.value ?? fallback;
    return {
      ...draft,
      owner: read(ownerRef, draft.owner),
      repo: read(repoRef, draft.repo),
      branch: read(branchRef, draft.branch),
      token: read(tokenRef, draft.token),
      pagesBaseUrl: read(pagesRef, draft.pagesBaseUrl || "")
    };
  }

  useEffect(() => {
    let alive = true;
    const refresh = () => void sendMessage({ type: "GET_FEED_STATE" }).then((next) => {
      if (!alive) return;
      setSnapshot(next);
      // 表单只在首次加载时从已保存配置回填，之后的存储变化不覆盖正在编辑的内容。
      if (!hydrated.current) {
        hydrated.current = true;
        if (next.config) setDraft(next.config);
      }
    }).catch((err: unknown) => { if (alive) setError(errorText(err)); });
    refresh();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes["trail.feedPublisher.v1"]) refresh();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => { alive = false; chrome.storage.onChanged.removeListener(changed); };
  }, []);

  async function act(label: string, fn: () => Promise<string | undefined>) {
    setOperation(label);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await fn();
      if (message) setNotice(message);
      setSnapshot(await sendMessage({ type: "GET_FEED_STATE" }));
    } catch (err) {
      setError(errorText(err));
      setSnapshot(await sendMessage({ type: "GET_FEED_STATE" }).catch(() => snapshot));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!notice || operation !== "save") return;
    const timer = window.setTimeout(() => setNotice(""), 4000);
    return () => window.clearTimeout(timer);
  }, [notice, operation]);
  const state = snapshot?.state;
  const matchesSaved = snapshot?.config && (["owner", "repo", "branch", "token"] as const).every((key) => draft[key].trim() === snapshot.config![key].trim());
  const connection = matchesSaved ? state?.connection : undefined;
  const testing = busy && operation === "probe";
  const connectionLabel = testing ? "测试中" : connection?.status === "connected" ? "已连接" : connection?.status === "failed" ? "连接失败" : !matchesSaved && state?.connection ? "待重新测试" : "未测试";
  const repositoryFeedback = operation === "save" || operation === "probe";
  return <section className="feed-view stack">
    <div className="view-heading feed-heading"><h1>发布</h1><p className="muted text-small">将采集记录发布到 GitHub，更新 RSS 与时间线。</p></div>

    <article className="panel stack">
      <div className="section-heading repository-heading"><div className="repository-title"><strong>GitHub 仓库</strong><span className={`repository-connection ${testing ? "checking" : connection?.status || "unknown"}`} role="status" title={connection ? `最近测试：${formatTime(connection.checkedAt)}${connection.status === "connected" ? ` · ${connection.repoPrivate ? "私有" : "公共"}仓库 · 默认分支 ${connection.defaultBranch}` : ""}` : "保存配置后测试连接"}><span className="connection-dot" aria-hidden="true" />{connectionLabel}</span></div><div className="feed-actions">
        {repositoryFeedback && notice ? <span className="repository-save-notice muted text-small" role="status">{notice}</span> : null}
        <button className="button quiet" disabled={busy} onClick={() => void act("save", async () => {
          await sendMessage({ type: "SAVE_FEED_CONFIG", config: currentDraft() });
          return "已保存";
        })}>保存</button>
        <button className="button quiet" title="保存当前表单并探测仓库连通性" disabled={busy} onClick={() => void act("probe", async () => {
          await sendMessage({ type: "SAVE_FEED_CONFIG", config: currentDraft() });
          await sendMessage({ type: "PROBE_FEED_REPO" });
          return undefined;
        })}>{testing ? "测试中…" : "测试连接"}</button>
      </div></div>
      {repositoryFeedback && error ? <p role="alert" className="error-text text-small">{error}</p> : null}
      <div className="feed-config-grid">
        <div className="feed-config-wide feed-config-identity">
          <label>所有者<input ref={ownerRef} value={draft.owner} disabled={busy} onChange={(e) => setDraft({ ...draft, owner: e.target.value })} placeholder="gqy20" /></label>
          <label>仓库<input ref={repoRef} value={draft.repo} disabled={busy} onChange={(e) => setDraft({ ...draft, repo: e.target.value })} placeholder="feed" /></label>
          <label>分支<input ref={branchRef} value={draft.branch} disabled={busy} onChange={(e) => setDraft({ ...draft, branch: e.target.value })} placeholder="main" /></label>
        </div>
        <div className="feed-config-wide token-field"><label title="只授予该仓库 Contents 读写权限">Token · 仅保存在本机<input ref={tokenRef} type={showToken ? "text" : "password"} autoComplete="off" spellCheck={false} value={draft.token} disabled={busy} onChange={(e) => setDraft({ ...draft, token: e.target.value })} placeholder="github_pat_…" /></label><button className="button secondary compact-button" type="button" aria-pressed={showToken} onClick={() => setShowToken(!showToken)}>{showToken ? "隐藏" : "显示"}</button></div>
        <label className="feed-config-wide" title="留空则默认 https://<owner>.github.io/<repo>/">Pages 地址<input ref={pagesRef} value={draft.pagesBaseUrl || ""} disabled={busy} onChange={(e) => setDraft({ ...draft, pagesBaseUrl: e.target.value })} placeholder="https://gqy20.github.io/feed/" /></label>
        <div className="feed-config-wide feed-config-inline">
          <label title="站点最多保留的最新记录数，超出后最旧的被滚动淘汰">封顶<input type="number" min={100} max={50000} value={draft.maxPosts} disabled={busy} onChange={(e) => setDraft({ ...draft, maxPosts: Number(e.target.value) })} /></label>
          <label>每源<input type="number" min={10} max={5000} value={draft.itemsPerFeed} disabled={busy} onChange={(e) => setDraft({ ...draft, itemsPerFeed: Number(e.target.value) })} /></label>
          <label className="feed-config-toggle" title="渠道采集完成后立即自动发布"><input type="checkbox" checked={draft.autoPublish === true} disabled={busy} onChange={(e) => setDraft({ ...draft, autoPublish: e.target.checked })} /> 自动</label>
          <label className="feed-config-toggle" title="实时发布失败或浏览器未运行时，到期补推暂存记录"><input className="collector-interval" type="number" min={1} max={168} value={draft.autoPublishHours || 12} disabled={busy || !draft.autoPublish} onChange={(e) => setDraft({ ...draft, autoPublishHours: Number(e.target.value) })} /><span>小时</span></label>
          <label className="feed-config-toggle"><input type="checkbox" checked={draft.excludeRetweets === true} disabled={busy} onChange={(e) => setDraft({ ...draft, excludeRetweets: e.target.checked })} /> 不收录转推</label>
        </div>
      </div>
    </article>

    <article className="panel stack">
      <div className="section-heading"><strong>待发布</strong><span className="muted text-small">{snapshot ? `${snapshot.stagedCount} 条` : "…"}</span></div>
      <div className="feed-actions">
        <button className="button quiet" title="暂存两条示例记录，用于验证发布链路" disabled={busy} onClick={() => void act("sample", () =>
          sendMessage({ type: "STAGE_FEED_POSTS", posts: SAMPLE_POSTS }).then((result) => `已暂存 ${result.staged} 条（含示例数据）。`)
        )}>添加示例</button>
        {(snapshot?.stagedCount ?? 0) > 0 ? <button className="button quiet" title="清空全部暂存记录" disabled={busy} onClick={() => void act("clear", () => {
          if (!window.confirm(`清空全部 ${snapshot?.stagedCount ?? 0} 条暂存记录？此操作不可撤销。`)) return Promise.resolve(undefined);
          return sendMessage({ type: "CLEAR_STAGED_FEED" }).then((result) => `已清空 ${result.cleared} 条暂存记录。`);
        })}>清空</button> : null}
        <button className="button primary" disabled={busy || snapshot?.stagedCount === 0} onClick={() => void act("publish", () =>
          sendMessage({ type: "PUBLISH_FEED" }).then((result) =>
            `发布成功：新增 ${result.newPosts} 条，共 ${result.totalPosts} 条，写入 ${result.files.length} 个文件。`)
        )}><Send size={15} />{busy ? "正在发布…" : "立即发布"}</button>
      </div>
      {!repositoryFeedback && error ? <p role="alert" className="error-text text-small">{error}</p> : null}
      {!repositoryFeedback && notice ? <p role="status" className="text-small">{notice}</p> : null}
      {state?.lastPublishAt
        ? <p className="checkin-meta muted text-small">{[
          formatTime(state.lastPublishAt),
          state.totalPosts !== undefined ? `共 ${state.totalPosts} 条` : null,
          state.lastNewPosts !== undefined ? `上次新增 ${state.lastNewPosts}` : null
        ].filter(Boolean).join(" · ")}</p>
        : <p className="muted text-small">还没有发布过。</p>}
      {state?.lastNotice ? <p className="text-small">{state.lastNotice}</p> : null}
      {state?.lastError ? <p className="error-text text-small">{state.lastError}</p> : null}
    </article>
  </section>;
}

function defaultConfig(): FeedPublisherConfig {
  return { owner: "", repo: "feed", branch: "main", token: "", maxPosts: 20000, itemsPerFeed: 2000, autoPublish: false, autoPublishHours: 12, excludeRetweets: false };
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请重试。"; }

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
