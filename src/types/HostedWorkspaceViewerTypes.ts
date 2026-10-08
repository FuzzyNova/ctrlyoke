import {
  DIFF_PAYLOAD_KINDS,
  GIT_REF_LABEL_TYPES,
  WORKSPACE_ENTRY_KINDS,
  LSP_SESSION_LOOKUP_REASONS,
  type WorkspaceSearchScope,
  type DiffChangeType,
  type DiffPayloadKind,
  type ScmFileKind,
  type WorkspaceFileTreeEntryKind,
} from "./DashboardConstants";

/** Browser-safe URI prefix used to represent workspace-relative LSP documents. */
export const LSP_VIEWER_URI_PREFIX = "file:///__ctrlyoke_workspace__/";

export type { WorkspaceSearchScope } from "./DashboardConstants";

export interface LanguageIntelligenceSessionLookupResponse {
  session: {
    id: string;
    languageId: string;
    capabilities: Record<string, unknown>;
  } | null;
  reason?: (typeof LSP_SESSION_LOOKUP_REASONS)[keyof typeof LSP_SESSION_LOOKUP_REASONS];
}

/**
 * Types for the hosted workspace viewer feature.
 *
 * Shared between the server (extension-side) and the React webview (browser-side).
 */

export interface WorkspaceEntry {
  name: string;
  path: string;
  kind: WorkspaceFileTreeEntryKind;
  size?: number;
  /** Last filesystem modification time in epoch milliseconds. */
  modifiedAt?: number;
  /** True if this entry is ignored by .gitignore (or is itself an ignored directory). */
  gitIgnored?: boolean;
}

/** Alias kept for API naming consistency — same shape as WorkspaceEntry. */
export type WorkspaceTreeEntry = WorkspaceEntry;

/** Default and supported bounds for the paged directory API. */
export const WORKSPACE_TREE_DEFAULT_PAGE_SIZE = 250;
export const WORKSPACE_TREE_MIN_PAGE_SIZE = 1;
export const WORKSPACE_TREE_MAX_PAGE_SIZE = 500;

/** Canonical sort keys for workspace directory entries. */
export const WORKSPACE_ENTRY_SORT_KEYS = {
  NAME: "name",
  MODIFIED_AT: "modifiedAt",
} as const;

export type WorkspaceEntrySortKey =
  (typeof WORKSPACE_ENTRY_SORT_KEYS)[keyof typeof WORKSPACE_ENTRY_SORT_KEYS];

/** Canonical sort directions for workspace directory entries. */
export const WORKSPACE_ENTRY_SORT_DIRECTIONS = {
  ASCENDING: "ascending",
  DESCENDING: "descending",
} as const;

export type WorkspaceEntrySortDirection =
  (typeof WORKSPACE_ENTRY_SORT_DIRECTIONS)[keyof typeof WORKSPACE_ENTRY_SORT_DIRECTIONS];

export interface WorkspaceEntrySort {
  readonly key: WorkspaceEntrySortKey;
  readonly direction: WorkspaceEntrySortDirection;
}

/** Stable default used when an initial listing omits its sort selection. */
export const DEFAULT_WORKSPACE_ENTRY_SORT = Object.freeze({
  key: WORKSPACE_ENTRY_SORT_KEYS.NAME,
  direction: WORKSPACE_ENTRY_SORT_DIRECTIONS.ASCENDING,
}) satisfies WorkspaceEntrySort;

/** Initial request for a workspace directory listing snapshot. */
export interface WorkspaceTreePageRequest {
  path: string;
  pageSize?: number;
  includeGitIgnored: boolean;
  anchorPath?: string;
  sort?: WorkspaceEntrySort;
}

/** Random-access request for a page in an existing immutable listing. */
export interface WorkspaceTreeRangeRequest {
  listingId: string;
  offset: number;
}

/** A page from an immutable workspace directory listing snapshot. */
export interface WorkspaceTreePageResponse {
  listingId: string;
  /** Server-clamped size fixed when the listing snapshot was created. */
  pageSize: number;
  rootLabel: string;
  /** Workspace-relative path, or the empty path for the virtual roots list. */
  path: string;
  parentPath: string | null;
  isGitRepo: boolean;
  isRootsList: boolean;
  /** Number of entries in the filtered snapshot, not just this page. */
  totalEntries: number;
  /** Virtual index of the first entry in `entries`. */
  offset: number;
  entries: WorkspaceTreeEntry[];
}

