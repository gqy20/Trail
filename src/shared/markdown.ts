import type { TrailEvent, TrailSession } from "./types";

export function generateMockMarkdown(session: TrailSession): string {
  const title = session.name.trim() || session.groupTitle || "未命名研究记录";
  const sourceName = session.source === "tab_group" ? `Chrome 标签页分组：${session.groupTitle || title}` : "当前窗口";
  const sources = session.tabs
    .map((tab, index) => `${index + 1}. [${tab.title || tab.domain}](${tab.url}) - ${tab.domain}`)
    .join("\n");
  const copiedNotes = copiedEventsToMarkdown(session.events);
  const events = session.events
    .filter((event) => event.type !== "text_copied")
    .slice(-12)
    .map(
      (event) =>
        `- ${new Date(event.timestamp).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit"
        })} ${event.title || event.domain || event.type}`
    )
    .join("\n");

  return `# ${title}

## 调研目标

整理本次 ${sourceName} 中收集到的资料，形成一份可继续补充的研究文档。

## 浏览资料

${sources || "- 暂无资料"}

## 用户关注过的关键片段

${copiedNotes || "- 暂无关注片段"}

## 每个资料一句总结

${
  session.tabs
    .map((tab) => `- **${tab.title || tab.domain}**：来自 ${tab.domain}，需要后续接入 AI 或正文提取后补充更准确摘要。`)
    .join("\n") || "- 暂无资料"
}

## 浏览轨迹

${events || "- 暂无记录事件"}

## 综合结论

当前版本尚未接入 AI，本节先保留为人工或后续模型总结区域。本次 Trail 已经保存了分组名称、来源列表、浏览事件和用户关注过的片段，可作为后续研究资产继续迭代。

## 后续值得继续研究的问题

- 哪些资料是核心来源，哪些只是过渡页面？
- 用户关注过的片段是否已经足够支撑结论？
- 是否需要抓取正文以提高总结质量？
- 这次调研最终支持了什么决策？
`;
}

function copiedEventsToMarkdown(events: TrailEvent[]): string {
  return events
    .filter((event) => (event.type === "text_copied" || event.type === "text_selected") && event.selectedText)
    .map((event, index) => {
      const source = event.url ? `[${event.domain || event.title || "来源"}](${event.url})` : event.domain || event.title || "未知来源";
      const section = event.sectionTitle ? `，位置：${event.sectionTitle}` : "";
      const tags = [
        event.type === "text_copied" ? "状态：已复制" : "状态：仅选中",
        `类型：${copyKindLabel(event.copyKind)}`,
        (event.duplicateCount || 1) > 1 ? `重复复制：${event.duplicateCount} 次` : "",
        event.privacyLevel === "redacted" ? "已自动脱敏" : ""
      ]
        .filter(Boolean)
        .join(" · ");
      const copiedText = blockquote(event.selectedText || "");
      const context = event.surroundingText ? `\n\n上下文：${event.surroundingText}` : "";

      return `### 片段 ${index + 1}

来源：${source}${section}

${tags}

${copiedText}${context}`;
    })
    .join("\n\n");
}

function copyKindLabel(kind: TrailEvent["copyKind"]): string {
  switch (kind) {
    case "code":
      return "代码";
    case "command":
      return "命令";
    case "metric":
      return "指标";
    case "link":
      return "链接";
    case "quote":
      return "引用";
    default:
      return "文本";
  }
}

function blockquote(value: string): string {
  return value
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}
