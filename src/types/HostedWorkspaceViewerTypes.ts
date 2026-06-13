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
  incomingCommitCount: number;
  outgoingCommitCount: number;
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

export interface WorkspaceDiscardRequest {
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

export interface WorkspaceGenerateCommitMessageResponse {
  message: string;
  staged: boolean;
  truncated: boolean;
}

export interface WorkspaceDeleteRequest {
  path: string;
}

export interface WorkspaceCopyRequest {
  /** Workspace-relative source path */
  sourcePath: string;
  /** Workspace-relative destination DIRECTORY path (not the full dest path) */
  destDir: string;
  /** Optional new name for the copy; defaults to source basename */
  newName?: string;
}

export interface WorkspaceMoveRequest {
  /** Workspace-relative source path */
  sourcePath: string;
  /** Workspace-relative destination DIRECTORY path */
  destDir: string;
  /** Optional new name at destination; defaults to source basename */
  newName?: string;
}

// ── Commit history ────────────────────────────────────────────────────────────

export interface WorkspaceCommitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  relativeDate: string;
  isHead: boolean;
  pushed: boolean;
}

export interface WorkspaceCommitLogResponse {
  commits: WorkspaceCommitLogEntry[];
  hasMore: boolean;
  /** null when in detached HEAD state */
  currentBranch: string | null;
  detached: boolean;
}

export interface WorkspaceCheckoutCommitRequest {
  hash: string;
}

export interface WorkspaceCheckoutBranchRequest {
  branch: string;
}

// ── Git ref diff ──────────────────────────────────────────────────────────────

export interface WorkspaceGitRefDiffResponse {
  unifiedDiff: string;
}
