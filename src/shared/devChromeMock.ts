import type { TrailSession } from "./types";

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
    }
  ],
  markdown: `# Playwright 插件开发调研

## 调研目标

整理本次 Chrome 标签页分组中收集到的资料，形成一份可继续补充的研究文档。

## 浏览资料

1. [Playwright Browser Extension 文档](https://playwright.dev/docs/chrome-extensions) - playwright.dev
2. [Chrome Extensions Manifest V3](https://developer.chrome.com/docs/extensions/mv3/intro) - developer.chrome.com
3. [GitHub - microsoft/playwright](https://github.com/microsoft/playwright) - github.com

## 综合结论

当前版本尚未接入 AI，本节先保留为人工或后续模型总结区域。`
};

export function installDevChromeMock() {
  if (!import.meta.env.DEV) return;

  const existingChrome = globalThis.chrome as typeof chrome | undefined;
  if (existingChrome?.runtime?.sendMessage && existingChrome?.storage?.local) return;

  const storage: Record<string, unknown> = {
    "trail.sessions": [sampleSession]
  };

  const extensionRoot = window.location.origin;

  globalThis.chrome = {
    runtime: {
      getURL: (path: string) => `${extensionRoot}/${path}`,
      sendMessage: async (message: { type: string }) => {
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
            recentSessions: [sampleSession]
          };
        }

        return sampleSession;
      },
      onMessage: { addListener: () => undefined }
    },
    tabs: {
      query: async () => sampleTabs,
      create: async ({ url }: { url?: string }) => {
        if (url) window.location.href = url;
        return sampleTabs[0];
      },
      group: async () => 12,
      onCreated: { addListener: () => undefined },
      onUpdated: { addListener: () => undefined },
      onActivated: { addListener: () => undefined },
      onRemoved: { addListener: () => undefined }
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
