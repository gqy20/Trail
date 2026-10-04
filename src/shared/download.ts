/**
 * 扩展页面里的文件下载：侧边栏（side panel）中 <a download> 点击不触发下载，
 * 必须走 chrome.downloads API；普通标签页走 anchor——下载事件的"建议文件名"
 * 来自 anchor 的 download 属性，API 路径拿不到这个名字。
 * 检测当前是否存在 side panel 上下文来选路径；API 失败时也回退 anchor。
 */
export async function downloadFile(filename: string, blob: Blob): Promise<void> {
  const url = URL.createObjectURL(blob);
  const revoke = () => window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  if (await isInSidePanel()) {
    if (chrome.downloads?.download) {
      chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
        if (chrome.runtime.lastError || !downloadId) triggerAnchorDownload(url, filename);
        revoke();
      });
      return;
    }
  }
  triggerAnchorDownload(url, filename);
  revoke();
}

async function isInSidePanel(): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.runtime?.getContexts) return false;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL" as chrome.runtime.ContextType] });
    return (contexts?.length || 0) > 0;
  } catch {
    return false;
  }
}

function triggerAnchorDownload(url: string, filename: string): void {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  window.setTimeout(() => anchor.remove(), 1_000);
}
