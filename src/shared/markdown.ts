import type { TrailSession } from "./types";

export function generateMockMarkdown(session: TrailSession): string {
  const title = session.name.trim() || session.groupTitle || "Untitled Trail";
  const sourceName = session.source === "tab_group" ? `Chrome Tab Group: ${session.groupTitle || title}` : "Current Window";
  const sources = session.tabs
    .map((tab, index) => `${index + 1}. [${tab.title || tab.domain}](${tab.url}) - ${tab.domain}`)
    .join("\n");
  const events = session.events
    .slice(-12)
    .map((event) => `- ${new Date(event.timestamp).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} ${event.title || event.domain || event.type}`)
    .join("\n");

  return `# ${title}

## 调研目标

整理本次 ${sourceName} 中收集到的资料，形成一份可继续补充的 Research Document。

## 浏览资料

${sources || "- 暂无资料"}

## 每个资料一句总结

${session.tabs.map((tab) => `- **${tab.title || tab.domain}**：来自 ${tab.domain}，需要后续接入 AI 或正文提取后补充更准确摘要。`).join("\n") || "- 暂无资料"}

## 浏览轨迹

${events || "- 暂无记录事件"}

## 综合结论

当前版本尚未接入 AI，本节先保留为人工或后续模型总结区域。本次 Trail 已经保存了分组名称、来源列表和浏览事件，可作为后续研究资产继续迭代。

## 后续值得继续研究的问题

- 哪些资料是核心来源，哪些只是过渡页面？
- 是否需要抓取正文以提高总结质量？
- 这次调研最终支持了什么决策？
`;
}
