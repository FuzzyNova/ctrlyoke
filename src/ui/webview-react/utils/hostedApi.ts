import { WORKSPACE_FILE_HISTORY_DEFAULT_PAGE_SIZE } from "@root/types/HostedWorkspaceViewerTypes";
import type {
  WorkspaceTreePageRequest,
  WorkspaceTreeRangeRequest,
  WorkspaceTreePageResponse,
  WorkspaceFileResponse,
  WorkspaceFileSaveRequest,
  WorkspaceScmStatusResponse,
  WorkspaceScmDiffResponse,
  WorkspaceStageRequest,
  WorkspaceUnstageRequest,
  WorkspaceDiscardRequest,
  WorkspaceCommitRequest,
  WorkspacePushResponse,
  WorkspacePullResponse,
  WorkspaceGenerateCommitMessageResponse,
  WorkspaceDeleteRequest,
  WorkspaceCopyRequest,
  WorkspaceMoveRequest,
  WorkspaceCommitLogResponse,
  WorkspaceFileHistoryPageResponse,
  WorkspaceFileHistoryDiffResponse,
  WorkspaceGitRefDiffPageResponse,
  WorkspaceCheckoutCommitRequest,
  WorkspaceCheckoutBranchRequest,
  WorkspaceGitRefDiffResponse,
  WorkspaceReposResponse,
  WorkspaceSearchRequest,
  WorkspaceSearchResponse,
} from "@root/types/HostedWorkspaceViewerTypes";
import { WORKSPACE_GIT_REF_DIFF_DEFAULT_PAGE_SIZE } from "@root/types/HostedWorkspaceViewerTypes";

export class HostedHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "HostedHttpError";
  }
}

const token = new URLSearchParams(window.location.search).get("token") ?? "";

export async function hostedFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const method = options?.method?.toUpperCase();
  const headers: Record<string, string> = {};
  const clientId = (window as Window & { __CTRLYOKE_CLIENT_ID__?: string })
    .__CTRLYOKE_CLIENT_ID__;
  if (clientId) headers["x-ctrlyoke-client-id"] = clientId;
  if (options?.headers) {
    const existing = options.headers;
    if (existing instanceof Headers) {
      existing.forEach((v, k) => {
        headers[k] = v;
      });
    } else if (Array.isArray(existing)) {
      for (const [k, v] of existing) {
        headers[k] = v;
      }
    } else {
      Object.assign(headers, existing);
    }
  }
  if (token) {
    headers["x-ctrlyoke-token"] = token;
  }
  if (method === "PUT" || method === "POST") {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    const text = await response.text();
    throw new HostedHttpError(
      response.status,
      `HTTP ${response.status}: ${text}`
    );
  }

  const text = await response.text();
  if (!text.trim()) {
    return undefined as unknown as T;
  }
  return JSON.parse(text) as T;
}

export async function workspaceTree(
  request: WorkspaceTreePageRequest | WorkspaceTreeRangeRequest,
  signal?: AbortSignal
): Promise<WorkspaceTreePageResponse> {
  const params = new URLSearchParams();
  if ("listingId" in request) {
    params.set("listingId", request.listingId);
    params.set("offset", String(request.offset));
  } else {
    params.set("path", request.path);
    params.set("includeGitIgnored", String(request.includeGitIgnored));
    if (request.pageSize !== undefined) {
      params.set("pageSize", String(request.pageSize));
    }
    if (request.anchorPath !== undefined) {
      params.set("anchorPath", request.anchorPath);
    }
    if (request.sort !== undefined) {
      params.set("sortKey", request.sort.key);
      params.set("sortDirection", request.sort.direction);
    }
  }
  return hostedFetch<WorkspaceTreePageResponse>(
    `/api/workspace-viewer/tree?${params.toString()}`,
    { signal }
  );
}

export async function workspaceFile(
  filePath: string
): Promise<WorkspaceFileResponse> {
  return hostedFetch<WorkspaceFileResponse>(
    `/api/workspace-viewer/file?path=${encodeURIComponent(filePath)}`
  );
}

