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
    headers["x-flightpath-token"] = token;
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

export async function workspaceStatus(): Promise<WorkspaceScmStatusResponse> {
  return hostedFetch<WorkspaceScmStatusResponse>(
    "/api/workspace-viewer/status"
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

export async function workspacePush(): Promise<WorkspacePushResponse> {
  return hostedFetch<WorkspacePushResponse>("/api/workspace-viewer/push", {
    method: "POST",
  });
}

export async function workspacePull(): Promise<WorkspacePullResponse> {
  return hostedFetch<WorkspacePullResponse>("/api/workspace-viewer/pull", {
    method: "POST",
  });
}

export async function workspaceGenerateCommitMessage(
  instructions?: string,
  signal?: AbortSignal
): Promise<WorkspaceGenerateCommitMessageResponse> {
  return hostedFetch<WorkspaceGenerateCommitMessageResponse>(
    "/api/workspace-viewer/generate-commit-message",
    {
      method: "POST",
      body: instructions ? JSON.stringify({ instructions }) : undefined,
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
  branchHint?: string
): Promise<WorkspaceCommitLogResponse> {
  const branchParam = branchHint
    ? `&branch=${encodeURIComponent(branchHint)}`
    : "";
  return hostedFetch<WorkspaceCommitLogResponse>(
    `/api/workspace-viewer/commit-log?skip=${skip}&limit=${limit}${branchParam}`
  );
}

export async function workspaceGitRefDiff(
  ref: string
): Promise<WorkspaceGitRefDiffResponse> {
  return hostedFetch<WorkspaceGitRefDiffResponse>(
    `/api/workspace-viewer/git-ref-diff?ref=${encodeURIComponent(ref)}`
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