export interface WorkspaceFileResponse {
  path: string;
  name: string;
  language?: string;
  size: number;
  eol: "lf" | "crlf";
  content: string;
  /** Last filesystem modification time in epoch milliseconds. */
  modifiedAt?: number;
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
  /** Disk version the editor loaded, or null when creating a new file. */
  baseModifiedAt: number | null;
}

export interface WorkspaceFileChangedMessage {
  path: string;
  modifiedAt?: number;
  /** Browser client that made the save; absent for external filesystem changes. */
  clientId?: string;
}

/**
 * A distinct git repository discovered within the workspace. In a multi-root
 * workspace whose roots span several repos, there is one entry per repo (roots
 * that share a repo collapse to one). `id` is a stable, unique key the UI passes
 * back to scope repo-specific SCM operations; `rootPath` is the repo's git
 * toplevel and stays server-side (never used as a client-facing viewer path).
 */
export interface WorkspaceRepo {
  /** Stable, unique key used by the UI selector and repo-scoped API calls. */
  id: string;
  /** Human-readable name shown in the repo selector (root/folder name). */
  label: string;
  /** Absolute git toplevel path. Server-side only. */
  rootPath: string;
}

export interface WorkspaceReposResponse {
  repos: WorkspaceRepo[];
  /**
   * Authoritative map from a viewer-path folder-name prefix (a workspace
   * root's name, the first segment of a multi-root viewer path) to the id of
   * the repo that owns it. The server computes this from the actual roots →
   * repo containment, so the client never has to reverse-engineer it from
   * `label`/`id` — those diverge from the prefix when a root sits below its git
   * toplevel, and several roots can share one repo. Empty in single-root
   * (viewer paths are unprefixed and the selector stays hidden).
   */
  prefixRepoIds: Record<string, string>;
}

export interface WorkspaceSearchRequest {
  query: string;
  scope: WorkspaceSearchScope;
  includeGitIgnored?: boolean;
  repo?: string;
  limit?: number; // results cap; re-issued with a higher limit for "Load more"
}

export interface WorkspaceSearchFileMatch {
  kind: typeof WORKSPACE_ENTRY_KINDS.FILE;
  /** Viewer path: plain workspace-relative single-root, folder-name-prefixed
   *  (`root2/src/index.ts`) multi-root — the same convention every other
   *  `HostedWorkspaceViewerTypes` path uses, and what `openToFile()` expects.
   *  (Corrected 2026-08-19; always build it with `toViewerPath`.) */
  path: string;
  name: string;
}

export interface WorkspaceSearchContentMatch {
  kind: typeof WORKSPACE_ENTRY_KINDS.CONTENT;
  path: string;
  line: number; // 1-based
  matchSnippet: string; // the matching line, trimmed/truncated
}

export type WorkspaceSearchResult =
  WorkspaceSearchFileMatch | WorkspaceSearchContentMatch;

export interface WorkspaceSearchResponse {
  results: WorkspaceSearchResult[];
  truncated: boolean; // true if the scan hit its file/time budget before finishing
}

export interface SourceControlFile {
  path: string;
  stagedStatus: string | null;
  unstagedStatus: string | null;
  kind: ScmFileKind;
}

/** Alias kept for API naming consistency — same shape as SourceControlFile. */
export type WorkspaceScmFile = SourceControlFile;

export interface WorkspaceScmStatusResponse {
  files: WorkspaceScmFile[];
  incomingCommitCount: number;
  outgoingCommitCount: number;
}

export type DiffKind = ScmFileKind;

export interface WorkspaceImageDiffSides {
  oldImageDataUri?: string;
  newImageDataUri?: string;
}

export interface WorkspaceDiffEntry {
  path: string;
  oldPath?: string;
  changeType: DiffChangeType;
  payloadKind: DiffPayloadKind;
  image?: WorkspaceImageDiffSides;
}

interface WorkspaceScmDiffBase {
  path: string;
  kind: DiffKind;
}

export type WorkspaceDiffPayload =
  | {
      payloadKind: typeof DIFF_PAYLOAD_KINDS.TEXT;
      language?: string;
      oldContent: string;
      newContent: string;
    }
  | {
      payloadKind: typeof DIFF_PAYLOAD_KINDS.IMAGE;
      language?: never;
      oldContent?: never;
      newContent?: never;
      image: WorkspaceImageDiffSides;
    }
  | {
      payloadKind: typeof DIFF_PAYLOAD_KINDS.BINARY;
      language?: never;
      oldContent?: never;
      newContent?: never;
      image?: never;
    }
  | {
      payloadKind: typeof DIFF_PAYLOAD_KINDS.TOO_LARGE;
      language?: never;
      oldContent?: never;
      newContent?: never;
      image?: never;
    };

