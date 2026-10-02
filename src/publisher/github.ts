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
  return fetch(path.startsWith("https://") ? path : `${GITHUB_API}${path}`, {
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
  const payload = (await response.json()) as { content?: string; sha?: string; encoding?: string; size?: number; git_url?: string };
  if (typeof payload.sha !== "string") {
    throw new Error("GitHub 返回的文件内容格式不正确。");
  }
  // 超过 1MB 的文件，Contents API 只返回元数据（content 为空、encoding 为 none）；
  // 此时改走 Git Blob API 取完整内容（base64，上限 100MB）。
  if (payload.encoding === "base64" && typeof payload.content === "string" && payload.content.length > 0) {
    return { content: fromBase64Utf8(payload.content), sha: payload.sha };
  }
  if ((payload.size ?? 0) === 0) return { content: "", sha: payload.sha };
  if (typeof payload.git_url !== "string") {
    throw new Error(`GitHub 未返回 ${path} 的内容（文件可能超过 1MB），无法读取远端数据。`);
  }
  const blobResponse = await githubFetch(payload.git_url, target.token);
  if (!blobResponse.ok) throw new Error(await describeError(blobResponse));
  const blob = (await blobResponse.json()) as { content?: string; encoding?: string };
  if (blob.encoding !== "base64" || typeof blob.content !== "string") {
    throw new Error(`GitHub Blob API 未返回 ${path} 的 base64 内容。`);
  }
  return { content: fromBase64Utf8(blob.content), sha: payload.sha };
}

/** 单提交发布：Git Data API 把全部文件打包为一次 commit，替代逐文件 PUT。 */
export async function commitGitHubFiles(
  target: RepoTarget,
  files: Array<{ path: string; content: string }>,
  message: string
): Promise<string> {
  // 1. 读分支头提交与其树（base_tree 保证未列出的文件原样保留）
  const refResponse = await githubFetch(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/git/ref/heads/${encodeURIComponent(target.branch)}`,
    target.token
  );
  if (!refResponse.ok) throw new Error(await describeError(refResponse));
  const ref = (await refResponse.json()) as { object?: { sha?: string } };
  const parentSha = ref.object?.sha;
  if (!parentSha) throw new Error("无法读取分支头提交（仓库可能为空）。");
  const commitResponse = await githubFetch(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/git/commits/${parentSha}`,
    target.token
  );
  if (!commitResponse.ok) throw new Error(await describeError(commitResponse));
  const parentCommit = (await commitResponse.json()) as { tree?: { sha?: string } };
  const baseTree = parentCommit.tree?.sha;
  if (!baseTree) throw new Error("无法读取分支头提交的树。");

  // 2. 逐文件建 blob（只创建对象，不产生提交）
  const tree: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
  for (const file of files) {
    const blobResponse = await githubFetch(
      `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/git/blobs`,
      target.token,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: toBase64Utf8(file.content), encoding: "base64" })
      }
    );
    if (!blobResponse.ok) throw new Error(await describeError(blobResponse));
    const blob = (await blobResponse.json()) as { sha?: string };
    if (!blob.sha) throw new Error(`创建 blob 失败：${file.path}`);
    tree.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  // 3. 建树 → 提交 → 更新引用（不加 force，被并发移动时 409 报错重试）
  const treeResponse = await githubFetch(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/git/trees`,
    target.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ base_tree: baseTree, tree })
    }
  );
  if (!treeResponse.ok) throw new Error(await describeError(treeResponse));
  const newTree = (await treeResponse.json()) as { sha?: string };
  if (!newTree.sha) throw new Error("创建树失败。");

  const commitCreated = await githubFetch(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/git/commits`,
    target.token,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, tree: newTree.sha, parents: [parentSha] })
    }
  );
  if (!commitCreated.ok) throw new Error(await describeError(commitCreated));
  const newCommit = (await commitCreated.json()) as { sha?: string };
  if (!newCommit.sha) throw new Error("创建提交失败。");

  const refUpdate = await githubFetch(
    `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/git/refs/heads/${encodeURIComponent(target.branch)}`,
    target.token,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: newCommit.sha })
    }
  );
  if (!refUpdate.ok) throw new Error(await describeError(refUpdate));
  return newCommit.sha;
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
