import { DEFAULT_INTERACTION_SETTINGS } from "./interactions";
import type { TrailInteractionSettings, TrailSession } from "./types";

const now = Date.now();

const sampleTabs: chrome.tabs.Tab[] = [
  {
    id: 1,
    index: 0,
    highlighted: true,
    active: true,
    pinned: false,
    incognito: false,
    selected: true,
    discarded: false,
    frozen: false,
    autoDiscardable: true,
    groupId: 12,
    windowId: 1,
    title: "Playwright Browser Extension 文档",
    url: "https://playwright.dev/docs/chrome-extensions",
    favIconUrl: ""
  },
  {
    id: 2,
    index: 1,
    highlighted: false,
    active: false,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    frozen: false,
    autoDiscardable: true,
    groupId: 12,
    windowId: 1,
    title: "Chrome Extensions Manifest V3",
    url: "https://developer.chrome.com/docs/extensions/mv3/intro",
    favIconUrl: ""
  },
  {
    id: 3,
    index: 2,
    highlighted: false,
    active: false,
    pinned: false,
    incognito: false,
    selected: false,
    discarded: false,
    frozen: false,
    autoDiscardable: true,
    groupId: 12,
    windowId: 1,
    title: "GitHub - microsoft/playwright",
    url: "https://github.com/microsoft/playwright",
    favIconUrl: ""
  }
];

