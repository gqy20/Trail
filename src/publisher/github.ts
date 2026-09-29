import type { FeedPublisherConfig, FeedRepoProbe } from "./types";

const GITHUB_API = "https://api.github.com";

type RepoTarget = Pick<FeedPublisherConfig, "owner" | "repo" | "branch" | "token">;

export type GitHubContent = { content: string; sha: string };

export function toBase64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function fromBase64Utf8(base64: string): string {
  const binary = atob(base64.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function githubFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.headers as Record<string, string> | undefined)
    }
  });
}

async function describeError(response: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await response.json()) as { message?: string };
    if (body.message) detail = `：${body.message}`;
  } catch {
    // 非 JSON 响应时只报告状态码。
  }
  if (response.status === 401) return `GitHub 认证失败，请检查 token${detail}`;
  if (response.status === 404) return `GitHub 上没有找到目标文件或仓库${detail}`;
  if (response.status === 409) return `GitHub 文件在读取后被其他提交更新，本轮放弃，下一轮重试${detail}`;
  return `GitHub API ${response.status}${detail}`;
}

/** 读取仓库文件；文件不存在时返回 null。 */
export async function fetchGitHubContent(target: RepoTarget, path: string): Promise<GitHubContent | null> {
  const query = `?ref=${encodeURIComponent(target.branch)}`;
  const response = await githubFetch(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${encodePath(path)}${query}`,
    target.token
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(await describeError(response));
  const payload = (await response.json()) as { content?: string; sha?: string; encoding?: string };
  if (typeof payload.content !== "string" || typeof payload.sha !== "string") {
    throw new Error("GitHub 返回的文件内容格式不正确。");
  }
  return { content: fromBase64Utf8(payload.content), sha: payload.sha };
}

/** 创建或更新仓库文件，返回提交 SHA。sha 为空表示新建。 */
export async function putGitHubContent(
  target: RepoTarget,
  path: string,
  content: string,
  message: string,
  sha?: string
): Promise<string> {
  const response = await githubFetch(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/contents/${encodePath(path)}`,
    target.token,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        branch: target.branch,
        content: toBase64Utf8(content),
        ...(sha ? { sha } : {})
      })
    }
  );
  if (!response.ok) throw new Error(await describeError(response));
  const payload = (await response.json()) as { commit?: { sha?: string } };
  return payload.commit?.sha || "";
}

/** 校验 token 与仓库可访问性，供设置页“测试连接”。 */
export async function probeGitHubRepo(target: RepoTarget): Promise<FeedRepoProbe> {
  const response = await githubFetch(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`,
    target.token
  );
  if (!response.ok) throw new Error(await describeError(response));
  const payload = (await response.json()) as { private?: boolean; default_branch?: string };
  return { repoPrivate: Boolean(payload.private), defaultBranch: payload.default_branch || "main" };
}
