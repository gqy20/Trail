/**
 * 扩展页面里的文件下载：优先走 chrome.downloads API——
 * 侧边栏（side panel）里 <a download> 点击不触发下载，而 API 在侧边栏可用。
 * API 不可用或失败时回退到 anchor 点击（普通标签页路径，Playwright 测试依赖它）。
 */
export function downloadFile(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const revoke = () => window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  if (typeof chrome !== "undefined" && chrome.downloads?.download) {
    chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
      if (chrome.runtime.lastError || !downloadId) {
        triggerAnchorDownload(url, filename);
      }
      revoke();
    });
    return;
  }
  triggerAnchorDownload(url, filename);
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
