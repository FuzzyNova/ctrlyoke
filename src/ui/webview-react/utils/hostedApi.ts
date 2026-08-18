import type {
  WorkspaceTreeResponse,
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
  WorkspaceCheckoutCommitRequest,
  WorkspaceCheckoutBranchRequest,
  WorkspaceGitRefDiffResponse,
  WorkspaceReposResponse,
} from "@root/types/HostedWorkspaceViewerTypes";

const token = new URLSearchParams(window.location.search).get("token") ?? "";

export async function hostedFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const method = options?.method?.toUpperCase();
  const headers: Record<string, string> = {};
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
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  const text = await response.text();
  if (!text.trim()) {
    return undefined as unknown as T;
  }
  return JSON.parse(text) as T;
}

export async function workspaceTree(
  dirPath: string
): Promise<WorkspaceTreeResponse> {
  return hostedFetch<WorkspaceTreeResponse>(
    `/api/workspace-viewer/tree?path=${encodeURIComponent(dirPath)}`
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
): Promise<void> {
  return hostedFetch<void>("/api/workspace-viewer/file", {
    method: "PUT",
    body: JSON.stringify(req),
  });
}

export async function workspaceRepos(): Promise<WorkspaceReposResponse> {
  return hostedFetch<WorkspaceReposResponse>("/api/workspace-viewer/repos");
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
  repo?: string
): Promise<WorkspaceCommitLogResponse> {
  const branchParam = branchHint
    ? `&branch=${encodeURIComponent(branchHint)}`
    : "";
  const repoParam = repo ? `&repo=${encodeURIComponent(repo)}` : "";
  return hostedFetch<WorkspaceCommitLogResponse>(
    `/api/workspace-viewer/commit-log?skip=${skip}&limit=${limit}${branchParam}${repoParam}`
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
