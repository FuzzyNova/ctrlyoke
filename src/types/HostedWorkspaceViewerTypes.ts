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
  /** True if this entry is ignored by .gitignore (or is itself an ignored directory). */
  gitIgnored?: boolean;
}

/** Alias kept for API naming consistency — same shape as WorkspaceEntry. */
export type WorkspaceTreeEntry = WorkspaceEntry;

export interface WorkspaceTreeResponse {
  rootLabel: string;
  /** Workspace-relative path (folder-name-prefixed in multi-root, e.g. "root2/src"); "" for the top level. */
  path: string;
  parentPath: string | null;
  entries: WorkspaceTreeEntry[];
  /** Whether the workspace root is inside a git repository. */
  isGitRepo: boolean;
  /**
   * True when `entries` is the virtual top-level listing of every root in a
   * multi-root workspace (one directory entry per root, `path` set to just
   * the root's folder name) rather than a real directory's contents. Clients
   * should disable entry-level file operations (cut/copy/delete/paste) for
   * this listing since each entry represents an entire workspace root.
   */
  isRootsList: boolean;
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
  /**
   * Populated for known image types: a `data:<mime>;base64,…` URI the client
   * renders as an inline `<img>` instead of loading `content` into the text
   * editor. When set, `content` is empty and the file is treated as read-only.
   */
  imageDataUri?: string;
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

/** Kind of git ref that decorates a commit (for git-graph ref pills). */
export type GitRefLabelType = "localBranch" | "remoteBranch" | "tag" | "head";

/** A single ref pointing at a commit, parsed from `git log` decorations. */
export interface GitRefLabel {
  /** Display name, e.g. "main", "origin/main", "v1.0", or "HEAD". */
  name: string;
  type: GitRefLabelType;
}

export interface WorkspaceCommitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  relativeDate: string;
  isHead: boolean;
  pushed: boolean;
  /** Refs (branches, remotes, tags, HEAD) pointing at this commit. */
  refs: GitRefLabel[];
  /** True when the commit has more than one parent (a merge commit). */
  isMerge: boolean;
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

/** Full commit metadata, included when the diffed ref is a single commit. */
export interface WorkspaceCommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  authorEmail: string;
  date: string;
  relativeDate: string;
}

export interface WorkspaceGitRefDiffResponse {
  unifiedDiff: string;
  /** Present only when `ref` resolves to a single commit (not diff/staged/stash). */
  commitInfo?: WorkspaceCommitInfo;
}