export async function workspaceSaveFile(
  req: WorkspaceFileSaveRequest
): Promise<{ modifiedAt: number }> {
  return hostedFetch<{ modifiedAt: number }>("/api/workspace-viewer/file", {
    method: "PUT",
    body: JSON.stringify(req),
  });
}

export async function workspaceFileWatch(path: string | null): Promise<void> {
  return hostedFetch<void>("/api/workspace-viewer/file/watch", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export async function workspaceRepos(): Promise<WorkspaceReposResponse> {
  return hostedFetch<WorkspaceReposResponse>("/api/workspace-viewer/repos");
}

export async function workspaceSearch(
  req: WorkspaceSearchRequest
): Promise<WorkspaceSearchResponse> {
  const params = new URLSearchParams({ query: req.query, scope: req.scope });
  if (req.includeGitIgnored) params.set("includeGitIgnored", "true");
  if (req.repo) params.set("repo", req.repo);
  if (req.limit) params.set("limit", String(req.limit));
  return hostedFetch<WorkspaceSearchResponse>(
    `/api/workspace-viewer/search?${params.toString()}`
  );
}

/**
 * SCM status. Omit `repo` for the aggregate across every repo (used by the
 * explorer to color files across all roots); pass a repo id to scope to a
 * single repo (used by the SCM pane's repo selector).
 */
export async function workspaceStatus(
  repo?: string
): Promise<WorkspaceScmStatusResponse> {
  const query = repo ? `?repo=${encodeURIComponent(repo)}` : "";
  return hostedFetch<WorkspaceScmStatusResponse>(
    `/api/workspace-viewer/status${query}`
  );
}

export async function workspaceDiff(
  filePath: string
): Promise<WorkspaceScmDiffResponse> {
  return hostedFetch<WorkspaceScmDiffResponse>(
    `/api/workspace-viewer/diff?path=${encodeURIComponent(filePath)}`
  );
}

export async function workspaceStage(
  req: WorkspaceStageRequest
): Promise<void> {
  return hostedFetch<void>("/api/workspace-viewer/stage", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function workspaceUnstage(
  req: WorkspaceUnstageRequest
): Promise<void> {
  return hostedFetch<void>("/api/workspace-viewer/unstage", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function workspaceDiscard(
  req: WorkspaceDiscardRequest
): Promise<void> {
  return hostedFetch<void>("/api/workspace-viewer/discard", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function workspaceCommit(
  req: WorkspaceCommitRequest
): Promise<void> {
  return hostedFetch<void>("/api/workspace-viewer/commit", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function workspacePush(
  repo?: string
): Promise<WorkspacePushResponse> {
  return hostedFetch<WorkspacePushResponse>("/api/workspace-viewer/push", {
    method: "POST",
    body: repo ? JSON.stringify({ repo }) : undefined,
  });
}

export async function workspacePull(
  repo?: string
): Promise<WorkspacePullResponse> {
  return hostedFetch<WorkspacePullResponse>("/api/workspace-viewer/pull", {
    method: "POST",
    body: repo ? JSON.stringify({ repo }) : undefined,
  });
}

export async function workspaceGenerateCommitMessage(
  instructions?: string,
  signal?: AbortSignal,
  repo?: string
): Promise<WorkspaceGenerateCommitMessageResponse> {
  const payload: { instructions?: string; repo?: string } = {};
  if (instructions) payload.instructions = instructions;
  if (repo) payload.repo = repo;
  const body = Object.keys(payload).length
    ? JSON.stringify(payload)
    : undefined;
  return hostedFetch<WorkspaceGenerateCommitMessageResponse>(
    "/api/workspace-viewer/generate-commit-message",
    {
      method: "POST",
      body,
      signal,
    }
  );
}

export async function workspaceDeleteEntry(
  req: WorkspaceDeleteRequest
): Promise<void> {
  return hostedFetch<void>(
    `/api/workspace-viewer/entry?path=${encodeURIComponent(req.path)}`,
    { method: "DELETE" }
  );
}

export async function workspaceCopyEntry(
  req: WorkspaceCopyRequest
): Promise<void> {
  return hostedFetch<void>("/api/workspace-viewer/copy", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function workspaceMoveEntry(
  req: WorkspaceMoveRequest
): Promise<void> {
  return hostedFetch<void>("/api/workspace-viewer/move", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export async function workspaceCommitLog(
  skip = 0,
  limit = 30,
  branchHint?: string,
  repo?: string,
  historyId?: string
): Promise<WorkspaceCommitLogResponse> {
  const branchParam = branchHint
    ? `&branch=${encodeURIComponent(branchHint)}`
    : "";
  const repoParam = repo ? `&repo=${encodeURIComponent(repo)}` : "";
  const historyParam = historyId
    ? `&historyId=${encodeURIComponent(historyId)}`
    : "";
  return hostedFetch<WorkspaceCommitLogResponse>(
    `/api/workspace-viewer/commit-log?skip=${skip}&limit=${limit}${branchParam}${repoParam}${historyParam}`
  );
}

export async function workspaceFileHistory(
  filePath: string,
  offset = 0,
  pageSize = WORKSPACE_FILE_HISTORY_DEFAULT_PAGE_SIZE,
  historyId?: string,
  repo?: string
): Promise<WorkspaceFileHistoryPageResponse> {
  const params = new URLSearchParams({
    path: filePath,
    offset: String(offset),
  });
  if (historyId) {
    params.set("historyId", historyId);
  } else {
    params.set("pageSize", String(pageSize));
  }
  if (repo) params.set("repo", repo);
  return hostedFetch<WorkspaceFileHistoryPageResponse>(
    `/api/workspace-viewer/file-history?${params.toString()}`
  );
}

export async function workspaceFileHistoryDiff(
  filePath: string,
  commit: string,
  repo?: string
): Promise<WorkspaceFileHistoryDiffResponse> {
  const params = new URLSearchParams({
    path: filePath,
    commit,
  });
  if (repo) params.set("repo", repo);
  return hostedFetch<WorkspaceFileHistoryDiffResponse>(
    `/api/workspace-viewer/file-history-diff?${params.toString()}`
  );
}

export async function workspaceGitRefDiffPage(
  ref: string,
  offset = 0,
  pageSize = WORKSPACE_GIT_REF_DIFF_DEFAULT_PAGE_SIZE,
  diffId?: string,
  repo?: string
): Promise<WorkspaceGitRefDiffPageResponse> {
  const params = new URLSearchParams({
    ref,
    offset: String(offset),
  });
  if (diffId) {
    params.set("diffId", diffId);
  } else {
    params.set("pageSize", String(pageSize));
  }
  if (repo) params.set("repo", repo);
  return hostedFetch<WorkspaceGitRefDiffPageResponse>(
    `/api/workspace-viewer/git-ref-diff-page?${params.toString()}`
  );
}

export async function workspaceGitRefDiff(
  ref: string,
  repo?: string
): Promise<WorkspaceGitRefDiffResponse> {
  const repoParam = repo ? `&repo=${encodeURIComponent(repo)}` : "";
  return hostedFetch<WorkspaceGitRefDiffResponse>(
    `/api/workspace-viewer/git-ref-diff?ref=${encodeURIComponent(ref)}${repoParam}`
  );
}

/** Diff a recorded worktree run's branch against its recorded base commit. */
export async function workspaceWorktreeDiff(
  sourceCheckoutRoot: string,
  baseCommit: string,
  branchName: string
): Promise<WorkspaceGitRefDiffResponse> {
  const params = new URLSearchParams({
    sourceCheckoutRoot,
    baseCommit,
    branchName,
  });
  return hostedFetch<WorkspaceGitRefDiffResponse>(
    `/api/workspace-viewer/worktree-diff?${params.toString()}`
  );
}

export async function workspaceCheckoutCommit(
  req: WorkspaceCheckoutCommitRequest
): Promise<{ detached: boolean }> {
  return hostedFetch<{ detached: boolean }>(
    "/api/workspace-viewer/checkout-commit",
    { method: "POST", body: JSON.stringify(req) }
  );
}

export async function workspaceCheckoutBranch(
  req: WorkspaceCheckoutBranchRequest
): Promise<{ branch: string }> {
  return hostedFetch<{ branch: string }>(
    "/api/workspace-viewer/checkout-branch",
    { method: "POST", body: JSON.stringify(req) }
  );
}
