/**
 * Types for the hosted workspace viewer feature.
 *
 * Shared between the server (extension-side) and the React webview (browser-side).
 */

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
}

/** Alias kept for API naming consistency — same shape as WorkspaceEntry. */
export type WorkspaceTreeEntry = WorkspaceEntry;

export interface WorkspaceTreeResponse {
  rootLabel: string;
  /** Workspace-relative path; "" for root */
  path: string;
  parentPath: string | null;
  entries: WorkspaceTreeEntry[];
}

export interface WorkspaceFileResponse {
  path: string;
  name: string;
  language?: string;
  size: number;
  eol: "lf" | "crlf";
  content: string;
  readOnly?: boolean;
  reason?: string;
}

export interface WorkspaceFileSaveRequest {
  path: string;
  content: string;
}

export interface SourceControlFile {
  path: string;
  stagedStatus: string | null;
  unstagedStatus: string | null;
  kind: "modified" | "added" | "deleted" | "renamed" | "untracked";
}

/** Alias kept for API naming consistency — same shape as SourceControlFile. */
export type WorkspaceScmFile = SourceControlFile;

export interface WorkspaceScmStatusResponse {
  files: WorkspaceScmFile[];
}

export type DiffKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked";

export interface WorkspaceScmDiffResponse {
  path: string;
  language?: string;
  oldContent: string;
  newContent: string;
  kind: DiffKind;
}

export interface WorkspaceStageRequest {
  path: string;
}

export interface WorkspaceUnstageRequest {
  path: string;
}

export interface WorkspaceCommitRequest {
  message: string;
}

export interface WorkspacePushResponse {
  branch: string;
  remote: string;
}

export interface WorkspacePullResponse {
  branch: string;
  remote: string;
}
