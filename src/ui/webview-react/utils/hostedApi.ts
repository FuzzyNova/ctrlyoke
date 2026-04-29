import type {
  WorkspaceTreeResponse,
  WorkspaceFileResponse,
  WorkspaceFileSaveRequest,
  WorkspaceScmStatusResponse,
  WorkspaceScmDiffResponse,
  WorkspaceStageRequest,
  WorkspaceUnstageRequest,
  WorkspaceCommitRequest,
  WorkspacePushResponse,
  WorkspacePullResponse,
} from "@root/types/HostedWorkspaceViewerTypes";

const token = new URLSearchParams(window.location.search).get("token") ?? "";

export async function hostedFetch<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = `${path}${path.includes("?") ? "&" : "?"}token=${token}`;
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
  if (method === "PUT" || method === "POST") {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, { ...options, headers });
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

export async function workspaceStage(req: WorkspaceStageRequest): Promise<void> {
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
