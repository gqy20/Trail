import { probeFeedRepo, publishFeed } from "../publisher/publish";
import {
  getFeedPublisherSnapshot,
  patchFeedState,
  saveFeedConfig,
  stageFeedPosts
} from "../publisher/storage";
import { stageFeedFromRun } from "../publisher/collect";
import type { BrowserToolDefinition, BrowserToolRunResult } from "../browser-tools/contracts";
import type { FeedPublisherConfig, FeedPublishResult, FeedRepoProbe } from "../publisher/types";

/**
 * 暂存采集结果；当配置开启“采集后自动发布”时紧接一轮发布。
 * 发布失败只写入状态不抛出，避免影响采集本身的收尾。
 */
export async function stageAndMaybePublish(definition: BrowserToolDefinition, result: BrowserToolRunResult): Promise<void> {
  const staged = await stageFeedFromRun(definition, result);
  if (staged === 0) return;
  const { config } = await getFeedPublisherSnapshot();
  if (!config?.autoPublish) return;
  try {
    await publishFeed();
  } catch (error) {
    const message = `${new Date().toLocaleString("zh-CN")} 自动发布失败：${error instanceof Error ? error.message : "未知错误"}`;
    await patchFeedState({ lastError: message }).catch(() => undefined);
  }
}

export async function getFeedState(): Promise<ReturnType<typeof getFeedPublisherSnapshot>> {
  return getFeedPublisherSnapshot();
}

export async function saveFeedPublisherConfig(config: FeedPublisherConfig) {
  await saveFeedConfig(config);
  return getFeedPublisherSnapshot();
}

export async function stagePosts(posts: unknown[]): Promise<{ staged: number }> {
  return { staged: await stageFeedPosts(posts) };
}

export async function probeFeedConnection(): Promise<FeedRepoProbe> {
  return probeFeedRepo();
}

/** 发布暂存记录；失败时保留暂存并把错误写入状态，供界面展示与下一轮重试。 */
export async function publishStagedFeed(): Promise<FeedPublishResult> {
  try {
    return await publishFeed();
  } catch (error) {
    const message = error instanceof Error ? error.message : "发布失败";
    await patchFeedState({ lastError: `${new Date().toLocaleString("zh-CN")} ${message}` });
    throw error;
  }
}