const sampleSession: TrailSession = {
  id: "sample-session",
  source: "tab_group",
  name: "Playwright 插件开发调研",
  groupId: 12,
  groupTitle: "Playwright 插件开发调研",
  groupColor: "cyan",
  windowId: 1,
  status: "completed",
  startedAt: now - 1000 * 60 * 28,
  endedAt: now - 1000 * 60 * 2,
  updatedAt: now - 1000 * 60 * 2,
  tabs: sampleTabs.map((tab) => ({
    id: tab.id,
    title: tab.title || "",
    url: tab.url || "",
    domain: new URL(tab.url || "https://example.com").hostname,
    groupId: tab.groupId,
    windowId: tab.windowId,
    capturedAt: now
  })),
  events: [
    {
      id: "event-1",
      type: "created",
      tabId: 1,
      title: "Playwright Browser Extension 文档",
      domain: "playwright.dev",
      timestamp: now - 1000 * 60 * 28
    },
    {
      id: "event-2",
      type: "activated",
      tabId: 2,
      title: "Chrome Extensions Manifest V3",
      domain: "developer.chrome.com",
      timestamp: now - 1000 * 60 * 18
    },
    {
      id: "event-3",
      type: "text_copied",
      tabId: 1,
      title: "Playwright Browser Extension 文档",
      url: "https://playwright.dev/docs/chrome-extensions",
      domain: "playwright.dev",
      timestamp: now - 1000 * 60 * 8,
      selectedText: "Extensions can be loaded in persistent contexts by passing a path to the extension directory.",
      surroundingText: "Chrome extensions are supported in Chromium. Extensions can be loaded in persistent contexts by passing a path to the extension directory.",
      sectionTitle: "Chrome extensions",
      elementTag: "p",
      cssSelector: "main > article > p",
      privacyLevel: "safe",
      copyKind: "quote",
      duplicateCount: 2,
      firstCopiedAt: now - 1000 * 60 * 12
    },
    {
      id: "event-4",
      type: "text_copied",
      tabId: 1,
      title: "Playwright Browser Extension 文档",
      url: "https://playwright.dev/docs/chrome-extensions",
      domain: "playwright.dev",
      timestamp: now - 1000 * 60 * 6,
      selectedText: "npm install @playwright/test",
      surroundingText: "Install Playwright Test before loading and validating the extension.",
      sectionTitle: "Installation",
      elementTag: "code",
      cssSelector: "main > article > pre > code",
      privacyLevel: "safe",
      copyKind: "command",
      duplicateCount: 1
    },
    {
      id: "event-5",
      type: "text_selected",
      tabId: 2,
      title: "Chrome Extensions Manifest V3",
      url: "https://developer.chrome.com/docs/extensions/mv3/intro",
      domain: "developer.chrome.com",
      timestamp: now - 1000 * 60 * 4,
      selectedText: "Manifest V3 uses a service worker as the extension's central event handler.",
      surroundingText: "Manifest V3 uses a service worker as the extension's central event handler. Service workers are started when needed and unloaded when idle.",
      sectionTitle: "Extension service worker",
      elementTag: "p",
      cssSelector: "main > article > p",
      privacyLevel: "safe",
      copyKind: "quote",
      duplicateCount: 1
    },
    {
      id: "event-6",
      type: "link_clicked",
      tabId: 1,
      title: "Playwright Browser Extension 文档",
      url: "https://playwright.dev/docs/chrome-extensions",
      domain: "playwright.dev",
      timestamp: now - 1000 * 60 * 3,
      targetUrl: "https://github.com/microsoft/playwright/issues",
      targetText: "microsoft/playwright issues",
      targetDomain: "github.com",
      sectionTitle: "Troubleshooting",
      elementTag: "a",
      cssSelector: "main > article > a",
      linkKind: "github"
    }
  ],
  pageStats: [
    {
      url: "https://playwright.dev/docs/chrome-extensions",
      domain: "playwright.dev",
      title: "Playwright Browser Extension 文档",
      firstSeenAt: now - 1000 * 60 * 28,
      lastSeenAt: now - 1000 * 60 * 3,
      activeMs: 1000 * 60 * 12,
      visitCount: 2,
      selectedCount: 0,
      copiedCount: 2,
      outboundClickCount: 1,
      score: 28,
      level: "core"
    },
    {
      url: "https://developer.chrome.com/docs/extensions/mv3/intro",
      domain: "developer.chrome.com",
      title: "Chrome Extensions Manifest V3",
      firstSeenAt: now - 1000 * 60 * 18,
      lastSeenAt: now - 1000 * 60 * 4,
      activeMs: 1000 * 60 * 6,
      visitCount: 1,
      selectedCount: 1,
      copiedCount: 0,
      outboundClickCount: 0,
      score: 9,
      level: "reference"
    },
    {
      url: "https://github.com/microsoft/playwright",
      domain: "github.com",
      title: "GitHub - microsoft/playwright",
      firstSeenAt: now - 1000 * 60 * 12,
      lastSeenAt: now - 1000 * 60 * 12,
      activeMs: 1000 * 30,
      visitCount: 1,
      selectedCount: 0,
      copiedCount: 0,
      outboundClickCount: 0,
      score: 0,
      level: "passing"
    }
  ],
  markdown: `# Playwright 插件开发调研

## 调研目标

整理本次 Chrome 标签页分组中收集到的资料，形成一份可继续补充的研究文档。

## 浏览资料

1. [Playwright Browser Extension 文档](https://playwright.dev/docs/chrome-extensions) - playwright.dev
2. [Chrome Extensions Manifest V3](https://developer.chrome.com/docs/extensions/mv3/intro) - developer.chrome.com
3. [GitHub - microsoft/playwright](https://github.com/microsoft/playwright) - github.com

## 来源分级

### 核心来源

- [Playwright Browser Extension 文档](https://playwright.dev/docs/chrome-extensions) - playwright.dev，评分 28，复制 2，选中 0，点击 1

### 参考来源

- [Chrome Extensions Manifest V3](https://developer.chrome.com/docs/extensions/mv3/intro) - developer.chrome.com，评分 9，复制 0，选中 1，点击 0

### 过渡页面

- [GitHub - microsoft/playwright](https://github.com/microsoft/playwright) - github.com，评分 0，复制 0，选中 0，点击 0

## 调研路径

- [playwright.dev](https://playwright.dev/docs/chrome-extensions) → [microsoft/playwright issues](https://github.com/microsoft/playwright/issues)（GitHub）

## 用户关注过的关键片段

### 片段 1

来源：[playwright.dev](https://playwright.dev/docs/chrome-extensions)，位置：Chrome extensions

状态：已复制 · 类型：引用 · 重复复制：2 次

> Extensions can be loaded in persistent contexts by passing a path to the extension directory.

### 片段 2

来源：[playwright.dev](https://playwright.dev/docs/chrome-extensions)，位置：Installation

状态：已复制 · 类型：命令

> npm install @playwright/test

### 片段 3

来源：[developer.chrome.com](https://developer.chrome.com/docs/extensions/mv3/intro)，位置：Extension service worker

状态：仅选中 · 类型：引用

> Manifest V3 uses a service worker as the extension's central event handler.

## 综合结论

当前版本尚未接入 AI，本节先保留为人工或后续模型总结区域。
`
};

