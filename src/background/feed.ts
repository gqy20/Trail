import { probeFeedRepo, publishFeed } from "../publisher/publish";
import {
  clearStagedPosts,
  getFeedPublisherSnapshot,
  patchFeedState,
  saveFeedConfig,
  stageFeedPosts
} from "../publisher/storage";
import { stageFeedFromRun } from "../publisher/collect";
import { logError, logInfo, logWarn } from "../logging/logger";
import type { BrowserToolDefinition, BrowserToolRunResult } from "../browser-tools/contracts";
import type { FeedPublisherConfig, FeedPublishResult, FeedRepoProbe } from "../publisher/types";

const PUBLISH_INTERVAL_ALARM = "trail.feed.publishInterval";

/**
 * 自动发布串行队列：渠道完成即发布（实时），但多个发布不会并发执行——
 * Git 单提交基于分支头，并发提交会互相覆盖或撞 409。队列保证按完成顺序逐个推送。
 */
let publishQueue: Promise<unknown> = Promise.resolve();

function enqueuePublish<T>(task: () => Promise<T>): Promise<T> {
  const next = publishQueue.then(task, task);
  publishQueue = next.catch(() => undefined);
  return next;
}

/**
 * 暂存采集结果；配置开启"自动发布"时立即触发一次发布（实时发布）。
 * 发布在串行队列中执行：另一渠道若正巧同时完成，其暂存会在本轮提交后
 * 由自己的触发单独推送；发布失败只写状态不抛出，避免影响采集本身的收尾。
 */
export async function stageAndMaybePublish(definition: BrowserToolDefinition, result: BrowserToolRunResult): Promise<void> {
  const { staged, dropped } = await stageFeedFromRun(definition, result);
  if (staged > 0 || dropped > 0) {
    logInfo("feed", "stage.done", "采集记录已暂存", { toolId: definition.id, staged, dropped });
  }
  if (dropped > 0) {
    await patchFeedState({
      lastNotice: `${new Date().toLocaleString("zh-CN")} 暂存已达上限（2000 条），丢弃了 ${dropped} 条最旧记录，请尽快发布。`
    }).catch(() => undefined);
  }
  if (staged === 0 && dropped === 0) return;
  const { config } = await getFeedPublisherSnapshot();
  if (!config?.autoPublish) return;

  logInfo("feed", "publish.scheduled", "实时发布已触发", { staged, toolId: definition.id });
  void enqueuePublish(publishStagedAuto).catch(() => undefined);
}

/** 自动发布的统一入口：无待发布记录时静默跳过（兜底间隔轮询会走这里）。 */
export async function publishStagedAuto(): Promise<void> {
  try {
    const result = await publishFeed();
    logInfo("feed", "publish.done", "自动发布完成", { newPosts: result.newPosts, totalPosts: result.totalPosts, files: result.files.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";
    // 暂存可能已被手动发布清空——这是正常路径，不记为错误
    if (!message.includes("没有待发布的新记录")) {
      logError("feed", "publish.fail", "自动发布失败", { detail: message });
      await patchFeedState({ lastError: `${new Date().toLocaleString("zh-CN")} 自动发布失败：${message}` }).catch(() => undefined);
    }
  }
}

/** 清空订阅源暂存（用于发布前清理示例或过期数据）。 */
export async function clearStagedFeed(): Promise<{ cleared: number }> {
  const snapshot = await getFeedPublisherSnapshot();
  const cleared = snapshot.stagedCount;
  await clearStagedPosts();
  logInfo("feed", "stage.clear", "清空订阅源暂存", { cleared });
  return { cleared };
}

export async function getFeedState() {
  return getFeedPublisherSnapshot();
}

export async function saveFeedPublisherConfig(config: FeedPublisherConfig) {
  await saveFeedConfig(config);
  await ensurePublishIntervalAlarm();
  return getFeedPublisherSnapshot();
}

export async function stagePosts(posts: unknown[]): Promise<{ staged: number }> {
  const { kept } = await stageFeedPosts(posts);
  return { staged: kept };
}

export async function probeFeedConnection(): Promise<FeedRepoProbe> {
  return probeFeedRepo();
}

/** 发布暂存记录；失败时保留暂存并把错误写入状态，供界面展示与下一轮重试。与自动发布共用串行队列。 */
export function publishStagedFeed(): Promise<FeedPublishResult> {
  return enqueuePublish(async () => {
    try {
      const result = await publishFeed();
      logInfo("feed", "publish.done", "手动发布完成", { newPosts: result.newPosts, totalPosts: result.totalPosts, files: result.files.length });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "发布失败";
      logError("feed", "publish.fail", "手动发布失败", { detail: message });
      await patchFeedState({ lastError: `${new Date().toLocaleString("zh-CN")} ${message}` });
      throw error;
    }
  });
}

/** 注册发布相关的闹钟监听（在 background/index.ts 调用一次）。 */
export function registerFeedPublisher(): void {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === PUBLISH_INTERVAL_ALARM) {
      // 兜底间隔：实时发布失败或当时浏览器未运行时，这里有暂存就补推。
      void publishFromInterval().catch(() => undefined);
    }
  });
  void ensurePublishIntervalAlarm();
}

/** 定时间隔到期：有暂存则推送，无则静默跳过。 */
async function publishFromInterval(): Promise<void> {
  const snapshot = await getFeedPublisherSnapshot();
  if (snapshot.stagedCount === 0) return;
  logInfo("feed", "publish.interval", "定时间隔到期，推送暂存记录", { staged: snapshot.stagedCount });
  await enqueuePublish(publishStagedAuto);
}

/** 配置了自动发布间隔时确保闹钟存在，否则清除。 */
async function ensurePublishIntervalAlarm(): Promise<void> {
  const { config } = await getFeedPublisherSnapshot();
  const hours = config?.autoPublishHours || 12;
  if (!config?.autoPublish) {
    await chrome.alarms.clear(PUBLISH_INTERVAL_ALARM);
    return;
  }
  const existing = await chrome.alarms.get(PUBLISH_INTERVAL_ALARM);
  if (!existing || existing.periodInMinutes !== hours * 60) {
    await chrome.alarms.create(PUBLISH_INTERVAL_ALARM, { periodInMinutes: hours * 60 });
    logInfo("feed", "publish.intervalSet", `定时发布已排定（每 ${hours} 小时）`, { hours });
  }
}
