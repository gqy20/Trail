import { probeFeedRepo, publishFeed } from "../publisher/publish";
import {
  clearStagedPosts,
  getFeedPublisherSnapshot,
  patchFeedState,
  saveFeedConfig,
  stageFeedPosts
} from "../publisher/storage";
import { stageFeedFromRun } from "../publisher/collect";
import { logError, logInfo } from "../logging/logger";
import type { BrowserToolDefinition, BrowserToolRunResult } from "../browser-tools/contracts";
import type { FeedPublisherConfig, FeedPublishResult, FeedRepoProbe } from "../publisher/types";

/**
 * 暂存采集结果；当配置开启“采集后自动发布”时紧接一轮发布。
 * 发布失败只写入状态不抛出，避免影响采集本身的收尾。
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
  logInfo("feed", "publish.autoStart", "自动发布开始", { staged });
  try {
    const published = await publishFeed();
    logInfo("feed", "publish.done", "自动发布完成", { newPosts: published.newPosts, totalPosts: published.totalPosts, files: published.files.length });
  } catch (error) {
    const message = `${new Date().toLocaleString("zh-CN")} 自动发布失败：${error instanceof Error ? error.message : "未知错误"}`;
    logError("feed", "publish.fail", "自动发布失败", { detail: error instanceof Error ? error.message : "未知错误" });
    await patchFeedState({ lastError: message }).catch(() => undefined);
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

export async function getFeedState(): Promise<ReturnType<typeof getFeedPublisherSnapshot>> {
  return getFeedPublisherSnapshot();
}

export async function saveFeedPublisherConfig(config: FeedPublisherConfig) {
  await saveFeedConfig(config);
  return getFeedPublisherSnapshot();
}

export async function stagePosts(posts: unknown[]): Promise<{ staged: number }> {
  const { kept } = await stageFeedPosts(posts);
  return { staged: kept };
}

export async function probeFeedConnection(): Promise<FeedRepoProbe> {
  return probeFeedRepo();
}

/** 发布暂存记录；失败时保留暂存并把错误写入状态，供界面展示与下一轮重试。 */
export async function publishStagedFeed(): Promise<FeedPublishResult> {
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
}