const sampleBrowserTool = {
  id: "example-data-collector",
  yaml: "",
  definition: {
    schema_version: 1,
    id: "example-data-collector",
    name: "示例数据工具",
    description: "用于开发预览的通用批量数据采集工具",
    version: "0.1.0",
    match: { domains: ["example.com"], urls: ["*/search*"] },
    presentation: {
      title: "数据采集",
      source_label: "示例搜索",
      batch_input: {
        label: "搜索词",
        placeholder: "每行输入一个搜索词",
        item_label: "搜索词",
        count_unit: "个",
        import_formats: ["txt", "csv"],
        csv_headers: ["搜索词", "keyword", "query"]
      },
      actions: {
        run: "开始搜索",
        run_empty: "输入搜索词后开始",
        running: "正在搜索…",
        single_run: "只读取当前结果页",
        single_running: "正在读取当前页…"
      },
      results: {
        title: "本次结果",
        item_label: "条目",
        count_unit: "个",
        empty_title: "还没有搜索结果",
        empty_description: "完成一次搜索后，结果会显示在这里。"
      },
      collections: {
        results: {
          label: "搜索结果",
          item_label: "条目",
          count_unit: "个",
          fields: {
            _query: { label: "搜索词", order: 10 },
            name: { label: "名称", order: 20, emphasis: "primary" },
            category: { label: "分类", order: 30 },
            updated_at: { label: "更新时间", order: 40 },
            score: { label: "相关度", order: 50 },
            url: { label: "链接", order: 60, display: "link" }
          }
        }
      }
    },
    parameters: {
      page_limit: {
        type: "number",
        label: "读取页数",
        default: 3,
        min: 1,
        max: 20,
        required: true,
        presentation: { placement: "primary", style: "sentence", prefix: "每个搜索词读取", suffix: "页" }
      }
    },
    workflow: [{ action: "wait", duration_ms: 100 }],
    batch: {
      navigation: { type: "query_parameter", parameter: "kw" },
      max_keywords: 50,
      delay_between_keywords_ms: 1200
    }
  },
  importedAt: now - 1000 * 60 * 60,
  updatedAt: now - 1000 * 60 * 30
};

const sampleBrowserToolRun = {
  toolId: sampleBrowserTool.id,
  toolName: "示例数据工具 · 批量",
  runId: "sample-browser-tool-run",
  pageUrl: "https://example.com/search?q=interface",
  pageTitle: "示例搜索结果",
  startedAt: now - 1000 * 70,
  finishedAt: now - 1000 * 10,
  savedAt: now - 1000 * 10,
  status: "completed",
  warnings: [],
  data: {
    results: [
      {
        _query: "界面设计",
        name: "研究工具界面规范",
        category: "设计系统",
        updated_at: "2026-07-18",
        score: 92,
        url: "https://example.com/result/1"
      },
      {
        _query: "数据采集",
        name: "批量采集任务示例",
        category: "自动化",
        updated_at: "2026-06-27",
        score: 87,
        url: "https://example.com/result/2"
      }
    ]
  }
};