export type WorkspaceScmDiffResponse = WorkspaceScmDiffBase &
  WorkspaceDiffPayload;

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
  /** Repo id (from WorkspaceRepo.id) to scope the commit to; omitted → primary repo. */
  repo?: string;
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
export type GitRefLabelType =
  (typeof GIT_REF_LABEL_TYPES)[keyof typeof GIT_REF_LABEL_TYPES];

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
  /** Parent commit hashes in git's order (first parent first), empty for the repository's root commit. */
  parentHashes: string[];
}

export interface WorkspaceCommitLogResponse {
  commits: WorkspaceCommitLogEntry[];
  hasMore: boolean;
  /** null when in detached HEAD state */
  currentBranch: string | null;
  detached: boolean;
  /** Server-issued id for the frozen commit log used by subsequent pages. */
  historyId: string;
  /** Page size fixed when the commit log snapshot was created. */
  pageSize: number;
  /** Number of commits in the frozen commit log snapshot. */
  totalEntries: number;
  /** Virtual index of the first commit in this page. */
  offset: number;
}

/** Default and supported bounds for the paged file-history API. */
export const WORKSPACE_FILE_HISTORY_DEFAULT_PAGE_SIZE = 30;
export const WORKSPACE_FILE_HISTORY_MIN_PAGE_SIZE = 1;
export const WORKSPACE_FILE_HISTORY_MAX_PAGE_SIZE = 500;

/** Default and supported bounds for the paged git-ref diff API. */
export const WORKSPACE_GIT_REF_DIFF_DEFAULT_PAGE_SIZE = 20;
export const WORKSPACE_GIT_REF_DIFF_MIN_PAGE_SIZE = 1;
export const WORKSPACE_GIT_REF_DIFF_MAX_PAGE_SIZE = 200;

/** A commit that touched a path, including both sides of a rename. */
export interface WorkspaceFileHistoryEntry extends WorkspaceCommitLogEntry {
  /** Workspace-relative path at the commit side of the change. */
  path: string;
  /** Workspace-relative path at the parent side of the change. */
  oldPath: string;
}

/** A page from an immutable file-history snapshot. */
export interface WorkspaceFileHistoryPageResponse {
  historyId: string;
  /** Server-clamped size fixed when the history snapshot was created. */
  pageSize: number;
  /** Number of commits in the frozen history snapshot. */
  totalEntries: number;
  /** Virtual index of the first entry in `entries`. */
  offset: number;
  entries: WorkspaceFileHistoryEntry[];
}

/** Structured before/after payload for one file in a git-ref diff page. */
export type WorkspaceGitRefDiffEntry = {
  path: string;
  oldPath?: string;
  changeType: DiffChangeType;
} & WorkspaceDiffPayload;

/** A page from an immutable git-ref diff snapshot. */
export interface WorkspaceGitRefDiffPageResponse {
  diffId: string;
  /** Server-clamped size fixed when the diff snapshot was created. */
  pageSize: number;
  /** Number of changed files in the frozen diff snapshot. */
  totalEntries: number;
  /** Virtual index of the first entry in `entries`. */
  offset: number;
  entries: WorkspaceGitRefDiffEntry[];
  /** Present on every page when the ref resolves to a single commit. */
  commitInfo?: WorkspaceCommitInfo;
}

export interface WorkspaceCheckoutCommitRequest {
  hash: string;
  /** Repo id to scope the checkout to; omitted → primary repo. */
  repo?: string;
}

export interface WorkspaceCheckoutBranchRequest {
  branch: string;
  /** Repo id to scope the checkout to; omitted → primary repo. */
  repo?: string;
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

/** Before/after payload for one commit in a path-scoped file history. */
export type WorkspaceFileHistoryDiffResponse = WorkspaceCommitInfo &
  WorkspaceDiffPayload & {
    /** Workspace-relative path at the commit side of the change. */
    path: string;
    /** Workspace-relative path at the first-parent side of the change. */
    oldPath: string;
    changeType: DiffChangeType;
  };

export interface WorkspaceGitRefDiffResponse {
  unifiedDiff: string;
  /** Present only when `ref` resolves to a single commit (not diff/staged/stash). */
  commitInfo?: WorkspaceCommitInfo;
  /** Changed files whose content is not plain text. */
  nonTextEntries?: WorkspaceDiffEntry[];
}
