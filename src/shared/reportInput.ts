import type {
  ResearchReportClipInput,
  ResearchReportClickInput,
  ResearchReportInput,
  ResearchReportSourceInput,
  TrailEvent,
  TrailPageStat,
  TrailSession
} from "./types";

const MAX_CLIPS = 40;
const MAX_CLICKS = 24;
const MAX_TEXT_LENGTH = 1200;
const MAX_CONTEXT_LENGTH = 800;

export function buildResearchReportInput(session: TrailSession): ResearchReportInput {
  const sourceRecords = buildSourceRecords(session);
  const sourceIdByUrl = new Map(sourceRecords.map((source) => [source.url, source.id]));
  const clips = buildClipRecords(session.events, sourceIdByUrl);
  const clickPath = buildClickRecords(session.events, sourceIdByUrl);

  return {
    schemaVersion: 1,
    sessionId: session.id,
    title: session.name.trim() || session.groupTitle || "未命名研究记录",
    goal: cleanOptional(session.goal),
    source: session.source,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    generatedAt: Date.now(),
    summary: {
      sourceCount: sourceRecords.length,
      clipCount: clips.length,
      copiedClipCount: clips.filter((clip) => clip.status === "copied").length,
      selectedClipCount: clips.filter((clip) => clip.status === "selected").length,
      clickCount: clickPath.length
    },
    sources: sourceRecords,
    clips,
    clickPath
  };
}

function buildSourceRecords(session: TrailSession): ResearchReportSourceInput[] {
  const statByUrl = new Map((session.pageStats || []).map((stat) => [stat.url, stat]));
  const seen = new Set<string>();

  return session.tabs
    .filter((tab) => {
      if (seen.has(tab.url)) return false;
      seen.add(tab.url);
      return true;
    })
    .map((tab, index) => {
      const stat = statByUrl.get(tab.url);
      return {
        id: `source_${index + 1}`,
        title: tab.title || tab.domain || tab.url,
        url: tab.url,
        domain: tab.domain,
        level: stat?.level || "passing",
        activeMs: stat?.activeMs || 0,
        visitCount: stat?.visitCount || 1,
        selectedCount: stat?.selectedCount || 0,
        copiedCount: stat?.copiedCount || 0,
        outboundClickCount: stat?.outboundClickCount || 0
      };
    });
}

function buildClipRecords(events: TrailEvent[], sourceIdByUrl: Map<string, string>): ResearchReportClipInput[] {
  return events
    .filter((event) => (event.type === "text_copied" || event.type === "text_selected") && event.selectedText)
    .slice(-MAX_CLIPS)
    .map((event, index) => ({
      id: `clip_${index + 1}`,
      status: event.type === "text_copied" ? "copied" : "selected",
      kind: event.copyKind || "text",
      text: clampText(event.selectedText || "", MAX_TEXT_LENGTH),
      context: cleanOptional(clampText(event.surroundingText || "", MAX_CONTEXT_LENGTH)),
      sourceId: event.url ? sourceIdByUrl.get(event.url) : undefined,
      sourceUrl: event.url,
      domain: event.domain,
      sectionTitle: cleanOptional(event.sectionTitle),
      privacyLevel: event.privacyLevel,
      capturedAt: event.timestamp
    }));
}

function buildClickRecords(events: TrailEvent[], sourceIdByUrl: Map<string, string>): ResearchReportClickInput[] {
  return events
    .filter((event) => event.type === "link_clicked" && event.targetUrl)
    .slice(-MAX_CLICKS)
    .map((event, index) => ({
      id: `path_${index + 1}`,
      sourceId: event.url ? sourceIdByUrl.get(event.url) : undefined,
      sourceUrl: event.url,
      sourceDomain: event.domain,
      targetUrl: event.targetUrl || "",
      targetDomain: event.targetDomain,
      targetText: cleanOptional(event.targetText),
      kind: event.linkKind || "external",
      clickedAt: event.timestamp
    }));
}

function clampText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength).trimEnd()}...` : normalized;
}

function cleanOptional(value: string | undefined): string | undefined {
  const next = value?.trim();
  return next ? next : undefined;
}