export function installDevChromeMock() {
  if (!import.meta.env.DEV) return;

  const existingChrome = globalThis.chrome as typeof chrome | undefined;
  if (existingChrome?.runtime?.sendMessage && existingChrome?.storage?.local) return;

  const storage: Record<string, unknown> = {
    "trail.sessions": [sampleSession],
    "trail.interactionSettings": DEFAULT_INTERACTION_SETTINGS
  };

  const extensionRoot = window.location.origin;

  globalThis.chrome = {
    runtime: {
      getURL: (path: string) => `${extensionRoot}/${path}`,
      sendMessage: async (message: { type: string; settings?: Partial<TrailInteractionSettings>; eventId?: string }) => {
        if (message.type === "GET_POPUP_STATE") {
          const isActivePreview = new URLSearchParams(window.location.search).get("active") === "1";

          return {
            activeSession: isActivePreview ? { ...sampleSession, status: "recording", endedAt: undefined } : undefined,
            currentGroup: {
              hasGroup: true,
              group: { id: 12, title: "Playwright 插件开发调研", color: "cyan", collapsed: false, windowId: 1 },
              activeTab: sampleTabs[0],
              tabs: sampleSession.tabs,
              windowId: 1
            },
            recentSessions: [sampleSession],
            interactionSettings: storage["trail.interactionSettings"]
          };
        }

        if (message.type === "GET_INTERACTION_SETTINGS") {
          return storage["trail.interactionSettings"];
        }

        if (message.type === "UPDATE_INTERACTION_SETTINGS") {
          storage["trail.interactionSettings"] = {
            ...(storage["trail.interactionSettings"] as TrailInteractionSettings),
            ...(message.settings || {})
          };
          return storage["trail.interactionSettings"];
        }

        if (message.type === "DELETE_EVENT") {
          sampleSession.events = sampleSession.events.filter((event) => event.id !== message.eventId);
          return { deleted: true };
        }

        if (message.type === "GET_BROWSER_TOOL_STATE") {
          return {
            tools: [sampleBrowserTool],
            recentRuns: [sampleBrowserToolRun],
            targetTab: {
              id: 88,
              title: "Example Search：批量结果",
              url: "https://example.com/search?q=interface"
            },
            matchedToolIds: [sampleBrowserTool.id]
          };
        }

        if (message.type === "RUN_STORED_BROWSER_TOOL" || message.type === "RUN_BROWSER_TOOL_BATCH") {
          return sampleBrowserToolRun;
        }

        return sampleSession;
      },
      onMessage: { addListener: () => undefined }
    },
    tabs: {
      query: async () => sampleTabs,
      get: async (tabId: number) => sampleTabs.find((tab) => tab.id === tabId) || sampleTabs[0],
      create: async ({ url }: { url?: string }) => {
        if (url) window.location.href = url;
        return sampleTabs[0];
      },
      group: async () => 12,
      onCreated: { addListener: () => undefined, removeListener: () => undefined },
      onUpdated: { addListener: () => undefined, removeListener: () => undefined },
      onActivated: { addListener: () => undefined, removeListener: () => undefined },
      onRemoved: { addListener: () => undefined, removeListener: () => undefined }
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      get: async () => ({ id: 12, title: "Playwright 插件开发调研", color: "cyan", collapsed: false, windowId: 1 }),
      query: async () => [{ id: 12, title: "Playwright 插件开发调研", color: "cyan", collapsed: false, windowId: 1 }],
      update: async (_id: number, properties: { title?: string }) => ({
        id: 12,
        title: properties.title || "Playwright 插件开发调研",
        color: "cyan",
        collapsed: false,
        windowId: 1
      }),
      onUpdated: { addListener: () => undefined }
    },
    storage: {
      local: {
        get: async (key: string) => ({ [key]: storage[key] }),
        set: async (items: Record<string, unknown>) => {
          Object.assign(storage, items);
        },
        remove: async (key: string) => {
          delete storage[key];
        }
      }
    }
  } as unknown as typeof chrome;
}
