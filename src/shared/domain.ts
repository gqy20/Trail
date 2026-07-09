export function getDomain(url?: string): string {
  if (!url) return "unknown";

  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}
