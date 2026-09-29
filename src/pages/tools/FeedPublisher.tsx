import { useEffect, useRef, useState } from "react";
import { PlugZap, Rss, Send, Trash2, UploadCloud } from "lucide-react";
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
  const [busy, setBusy] = useState(false);
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
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const message = await fn();
      if (message) setNotice(message);
      setSnapshot(await sendMessage({ type: "GET_FEED_STATE" }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const state = snapshot?.state;
  return <section className="feed-view stack">
    <div className="view-heading"><h2>订阅源发布</h2><Rss size={20} /></div>
    <p className="muted text-small">
      抓取到的记录暂存在本地，发布时合并到 GitHub 仓库的 data/posts.json，并重写 RSS 与时间线页。
      发布目标仓库和 token 只保存在本机浏览器里。
    </p>
    {error ? <p role="alert" className="error-text">{error}</p> : null}
    {notice ? <p className="text-small">{notice}</p> : null}

    <article className="panel stack">
      <div className="section-heading"><strong>GitHub 仓库</strong></div>
      <div className="feed-config-grid">
        <label>owner<input ref={ownerRef} value={draft.owner} disabled={busy} onChange={(e) => setDraft({ ...draft, owner: e.target.value })} placeholder="gqy20" /></label>
        <label>仓库<input ref={repoRef} value={draft.repo} disabled={busy} onChange={(e) => setDraft({ ...draft, repo: e.target.value })} placeholder="feed" /></label>
        <label>分支<input ref={branchRef} value={draft.branch} disabled={busy} onChange={(e) => setDraft({ ...draft, branch: e.target.value })} placeholder="main" /></label>
        <label className="feed-config-wide">token（只授该仓库 Contents 读写）<input ref={tokenRef} type="text" autoComplete="off" spellCheck={false} value={draft.token} disabled={busy} onChange={(e) => setDraft({ ...draft, token: e.target.value })} placeholder="github_pat_…" /></label>
        <label className="feed-config-wide">Pages 根地址（可选，默认 https://&lt;owner&gt;.github.io/&lt;repo&gt;/）<input ref={pagesRef} value={draft.pagesBaseUrl || ""} disabled={busy} onChange={(e) => setDraft({ ...draft, pagesBaseUrl: e.target.value })} placeholder="https://gqy20.github.io/feed/" /></label>
        <label className="feed-config-toggle feed-config-wide"><input type="checkbox" checked={draft.autoPublish === true} disabled={busy} onChange={(e) => setDraft({ ...draft, autoPublish: e.target.checked })} /> 采集成功后自动发布（无需手动点“立即发布”）</label>
        <label className="feed-config-toggle feed-config-wide"><input type="checkbox" checked={draft.excludeRetweets === true} disabled={busy} onChange={(e) => setDraft({ ...draft, excludeRetweets: e.target.checked })} /> 订阅源不收录转推/转发</label>
        <label>历史封顶<input type="number" min={100} max={20000} value={draft.maxPosts} disabled={busy} onChange={(e) => setDraft({ ...draft, maxPosts: Number(e.target.value) })} /></label>
        <label>每源条数<input type="number" min={10} max={500} value={draft.itemsPerFeed} disabled={busy} onChange={(e) => setDraft({ ...draft, itemsPerFeed: Number(e.target.value) })} /></label>
      </div>
      <div className="feed-actions">
        <button className="button secondary" disabled={busy} onClick={() => void act("save", async () => {
          await sendMessage({ type: "SAVE_FEED_CONFIG", config: currentDraft() });
          return "配置已保存。";
        })}>保存配置</button>
        <button className="button secondary" disabled={busy} onClick={() => void act("probe", async () => {
          await sendMessage({ type: "SAVE_FEED_CONFIG", config: currentDraft() });
          const probe = await sendMessage({ type: "PROBE_FEED_REPO" });
          return `配置已保存。连接成功：仓库为${probe.repoPrivate ? "私有" : "公共"}，默认分支 ${probe.defaultBranch}。`;
        })}><PlugZap size={15} />保存并测试连接</button>
      </div>
    </article>

    <article className="panel stack">
      <div className="section-heading"><strong>待发布</strong><span className="muted text-small">{snapshot ? `${snapshot.stagedCount} 条` : "…"}</span></div>
      <p className="muted text-small">采集渠道接入后，每轮抓取的结果会先进暂存；发布失败时暂存保留，下次重试。</p>
      <div className="feed-actions">
        <button className="button secondary" disabled={busy} onClick={() => void act("sample", () =>
          sendMessage({ type: "STAGE_FEED_POSTS", posts: SAMPLE_POSTS }).then((result) => `已暂存 ${result.staged} 条（含示例数据）。`)
        )}><UploadCloud size={15} />暂存示例数据</button>
        <button className="button secondary" disabled={busy || snapshot?.stagedCount === 0} onClick={() => void act("clear", () => {
          if (!window.confirm(`清空全部 ${snapshot?.stagedCount ?? 0} 条暂存记录？此操作不可撤销。`)) return Promise.resolve(undefined);
          return sendMessage({ type: "CLEAR_STAGED_FEED" }).then((result) => `已清空 ${result.cleared} 条暂存记录。`);
        })}><Trash2 size={15} />清空暂存</button>
        <button className="button primary" disabled={busy || snapshot?.stagedCount === 0} onClick={() => void act("publish", () =>
          sendMessage({ type: "PUBLISH_FEED" }).then((result) =>
            `发布成功：新增 ${result.newPosts} 条，共 ${result.totalPosts} 条，写入 ${result.files.length} 个文件。`)
        )}><Send size={15} />{busy ? "正在发布…" : "立即发布"}</button>
      </div>
    </article>

    <article className="panel stack">
      <div className="section-heading"><strong>发布状态</strong></div>
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
  return { owner: "", repo: "feed", branch: "main", token: "", maxPosts: 5000, itemsPerFeed: 150, autoPublish: false, excludeRetweets: false };
}

function errorText(error: unknown): string { return error instanceof Error ? error.message : "操作失败，请重试。"; }

function formatTime(iso: string): string {
  const date = new Date(iso);
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
