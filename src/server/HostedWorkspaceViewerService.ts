import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { Log } from "../utils/Log";
import {
  CommitMessageGenerator,
  type CommitResult,
} from "../git/CommitMessageGenerator";
import { commitMessageGenerationTracker } from "../git/CommitMessageGenerationTracker";
import type {
  WorkspaceTreePageRequest,
  WorkspaceTreeRangeRequest,
  WorkspaceTreePageResponse,
  WorkspaceFileResponse,
  WorkspaceFileSaveRequest,
  WorkspaceScmStatusResponse,
  WorkspaceScmDiffResponse,
  WorkspacePushResponse,
  WorkspacePullResponse,
  WorkspaceCopyRequest,
  WorkspaceMoveRequest,
  DiffKind,
  WorkspaceCommitLogResponse,
  WorkspaceCommitLogEntry,
  WorkspaceFileHistoryEntry,
  WorkspaceFileHistoryPageResponse,
  WorkspaceFileHistoryDiffResponse,
  WorkspaceGitRefDiffEntry,
  WorkspaceGitRefDiffPageResponse,
  WorkspaceGitRefDiffResponse,
  WorkspaceScmFile,
  WorkspaceRepo,
  WorkspaceReposResponse,
  GitRefLabel,
  WorkspaceSearchRequest,
  WorkspaceSearchResponse,
  WorkspaceSearchResult,
  WorkspaceSearchScope,
  WorkspaceSearchContentMatch,
  WorkspaceTreeEntry,
} from "../types/HostedWorkspaceViewerTypes";
import {
  WORKSPACE_SEARCH_SCOPES,
  USER_SETTINGS_VIEWER_SENTINEL_PATH,
  GIT_CHANGE_KINDS,
  LINE_ENDINGS,
  PROMISE_SETTLED_STATUSES,
  WORKSPACE_FILE_LANGUAGE_IDS,
  GIT_REF_LABEL_TYPES,
} from "../types/DashboardConstants";
import { configService } from "../config/CtrlYokeConfigService";
import {
  WORKSPACE_TREE_DEFAULT_PAGE_SIZE,
  WORKSPACE_TREE_MAX_PAGE_SIZE,
  WORKSPACE_ENTRY_SORT_KEYS,
  WORKSPACE_FILE_HISTORY_DEFAULT_PAGE_SIZE,
  WORKSPACE_FILE_HISTORY_MAX_PAGE_SIZE,
  WORKSPACE_GIT_REF_DIFF_DEFAULT_PAGE_SIZE,
  WORKSPACE_GIT_REF_DIFF_MIN_PAGE_SIZE,
  WORKSPACE_GIT_REF_DIFF_MAX_PAGE_SIZE,
} from "../types/HostedWorkspaceViewerTypes";
import {
  SCM_FILE_KINDS,
  WORKSPACE_ENTRY_KINDS,
} from "../types/DashboardConstants";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import type { RunnerHostIdentity } from "../types/CtrlYokeTypes";
import {
  toViewerPath,
  fromViewerPath,
  type ViewerRootContext,
} from "../platform/WorkspaceViewerPath";
import {
  discoverRepos,
  findRepoForPath,
  mapRootPrefixesToRepos,
} from "../utils/WorkspaceRepoDiscovery";
import {
  isPathWithinDirectory,
  isPathWithinAnyDirectory,
} from "../utils/PathSecurity";
import { runtimeTrustedRootRegistry } from "../utils/RuntimeTrustedRootRegistry";
import {
  getRecentCommits,
  getFileHistoryCommits,
  resolveCommit,
  getWorkingTreeDiff,
  getStagedDiff,
  getStashDiff,
  getCommitDiff,
  getCommitInfo,
  getBlobBytes,
  getChangedFilesWithBinaryStatus,
  type GitChangedFile,
  getIgnoredEntryNames,
  getGitTrackedFiles,
  getGitIgnoredFiles,
  getDiffBetweenRefs,
} from "../utils/GitUtils";
import {
  DIFF_CHANGE_TYPES,
  DIFF_PAYLOAD_KINDS,
  type DiffChangeType,
  isImageRefPath,
  imageExtensionToMimeType,
} from "../types/DashboardConstants";
import { pathsEqual } from "../utils/PathCasing";
import { streamFileLines } from "../utils/TextLines";
import {
  REDACTION_MARKER,
  secretRedactionService,
} from "../utils/SecretRedactionService";
import {
  WorkspaceListingSnapshotCache,
  type WorkspaceEntryMetadata,
} from "./WorkspaceListingSnapshotCache";
import {
  normalizeWorkspaceEntrySort,
  sortWorkspaceEntries,
} from "./WorkspaceEntrySort";
import {
  WorkspaceTreeBadRequestError,
  WorkspaceTreeExpiredError,
} from "./WorkspaceTreeErrors";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
export const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const BINARY_CHECK_BYTES = 8192;
const WORKSPACE_TREE_STAT_CONCURRENCY = 8;
const SEARCH_MAX_DURATION_MS = 3000;
const SEARCH_MAX_FILENAME_MATCHES = 30;
const SEARCH_MAX_CONTENT_MATCHES_PER_FILE = 3;
const SEARCH_CONCURRENCY = 8;
const SEARCH_DEFAULT_LIMIT = 100;
const SEARCH_MAX_LIMIT = 500;
const SEARCH_SNIPPET_MAX_LENGTH = 200;
const FILE_HISTORY_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const FILE_HISTORY_SNAPSHOT_MAX_COUNT = 32;
const COMMIT_LOG_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const COMMIT_LOG_SNAPSHOT_MAX_COUNT = 32;
const GIT_REF_DIFF_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const GIT_REF_DIFF_SNAPSHOT_MAX_COUNT = 32;
const GIT_REF_DIFF_REFS = {
  WORKING_TREE: "~diff",
  STAGED: "~staged",
  STASH_PREFIX: "~stash:",
} as const;

type GitRefDiffKind = "workingTree" | "staged" | "stash" | "commit";

export class RedactionMarkerSaveError extends Error {
  constructor() {
    super("Cannot save content containing the redaction marker");
    this.name = "RedactionMarkerSaveError";
  }
}
const SEARCH_FALLBACK_SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
]);

interface NonTextDiffSources {
  baseRef: string;
  targetRef?: string;
  targetIsWorkingTree: boolean;
}

interface GitRefDiffResolution {
  kind: GitRefDiffKind;
  sources: NonTextDiffSources;
  changedFilesArgs: readonly string[];
  commitHash?: string;
  stashIndex?: number;
}

interface FileHistorySnapshot {
  historyId: string;
  requestedPath: string;
  repoRoot: string;
  headHash: string;
  pageSize: number;
  entries: readonly WorkspaceFileHistoryEntry[];
  lastAccessedAt: number;
}

interface CommitLogSnapshot {
  historyId: string;
  repoRoot: string;
  branchHint?: string;
  detached: boolean;
  currentBranch: string | null;
  pageSize: number;
  commits: readonly WorkspaceCommitLogEntry[];
  lastAccessedAt: number;
}

interface GitRefDiffSnapshot {
  diffId: string;
  ref: string;
  repoRoot: string;
  pageSize: number;
  sources: NonTextDiffSources;
  changedFiles: readonly GitChangedFile[];
  commitInfo?: WorkspaceGitRefDiffPageResponse["commitInfo"];
  lastAccessedAt: number;
}

/** Run metadata work with a fixed number of concurrent filesystem operations. */
async function mapWithBoundedConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker())
  );
  return results;
}

interface SearchCandidate {
  absolutePath: string;
  viewerPath: string;
}

interface SearchContentScan {
  matches: WorkspaceSearchContentMatch[];
  truncated: boolean;
}

interface SearchWalkResult {
  files: string[];
  truncated: boolean;
}

/** Extension → Monaco language ID mapping. */
const LANGUAGE_MAP: Record<string, string> = {
  ts: "typescript",
  tsx: "typescriptreact",
  js: "javascript",
  jsx: "javascriptreact",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  json: "json",
  jsonc: "jsonc",
  yaml: "yaml",
  yml: "yaml",
  md: "markdown",
  mdx: "mdx",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  svg: "xml",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  ps1: "powershell",
  cs: "csharp",
  java: "java",
  kt: "kotlin",
  go: "go",
  rs: "rust",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  toml: "toml",
  ini: "ini",
  env: "properties",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  tf: "hcl",
  [WORKSPACE_FILE_LANGUAGE_IDS.DOCKERFILE]:
    WORKSPACE_FILE_LANGUAGE_IDS.DOCKERFILE,
  txt: "plaintext",
};

function languageFromPath(filePath: string): string | undefined {
  const base = path.basename(filePath).toLowerCase();
  // Special full-filename matches
  if (base === WORKSPACE_FILE_LANGUAGE_IDS.DOCKERFILE) {
    return WORKSPACE_FILE_LANGUAGE_IDS.DOCKERFILE;
  }
  if (base === ".env" || base.startsWith(".env.")) return "properties";
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  return LANGUAGE_MAP[ext];
}

/** Convert OS path separators to forward slashes for git commands. */
function toGitPath(p: string): string {
  return p.split(path.sep).join("/");
}

function normalizeScmPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "");
}

/** Decode Git's C-quoted path form, including UTF-8 bytes written as octal. */
function decodeGitPath(p: string): string {
  if (p.length < 2 || p[0] !== '"' || p[p.length - 1] !== '"') {
    return p;
  }

  const bytes: number[] = [];
  for (let index = 1; index < p.length - 1; index++) {
    const character = p[index] ?? "";
    if (character !== "\\") {
      bytes.push(...Buffer.from(character, "utf8"));
      continue;
    }

    const escaped = p[++index] ?? "";
    const simpleEscapes: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      "\\": 0x5c,
      '"': 0x22,
    };
    if (Object.prototype.hasOwnProperty.call(simpleEscapes, escaped)) {
      bytes.push(simpleEscapes[escaped] ?? 0);
      continue;
    }

    if (/[0-7]/.test(escaped)) {
      let octal = escaped;
      for (
        let digitCount = 1;
        digitCount < 3 && /[0-7]/.test(p[index + 1] ?? "");
        digitCount++
      ) {
        octal += p[++index] ?? "";
      }
      bytes.push(Number.parseInt(octal, 8));
      continue;
    }

    bytes.push(...Buffer.from(escaped, "utf8"));
  }

  return Buffer.from(bytes).toString("utf8");
}

/**
 * Classifies full `git log` decoration ref names (from `%D`) into typed labels
 * used by the commit-history git-graph pills.
 */
function classifyRefNames(refNames: string[]): GitRefLabel[] {
  const labels: GitRefLabel[] = [];
  for (const raw of refNames) {
    let name = raw.trim();
    if (!name) continue;

    // "HEAD -> main" decorates the checked-out branch tip with both HEAD and
    // the branch; surface the branch (HEAD itself is conveyed via isHead).
    if (name.startsWith("HEAD ->")) {
      name = name.slice("HEAD ->".length).trim();
    }

    if (name === "HEAD") {
      labels.push({ name, type: "head" });
    } else if (name.startsWith("tag: refs/tags/")) {
      labels.push({ name: name.slice("tag: refs/tags/".length), type: "tag" });
    } else if (name.startsWith("refs/tags/")) {
      labels.push({ name: name.slice("refs/tags/".length), type: "tag" });
    } else if (/^refs\/remotes\/[^/]+\/HEAD$/.test(name)) {
      // "refs/remotes/<remote>/HEAD" (e.g. origin/HEAD) is a symbolic alias
      // for the remote's default branch, not a real branch — skip it so it doesn't
      // render as a second, redundant remote-branch pill alongside the
      // branch it points to (e.g. origin/main).
      continue;
    } else if (name.startsWith("refs/remotes/")) {
      labels.push({
        name: name.slice("refs/remotes/".length),
        type: GIT_REF_LABEL_TYPES.REMOTE_BRANCH,
      });
    } else if (name.startsWith("refs/heads/")) {
      labels.push({
        name: name.slice("refs/heads/".length),
        type: GIT_REF_LABEL_TYPES.LOCAL_BRANCH,
      });
    } else {
      // Keep bare or otherwise unrecognized decoration names visible as local
      // labels, matching git's non-remote behavior.
      labels.push({ name, type: GIT_REF_LABEL_TYPES.LOCAL_BRANCH });
    }
  }
  return labels;
}

export class HostedWorkspaceViewerService {
  private readonly commitGenerator: CommitMessageGenerator;
  private readonly listingSnapshotCache = new WorkspaceListingSnapshotCache();
  private readonly fileHistorySnapshots = new Map<
    string,
    FileHistorySnapshot
  >();
  private readonly commitLogSnapshots = new Map<string, CommitLogSnapshot>();
  private readonly gitRefDiffSnapshots = new Map<string, GitRefDiffSnapshot>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly namedRoots: ResolverWorkspaceFolder[] = [],
    runnerHostIdentity?: RunnerHostIdentity
  ) {
    this.commitGenerator = new CommitMessageGenerator(
      undefined,
      runnerHostIdentity
    );
  }

  /**
   * File-count budget for one search, past which the response is marked
   * truncated. An instance member rather than a module constant so a test
   * subclass can shrink it: proving the budget with the real 5000 meant
   * creating 5001 files per run, which on Windows is slow enough to time the
   * test out under full-suite load without telling us anything the small
   * budget does not.
   */
  protected readonly searchMaxFiles: number = 5000;

  // ── Multi-root helpers ───────────────────────────────────────────────────
  //
  // A multi-root `.code-workspace` is presented to viewer clients as a virtual
  // top level listing every root by folder name (see `listRoots()`), and every
  // path below that level is folder-name-prefixed (`root2/src/index.ts`) —
  // the same stored-ref convention used by `resolveNamedRelativePath`
  // elsewhere (PromptLinkProvider, WebviewMessageRouter, ContextExpander), so
  // reference links clicked in the hosted browser resolve identically to how
  // they resolve in the VS Code panel.

  private get isMultiRoot(): boolean {
    return this.namedRoots.length > 1;
  }

  private get trustedRoots(): string[] {
    return [
      ...(this.isMultiRoot
        ? this.namedRoots.map((root) => path.resolve(root.fsPath))
        : [path.resolve(this.workspaceRoot)]),
      ...runtimeTrustedRootRegistry.getRoots(),
    ];
  }

  private get primaryRootName(): string {
    const primary = path.resolve(this.workspaceRoot);
    const match = this.namedRoots.find(
      (root) => path.resolve(root.fsPath) === primary
    );
    return match?.name ?? path.basename(this.workspaceRoot);
  }

  /** Context describing which roots viewer-path conversions resolve against. */
  private get viewerContext(): ViewerRootContext {
    return { primaryRoot: this.workspaceRoot, namedRoots: this.namedRoots };
  }

  private resolveAgainstRoots(requestedPath: string): string {
    return fromViewerPath(requestedPath, this.viewerContext);
  }

  private findRootFor(
    absolutePath: string
  ): ResolverWorkspaceFolder | undefined {
    return this.namedRoots.find((root) =>
      isPathWithinDirectory(absolutePath, path.resolve(root.fsPath))
    );
  }

  private isExactRoot(absolutePath: string): boolean {
    const resolved = path.resolve(absolutePath);
    return this.trustedRoots.some((root) => pathsEqual(root, resolved));
  }

  // ── Repo discovery ───────────────────────────────────────────────────────
  //
  // A multi-root workspace can span several git repos. Repos are discovered by
  // git toplevel (see `discoverRepos`) and keyed by a stable id the UI passes
  // back to scope repo-specific SCM operations. Git commands run `-C <repo
  // toplevel>` so every repo — not just the primary root — supports status,
  // diff, stage, commit, history, etc. `discoverRepos` is the single source of
  // repo identity shared with the snapshot/undo layer.
  //
  // The result is cached with a short TTL rather than forever: `namedRoots` is
  // fixed for this instance's lifetime, but the *repo* set discovered from them
  // is not — a user can `git init` (or delete `.git`) inside an existing root
  // mid-session, which changes discovery without changing the roots, so no
  // reconstruction fires. The TTL keeps discovery off the hot path for bursts
  // of SCM calls while still picking up such changes within a few seconds.

  private static readonly REPO_CACHE_TTL_MS = 5_000;
  private repoCache: WorkspaceRepo[] | null = null;
  private repoCacheAt = 0;

  private async getReposInternal(): Promise<WorkspaceRepo[]> {
    const now = Date.now();
    if (
      this.repoCache &&
      now - this.repoCacheAt < HostedWorkspaceViewerService.REPO_CACHE_TTL_MS
    ) {
      return this.repoCache;
    }
    const roots: ResolverWorkspaceFolder[] = this.isMultiRoot
      ? this.namedRoots
      : [{ name: this.primaryRootName, fsPath: this.workspaceRoot }];
    this.repoCache = await discoverRepos(roots);
    this.repoCacheAt = now;
    return this.repoCache;
  }

  async getRepos(): Promise<WorkspaceReposResponse> {
    const repos = await this.getReposInternal();
    // Only multi-root workspaces produce prefixed viewer paths; single-root
    // leaves the map empty (the selector stays hidden anyway).
    const prefixRepoIds = this.isMultiRoot
      ? mapRootPrefixesToRepos(this.namedRoots, repos)
      : {};
    return { repos, prefixRepoIds };
  }

  /**
   * Resolve a repo-scoped operation's target toplevel. A known repo id wins;
   * otherwise fall back to the repo containing the primary root, then the
   * primary root itself (single-repo / no-selection default).
   */
  private async resolveRepoRoot(repoId?: string): Promise<string> {
    const repos = await this.getReposInternal();
    if (repoId) {
      const match = repos.find((repo) => repo.id === repoId);
      if (match) {
        return match.rootPath;
      }
    }
    const containing = findRepoForPath(this.workspaceRoot, repos);
    return containing?.rootPath ?? this.workspaceRoot;
  }

  /**
   * Find the repo toplevel that owns a resolved absolute path. Path-carrying
   * git operations (diff/stage/unstage/discard) infer their repo this way.
   * Throws when the path is not inside any discovered repo rather than handing
   * git a pathspec outside the repo.
   */
  private async requireRepoRootForPath(absolutePath: string): Promise<string> {
    const repos = await this.getReposInternal();
    const match = findRepoForPath(absolutePath, repos);
    if (!match) {
      throw new Error("File is not inside a git repository");
    }
    return match.rootPath;
  }

  /** Path relative to a specific repo toplevel — for git pathspecs. */
  private relativeToRepo(absolutePath: string, repoRoot: string): string {
    return path.relative(path.resolve(repoRoot), absolutePath);
  }

  private realpathsOf(directories: readonly string[]): string[] {
    return directories.map((dir) => {
      try {
        return fs.realpathSync(dir);
      } catch {
        return dir;
      }
    });
  }

  // ── Path safety ──────────────────────────────────────────────────────────

  /**
   * The user-scope settings.json (`~/.ctrlyoke/settings.json`) lives outside
   * every workspace root, so the normal trusted-root containment check below
   * would always reject it. The "Open settings file" action sends the fixed
   * `USER_SETTINGS_VIEWER_SENTINEL_PATH` sentinel to request it (never a real
   * path the client constructs itself); a subsequent save/refresh instead
   * sends back whatever `relativePath()` produced when the file was first
   * read (an absolute path, or one with `../` segments in single-root mode),
   * which is matched here by resolved identity against the real file.
   */
  private resolveOwnedUserSettingsFile(requestedPath: string): string | null {
    const userSettingsPath = configService.getUserFilePath();
    if (!userSettingsPath) return null;
    const resolvedUserSettingsPath = path.resolve(userSettingsPath);

    if (requestedPath === USER_SETTINGS_VIEWER_SENTINEL_PATH) {
      return resolvedUserSettingsPath;
    }

    const candidates = [
      path.resolve(requestedPath),
      path.resolve(this.workspaceRoot, requestedPath),
    ];
    return candidates.some((candidate) =>
      pathsEqual(candidate, resolvedUserSettingsPath)
    )
      ? resolvedUserSettingsPath
      : null;
  }

  private safeResolve(requestedPath: string): string | null {
    const ownedUserSettingsPath =
      this.resolveOwnedUserSettingsFile(requestedPath);
    if (ownedUserSettingsPath) return ownedUserSettingsPath;

    const trustedRoots = this.trustedRoots;
    const resolved = this.resolveAgainstRoots(requestedPath);

    // Reject if the resolved path escapes every trusted root
    if (!isPathWithinAnyDirectory(resolved, trustedRoots)) {
      return null;
    }

    // Try to resolve symlinks on the full path
    try {
      const realResolved = fs.realpathSync(resolved);
      if (
        !isPathWithinAnyDirectory(realResolved, this.realpathsOf(trustedRoots))
      ) {
        return null;
      }
      return realResolved;
    } catch {
      // Path doesn't exist yet (e.g. new file write) — fall back to parent check
      const parent = path.dirname(resolved);
      try {
        const realParent = fs.realpathSync(parent);
        if (
          !isPathWithinAnyDirectory(realParent, this.realpathsOf(trustedRoots))
        ) {
          return null;
        }
      } catch {
        // Parent also doesn't exist; rely on the normalised check above
      }
      return resolved;
    }
  }

  /**
   * Returns the viewer-relative path for an absolute filesystem path: plain
   * workspace-relative in single-root, folder-name-prefixed
   * (`root2/src/index.ts`) in multi-root — the inverse of
   * `resolveAgainstRoots`.
   */
  private relativePath(absolutePath: string): string {
    return toViewerPath(absolutePath, this.viewerContext);
  }

  // ── Workspace search ────────────────────────────────────────────────────

  /**
   * Search the files visible to the workspace viewer. This deliberately walks
   * workspace roots rather than discovered repository toplevels: a workspace
   * root may be nested inside a repository, and the viewer must not expose the
   * repository's siblings or parent files.
   */
  async searchWorkspace(
    request: WorkspaceSearchRequest
  ): Promise<WorkspaceSearchResponse> {
    const query = request.query.trim();
    if (query.length < 2) {
      return { results: [], truncated: false };
    }

    const scope: WorkspaceSearchScope =
      request.scope === WORKSPACE_SEARCH_SCOPES.FILES ||
      request.scope === WORKSPACE_SEARCH_SCOPES.CONTENT ||
      request.scope === WORKSPACE_SEARCH_SCOPES.BOTH
        ? request.scope
        : WORKSPACE_SEARCH_SCOPES.BOTH;
    const requestedLimit = Number.isFinite(request.limit)
      ? Math.floor(request.limit ?? SEARCH_DEFAULT_LIMIT)
      : SEARCH_DEFAULT_LIMIT;
    const limit = Math.min(
      SEARCH_MAX_LIMIT,
      requestedLimit > 0 ? requestedLimit : SEARCH_DEFAULT_LIMIT
    );
    const startedAt = Date.now();
    const roots = await this.searchRoots(request.repo);
    if (roots.length === 0) {
      return { results: [], truncated: false };
    }

    const discovered = await Promise.all(
      roots.map((root) =>
        this.discoverSearchCandidates(root.fsPath, request, startedAt)
      )
    );
    const candidates = discovered.flatMap((result) => result.candidates);
    let truncated = discovered.some((result) => result.truncated);
    let scannedFiles = 0;
    const queryLower = query.toLowerCase();
    const filenameResults: WorkspaceSearchResult[] = [];
    const surfacedFilenamePaths = new Set<string>();
    const contentCandidates: SearchCandidate[] = [];
    const filenameLimit = Math.min(SEARCH_MAX_FILENAME_MATCHES, limit);

    for (const candidate of candidates) {
      if (filenameResults.length >= limit) break;
      if (
        scannedFiles >= this.searchMaxFiles ||
        Date.now() - startedAt >= SEARCH_MAX_DURATION_MS
      ) {
        truncated = true;
        break;
      }
      scannedFiles++;

      if (scope !== WORKSPACE_SEARCH_SCOPES.CONTENT) {
        const name = path.basename(candidate.absolutePath);
        if (
          filenameResults.length < filenameLimit &&
          name.toLowerCase().includes(queryLower)
        ) {
          filenameResults.push({
            kind: WORKSPACE_ENTRY_KINDS.FILE,
            path: candidate.viewerPath,
            name,
          });
          surfacedFilenamePaths.add(candidate.absolutePath);
        }
      }

      if (
        (scope === WORKSPACE_SEARCH_SCOPES.CONTENT ||
          scope === WORKSPACE_SEARCH_SCOPES.BOTH) &&
        !surfacedFilenamePaths.has(candidate.absolutePath)
      ) {
        contentCandidates.push(candidate);
      }
    }

    if (
      scope === WORKSPACE_SEARCH_SCOPES.FILES ||
      filenameResults.length >= limit
    ) {
      return { results: filenameResults.slice(0, limit), truncated };
    }

    const contentResultLimit = limit - filenameResults.length;
    const contentMatchesByCandidate = new Map<
      number,
      WorkspaceSearchContentMatch[]
    >();
    let contentMatchCount = 0;
    let nextCandidateIndex = 0;

    const scanContent = async (): Promise<void> => {
      while (true) {
        if (
          contentMatchCount >= contentResultLimit ||
          Date.now() - startedAt >= SEARCH_MAX_DURATION_MS
        ) {
          if (Date.now() - startedAt >= SEARCH_MAX_DURATION_MS) {
            truncated = true;
          }
          return;
        }

        const candidateIndex = nextCandidateIndex++;
        if (candidateIndex >= contentCandidates.length) return;
        const scan = await this.scanSearchFile(
          contentCandidates[candidateIndex],
          queryLower,
          Math.min(
            SEARCH_MAX_CONTENT_MATCHES_PER_FILE,
            contentResultLimit - contentMatchCount
          ),
          startedAt
        );
        if (scan.truncated) truncated = true;

        const remaining = contentResultLimit - contentMatchCount;
        if (remaining > 0 && scan.matches.length > 0) {
          const matches = scan.matches.slice(0, remaining);
          contentMatchesByCandidate.set(candidateIndex, matches);
          contentMatchCount += matches.length;
        }
      }
    };

    await Promise.all(
      Array.from(
        {
          length: Math.min(SEARCH_CONCURRENCY, contentCandidates.length),
        },
        () => scanContent()
      )
    );

    const contentResults: WorkspaceSearchContentMatch[] = [];
    for (let i = 0; i < contentCandidates.length; i++) {
      const matches = contentMatchesByCandidate.get(i);
      if (!matches) continue;
      contentResults.push(...matches);
      if (contentResults.length >= contentResultLimit) break;
    }

    return {
      results: [...filenameResults, ...contentResults].slice(0, limit),
      truncated,
    };
  }

  private async searchRoots(
    repoId: string | undefined
  ): Promise<ResolverWorkspaceFolder[]> {
    const roots: ResolverWorkspaceFolder[] = this.isMultiRoot
      ? this.namedRoots
      : [{ name: this.primaryRootName, fsPath: this.workspaceRoot }];
    if (!repoId) return roots;

    const repos = await this.getReposInternal();
    const prefixRepoIds = mapRootPrefixesToRepos(roots, repos);
    return roots.filter((root) => prefixRepoIds[root.name] === repoId);
  }

  private async discoverSearchCandidates(
    rootPath: string,
    request: WorkspaceSearchRequest,
    startedAt: number
  ): Promise<{ candidates: SearchCandidate[]; truncated: boolean }> {
    let relativeFiles: string[];
    let truncated = false;
    try {
      const trackedFiles = await getGitTrackedFiles(rootPath);
      relativeFiles = trackedFiles;
      if (request.includeGitIgnored) {
        const ignoredFiles = await getGitIgnoredFiles(rootPath);
        relativeFiles = [...new Set([...trackedFiles, ...ignoredFiles])];
      }
    } catch {
      const walked = await this.walkSearchFiles(rootPath, startedAt);
      relativeFiles = walked.files;
      truncated = walked.truncated;
    }

    const candidates: SearchCandidate[] = [];
    const root = path.resolve(rootPath);
    for (const relativeFile of relativeFiles) {
      const absolutePath = path.resolve(root, relativeFile);
      if (!isPathWithinDirectory(absolutePath, root)) continue;
      candidates.push({
        absolutePath,
        viewerPath: this.relativePath(absolutePath),
      });
    }
    return { candidates, truncated };
  }

  /** Bounded non-git fallback walk. Symlinks are not followed. */
  private async walkSearchFiles(
    rootPath: string,
    startedAt: number
  ): Promise<SearchWalkResult> {
    const root = path.resolve(rootPath);
    const pending = [root];
    const files: string[] = [];
    let truncated = false;

    while (pending.length > 0 && files.length < this.searchMaxFiles) {
      if (Date.now() - startedAt >= SEARCH_MAX_DURATION_MS) {
        truncated = true;
        break;
      }
      const directory = pending.pop();
      if (!directory) break;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (Date.now() - startedAt >= SEARCH_MAX_DURATION_MS) {
          truncated = true;
          break;
        }
        if (files.length >= this.searchMaxFiles) {
          truncated = true;
          break;
        }
        if (
          entry.isDirectory() &&
          !SEARCH_FALLBACK_SKIP_DIRECTORIES.has(entry.name)
        ) {
          pending.push(path.join(directory, entry.name));
        } else if (entry.isFile()) {
          files.push(path.relative(root, path.join(directory, entry.name)));
        }
      }
    }
    if (files.length >= this.searchMaxFiles && pending.length > 0) {
      truncated = true;
    }
    return { files, truncated };
  }

  private async isSearchFileWithinTrustedRoots(
    filePath: string
  ): Promise<string | null> {
    try {
      const realPath = await fs.promises.realpath(filePath);
      return isPathWithinAnyDirectory(realPath, this.trustedRoots)
        ? realPath
        : null;
    } catch {
      return null;
    }
  }

  private async scanSearchFile(
    candidate: SearchCandidate,
    queryLower: string,
    maxMatches: number,
    startedAt: number
  ): Promise<SearchContentScan> {
    const safePath = await this.isSearchFileWithinTrustedRoots(
      candidate.absolutePath
    );
    if (!safePath) return { matches: [], truncated: false };

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(safePath);
    } catch {
      return { matches: [], truncated: false };
    }
    if (!stat.isFile() || stat.size > MAX_FILE_SIZE) {
      return { matches: [], truncated: false };
    }
    if (await this.isBinaryFile(safePath)) {
      return { matches: [], truncated: false };
    }

    const matches: WorkspaceSearchContentMatch[] = [];
    let lineNumber = 0;
    let truncated = false;
    try {
      // `streamFileLines` rather than `readline` so the line number reported
      // here addresses the same line the editor scrolls to: the client renders
      // the file in CodeMirror, which never breaks on U+2028/U+2029 but does
      // break on a lone CR. See `TextLines.ts`.
      for await (const line of streamFileLines(safePath)) {
        lineNumber++;
        if (Date.now() - startedAt >= SEARCH_MAX_DURATION_MS) {
          truncated = true;
          break;
        }
        if (line.toLowerCase().includes(queryLower)) {
          const trimmed = line.trim();
          matches.push({
            kind: WORKSPACE_ENTRY_KINDS.CONTENT,
            path: candidate.viewerPath,
            line: lineNumber,
            matchSnippet:
              trimmed.length > SEARCH_SNIPPET_MAX_LENGTH
                ? `${trimmed.slice(0, SEARCH_SNIPPET_MAX_LENGTH - 1)}…`
                : trimmed,
          });
          if (matches.length >= maxMatches) break;
        }
      }
    } catch {
      return { matches: [], truncated };
    }
    return { matches, truncated };
  }

  // ── Directory listing ────────────────────────────────────────────────────

  /**
   * The virtual top level shown for a multi-root workspace: one directory
   * entry per open root, named after the root's folder name. Browsing into
   * one produces folder-name-prefixed paths for everything below it.
   */
  async listDirectory(
    request: WorkspaceTreePageRequest | WorkspaceTreeRangeRequest
  ): Promise<WorkspaceTreePageResponse> {
    if (this.isRangeRequest(request)) {
      return this.getListingPage(request);
    }
    return this.createListingPage(request);
  }

  private isRangeRequest(
    request: WorkspaceTreePageRequest | WorkspaceTreeRangeRequest
  ): request is WorkspaceTreeRangeRequest {
    return "listingId" in request;
  }

  private async createListingPage(
    request: WorkspaceTreePageRequest
  ): Promise<WorkspaceTreePageResponse> {
    if (typeof request.path !== "string") {
      throw new WorkspaceTreeBadRequestError("path is required");
    }
    if (typeof request.includeGitIgnored !== "boolean") {
      throw new WorkspaceTreeBadRequestError(
        "includeGitIgnored must be a boolean"
      );
    }
    if (
      request.anchorPath !== undefined &&
      typeof request.anchorPath !== "string"
    ) {
      throw new WorkspaceTreeBadRequestError("anchorPath is invalid");
    }
    const pageSize = this.resolvePageSize(request.pageSize);
    const snapshot = await this.createListingSnapshot(request, pageSize);
    let offset = 0;
    if (request.anchorPath !== undefined) {
      const anchorIndex = snapshot.entries.findIndex(
        (entry) =>
          normalizeViewerPath(entry.path) ===
          normalizeViewerPath(request.anchorPath!)
      );
      if (anchorIndex >= 0) {
        offset =
          Math.floor(anchorIndex / snapshot.pageSize) * snapshot.pageSize;
      }
    }
    return this.materializeListingPage(snapshot, offset);
  }

  private async createListingSnapshot(
    request: WorkspaceTreePageRequest,
    pageSize: number
  ) {
    const sort = normalizeWorkspaceEntrySort(request.sort);
    const resolved = this.safeResolve(request.path);
    if (!resolved) {
      Log.warn(
        `[HostedWorkspaceViewerService] Path escape attempt rejected: ${request.path}`
      );
      throw new WorkspaceTreeBadRequestError("Path is not allowed");
    }
    if (this.isMultiRoot && request.path.trim() === "") {
      const entries = this.namedRoots.map((root) => ({
        name: root.name,
        path: root.name,
        kind: WORKSPACE_ENTRY_KINDS.DIRECTORY,
      }));
      const initialMetadata =
        sort.key === WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT
          ? await this.collectEntryMetadata(
              entries,
              (entry) => this.findRootForEntry(entry)?.fsPath
            )
          : new Map<string, WorkspaceEntryMetadata>();
      const orderedEntries = sortWorkspaceEntries(
        entries.map((entry) => ({
          ...entry,
          ...initialMetadata.get(entry.path),
        })),
        sort
      );
      return this.listingSnapshotCache.create(
        {
          resolvedDirectory: resolved,
          rootLabel: "workspace",
          path: "",
          parentPath: null,
          isGitRepo: false,
          isRootsList: true,
          includeGitIgnored: request.includeGitIgnored,
          order: sort,
          pageSize,
          entries: orderedEntries,
        },
        initialMetadata
      );
    }

    const rootLabel = this.isMultiRoot
      ? "workspace"
      : path.basename(this.workspaceRoot);

    const relDir = this.relativePath(resolved);
    const parentPath =
      relDir === ""
        ? null
        : this.isMultiRoot && !relDir.includes("/")
          ? ""
          : this.relativePath(path.dirname(resolved));
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(resolved, { withFileTypes: true });
    } catch (error) {
      Log.warn(
        `[HostedWorkspaceViewerService] listDirectory failed for ${resolved}: ${String(error)}`
      );
      throw new WorkspaceTreeBadRequestError("Directory could not be read");
    }

    const containingRoot = this.isMultiRoot
      ? (this.findRootFor(resolved)?.fsPath ?? this.workspaceRoot)
      : this.workspaceRoot;
    const rootRelativeDir = this.isMultiRoot
      ? path
          .relative(path.resolve(containingRoot), resolved)
          .split(path.sep)
          .join("/")
      : relDir;
    const ignoredNames = await getIgnoredEntryNames(
      containingRoot,
      rootRelativeDir
    );
    const isGitRepo = ignoredNames !== null;
    const candidates = dirents
      .filter((dirent) => dirent.isDirectory() || dirent.isFile())
      .map((dirent) => {
        const gitIgnored =
          dirent.name === ".git"
            ? isGitRepo
            : dirent.isDirectory()
              ? (ignoredNames?.has(`${dirent.name}/`) ?? false)
              : (ignoredNames?.has(dirent.name) ?? false);
        return {
          name: dirent.name,
          path: this.relativePath(path.join(resolved, dirent.name)),
          kind: dirent.isDirectory()
            ? WORKSPACE_ENTRY_KINDS.DIRECTORY
            : WORKSPACE_ENTRY_KINDS.FILE,
          gitIgnored,
        };
      })
      .filter((entry) => request.includeGitIgnored || !entry.gitIgnored);
    const initialMetadata =
      sort.key === WORKSPACE_ENTRY_SORT_KEYS.MODIFIED_AT
        ? await this.collectEntryMetadata(candidates, (entry) =>
            path.join(resolved, entry.name)
          )
        : new Map<string, WorkspaceEntryMetadata>();
    const orderedEntries = sortWorkspaceEntries(
      candidates.map((entry) => ({
        ...entry,
        ...initialMetadata.get(entry.path),
      })),
      sort
    );

    return this.listingSnapshotCache.create(
      {
        resolvedDirectory: resolved,
        rootLabel,
        path: relDir,
        parentPath,
        isGitRepo,
        isRootsList: false,
        includeGitIgnored: request.includeGitIgnored,
        order: sort,
        pageSize,
        entries: orderedEntries,
      },
      initialMetadata
    );
  }

  private async collectEntryMetadata(
    entries: readonly WorkspaceTreeEntry[],
    resolvePath: (entry: WorkspaceTreeEntry) => string | undefined
  ): Promise<Map<string, WorkspaceEntryMetadata>> {
    const metadata = await mapWithBoundedConcurrency(
      entries,
      WORKSPACE_TREE_STAT_CONCURRENCY,
      async (entry) =>
        [
          entry.path,
          await this.readEntryMetadata(resolvePath(entry), entry.kind),
        ] as const
    );
    return new Map(metadata);
  }

  private async readEntryMetadata(
    absolutePath: string | undefined,
    kind: WorkspaceTreeEntry["kind"]
  ): Promise<WorkspaceEntryMetadata> {
    if (absolutePath === undefined) return {};
    try {
      const stat = await fs.promises.stat(absolutePath);
      return kind === WORKSPACE_ENTRY_KINDS.FILE
        ? { size: stat.size, modifiedAt: stat.mtimeMs }
        : { modifiedAt: stat.mtimeMs };
    } catch {
      return {};
    }
  }

  private findRootForEntry(
    entry: WorkspaceTreeEntry
  ): ResolverWorkspaceFolder | undefined {
    return this.namedRoots.find((root) => root.name === entry.name);
  }

  private async getListingPage(
    request: WorkspaceTreeRangeRequest
  ): Promise<WorkspaceTreePageResponse> {
    if (!isValidListingId(request.listingId)) {
      throw new WorkspaceTreeBadRequestError("listingId is invalid");
    }
    if (!Number.isSafeInteger(request.offset) || request.offset < 0) {
      throw new WorkspaceTreeBadRequestError(
        "offset must be a non-negative integer"
      );
    }
    const snapshot = this.listingSnapshotCache.get(request.listingId);
    if (!snapshot) throw new WorkspaceTreeExpiredError();
    if (request.offset % snapshot.pageSize !== 0) {
      throw new WorkspaceTreeBadRequestError(
        "offset must be aligned to pageSize"
      );
    }
    if (request.offset > snapshot.entries.length) {
      throw new WorkspaceTreeBadRequestError("offset is outside the listing");
    }
    return this.materializeListingPage(snapshot, request.offset);
  }

  private resolvePageSize(requestedPageSize: number | undefined): number {
    if (requestedPageSize === undefined) {
      return WORKSPACE_TREE_DEFAULT_PAGE_SIZE;
    }
    if (!Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1) {
      throw new WorkspaceTreeBadRequestError(
        "pageSize must be a positive integer"
      );
    }
    return Math.min(WORKSPACE_TREE_MAX_PAGE_SIZE, requestedPageSize);
  }

  private async materializeListingPage(
    snapshot: Awaited<ReturnType<WorkspaceListingSnapshotCache["create"]>>,
    offset: number
  ): Promise<WorkspaceTreePageResponse> {
    const pageEntries = snapshot.entries.slice(
      offset,
      offset + snapshot.pageSize
    );
    const metadata = await mapWithBoundedConcurrency(
      pageEntries,
      WORKSPACE_TREE_STAT_CONCURRENCY,
      (entry) =>
        this.listingSnapshotCache.getOrCreateEntryMetadata(
          snapshot.listingId,
          entry.path,
          () =>
            this.readEntryMetadata(
              this.resolveEntryMetadataPath(snapshot, entry),
              entry.kind
            )
        )
    );
    return {
      listingId: snapshot.listingId,
      pageSize: snapshot.pageSize,
      rootLabel: snapshot.rootLabel,
      path: snapshot.path,
      parentPath: snapshot.parentPath,
      isGitRepo: snapshot.isGitRepo,
      isRootsList: snapshot.isRootsList,
      totalEntries: snapshot.entries.length,
      offset,
      entries: pageEntries.map((entry, index) => ({
        ...entry,
        ...metadata[index],
      })),
    };
  }

  private resolveEntryMetadataPath(
    snapshot: Awaited<ReturnType<WorkspaceListingSnapshotCache["create"]>>,
    entry: WorkspaceTreeEntry
  ): string | undefined {
    if (snapshot.isRootsList) return this.findRootForEntry(entry)?.fsPath;
    return path.join(snapshot.resolvedDirectory, entry.name);
  }

  // ── File read ────────────────────────────────────────────────────────────

  async readFile(requestedPath: string): Promise<WorkspaceFileResponse> {
    const resolved = this.safeResolve(requestedPath);
    if (!resolved) {
      return this.rejectedFileResponse(requestedPath, "Path not allowed");
    }

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(resolved);
    } catch {
      return this.rejectedFileResponse(requestedPath, "File not found");
    }

    if (stat.size > MAX_FILE_SIZE) {
      return this.rejectedFileResponse(requestedPath, "File too large");
    }

    // Known image types: serve as a data URI the client renders inline as an
    // <img>, rather than falling through to the binary-file rejection below.
    if (isImageRefPath(resolved)) {
      const extension = path.extname(resolved).replace(/^\./, "");
      const mimeType = imageExtensionToMimeType(extension);
      if (mimeType) {
        const bytes = await fs.promises.readFile(resolved);
        return {
          path: this.relativePath(resolved),
          name: path.basename(resolved),
          size: stat.size,
          eol: "lf",
          content: "",
          readOnly: true,
          imageDataUri: `data:${mimeType};base64,${bytes.toString("base64")}`,
        };
      }
    }

    if (await this.isBinaryFile(resolved)) {
      return this.rejectedFileResponse(requestedPath, "Binary file");
    }

    const raw = await fs.promises.readFile(resolved, "utf8");
    const eol = raw.includes("\r\n") ? LINE_ENDINGS.CRLF : LINE_ENDINGS.LF;
    const relPath = this.relativePath(resolved);

    const redactedContent = secretRedactionService.redactText(raw);
    const wasRedacted = redactedContent !== raw;

    return {
      path: relPath,
      name: path.basename(resolved),
      language: languageFromPath(resolved),
      size: stat.size,
      eol,
      content: redactedContent,
      ...(wasRedacted
        ? {
            readOnly: true,
            reason:
              "File contains secrets and cannot be edited in the hosted viewer",
          }
        : {}),
    };
  }

  private rejectedFileResponse(
    requestedPath: string,
    reason: string
  ): WorkspaceFileResponse {
    return {
      path: requestedPath,
      name: path.basename(requestedPath),
      size: 0,
      eol: "lf",
      content: "",
      readOnly: true,
      reason,
    };
  }

  private async isBinaryFile(filePath: string): Promise<boolean> {
    let fd: fs.promises.FileHandle | undefined;
    try {
      fd = await fs.promises.open(filePath, "r");
      const buffer = Buffer.alloc(BINARY_CHECK_BYTES);
      const { bytesRead } = await fd.read(buffer, 0, BINARY_CHECK_BYTES, 0);
      for (let i = 0; i < bytesRead; i++) {
        if (buffer[i] === 0) return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      await fd?.close();
    }
  }

  // ── File save ────────────────────────────────────────────────────────────

  async saveFile(req: WorkspaceFileSaveRequest): Promise<void> {
    const resolved = this.safeResolve(req.path);
    if (!resolved) {
      throw new Error("Path not allowed");
    }

    // Check if existing file is binary — refuse to overwrite
    let originalEol: (typeof LINE_ENDINGS)[keyof typeof LINE_ENDINGS] =
      LINE_ENDINGS.LF;
    let existingContent: string | undefined;
    try {
      if (await this.isBinaryFile(resolved)) {
        throw new Error("Cannot overwrite binary file");
      }
      const existing = await fs.promises.readFile(resolved, "utf8");
      existingContent = existing;
      originalEol = existing.includes("\r\n")
        ? LINE_ENDINGS.CRLF
        : LINE_ENDINGS.LF;
    } catch (err) {
      if (
        err instanceof Error &&
        err.message === "Cannot overwrite binary file"
      ) {
        throw err;
      }
      // File doesn't exist yet — new file, keep LF
    }

    if (
      req.content.includes(REDACTION_MARKER) &&
      !existingContent?.includes(REDACTION_MARKER)
    ) {
      throw new RedactionMarkerSaveError();
    }

    // Normalize incoming content to the original EOL
    let content = req.content.replace(/\r\n/g, "\n");
    if (originalEol === LINE_ENDINGS.CRLF) {
      content = content.replace(/\n/g, "\r\n");
    }

    const tmpPath = `${resolved}.cy-tmp`;
    await fs.promises.writeFile(tmpPath, content, "utf8");
    await fs.promises.rename(tmpPath, resolved);
  }

  // ── File operations ──────────────────────────────────────────────────────

  async deleteEntry(requestedPath: string): Promise<void> {
    const resolved = this.safeResolve(requestedPath);
    if (!resolved || this.isExactRoot(resolved)) {
      throw new Error("Path not allowed");
    }

    await fs.promises.rm(resolved, { recursive: true, force: false });
  }

  async copyEntry(req: WorkspaceCopyRequest): Promise<void> {
    const { resolvedSource, destPath } = await this.resolveTransferPaths(
      req.sourcePath,
      req.destDir,
      req.newName
    );
    await this.ensureDestinationMissing(destPath);
    await fs.promises.cp(resolvedSource, destPath, { recursive: true });
  }

  async moveEntry(req: WorkspaceMoveRequest): Promise<void> {
    const { resolvedSource, destPath } = await this.resolveTransferPaths(
      req.sourcePath,
      req.destDir,
      req.newName
    );
    await this.ensureDestinationMissing(destPath);
    await fs.promises.rename(resolvedSource, destPath);
  }

  private async resolveTransferPaths(
    sourcePath: string,
    requestedDestDir: string,
    newName?: string
  ): Promise<{ resolvedSource: string; destPath: string }> {
    const resolvedSource = this.safeResolve(sourcePath);
    if (!resolvedSource || this.isExactRoot(resolvedSource)) {
      throw new Error("Path not allowed");
    }
    await fs.promises.lstat(resolvedSource);

    const destinationName = newName ?? path.basename(resolvedSource);
    if (
      !destinationName ||
      path.basename(destinationName) !== destinationName
    ) {
      throw new Error("Path not allowed");
    }

    const trustedRoots = this.trustedRoots;
    const resolvedDestDir = this.resolveAgainstRoots(requestedDestDir);
    if (!isPathWithinAnyDirectory(resolvedDestDir, trustedRoots)) {
      throw new Error("Path not allowed");
    }

    let existingAncestor = resolvedDestDir;
    while (!fs.existsSync(existingAncestor)) {
      const parent = path.dirname(existingAncestor);
      if (parent === existingAncestor) {
        break;
      }
      existingAncestor = parent;
    }

    const realAncestor = await fs.promises.realpath(existingAncestor);
    if (
      !isPathWithinAnyDirectory(realAncestor, this.realpathsOf(trustedRoots))
    ) {
      throw new Error("Path not allowed");
    }

    const destPath = path.resolve(resolvedDestDir, destinationName);
    if (!isPathWithinAnyDirectory(destPath, trustedRoots)) {
      throw new Error("Path not allowed");
    }

    return { resolvedSource, destPath };
  }

  private async ensureDestinationMissing(destPath: string): Promise<void> {
    try {
      await fs.promises.access(destPath);
      throw new Error("Destination already exists");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        return;
      }
      throw err;
    }
  }

  // ── Git status ───────────────────────────────────────────────────────────

  /**
   * SCM status. With no `repoId`, aggregates every discovered repo (what the
   * explorer needs to color files across all roots); with a `repoId`, reports
   * just that repo (what the SCM pane's repo selector needs). Sync counts sum
   * across repos in the aggregate case.
   */
  async getStatus(repoId?: string): Promise<WorkspaceScmStatusResponse> {
    const repos = await this.getReposInternal();
    const targetRepos = repoId
      ? repos.filter((repo) => repo.id === repoId)
      : repos;

    if (targetRepos.length === 0) {
      return { files: [], incomingCommitCount: 0, outgoingCommitCount: 0 };
    }

    const results = await Promise.all(
      targetRepos.map((repo) => this.getRepoStatus(repo.rootPath))
    );

    return {
      files: results.flatMap((result) => result.files),
      incomingCommitCount: results.reduce(
        (sum, result) => sum + result.incomingCommitCount,
        0
      ),
      outgoingCommitCount: results.reduce(
        (sum, result) => sum + result.outgoingCommitCount,
        0
      ),
    };
  }

  /** Status for a single repo toplevel, with viewer-prefixed file paths. */
  private async getRepoStatus(
    repoRoot: string
  ): Promise<WorkspaceScmStatusResponse> {
    const [statusResult, syncCountsResult] = await Promise.allSettled([
      execFileAsync(
        "git",
        [
          "-c",
          "core.quotepath=false",
          "-C",
          repoRoot,
          "status",
          "--porcelain=v1",
          "-z",
        ],
        { timeout: GIT_TIMEOUT_MS }
      ),
      this.getSyncCounts(repoRoot),
    ]);

    if (statusResult.status !== PROMISE_SETTLED_STATUSES.FULFILLED) {
      return {
        files: [],
        incomingCommitCount: 0,
        outgoingCommitCount: 0,
      };
    }

    const syncCounts =
      syncCountsResult.status === PROMISE_SETTLED_STATUSES.FULFILLED
        ? syncCountsResult.value
        : {
            incomingCommitCount: 0,
            outgoingCommitCount: 0,
          };

    return {
      files: this.parsePorcelainV1(statusResult.value.stdout, repoRoot),
      ...syncCounts,
    };
  }

  private async getSyncCounts(
    repoRoot: string
  ): Promise<
    Pick<
      WorkspaceScmStatusResponse,
      "incomingCommitCount" | "outgoingCommitCount"
    >
  > {
    try {
      const { stdout } = await execFileAsync(
        "git",
        [
          "-C",
          repoRoot,
          "rev-list",
          "--left-right",
          "--count",
          "@{upstream}...HEAD",
        ],
        { timeout: GIT_TIMEOUT_MS }
      );
      const [incomingRaw, outgoingRaw] = stdout.trim().split(/\s+/);
      return {
        incomingCommitCount: this.parseCommitCount(incomingRaw),
        outgoingCommitCount: this.parseCommitCount(outgoingRaw),
      };
    } catch {
      return {
        incomingCommitCount: 0,
        outgoingCommitCount: 0,
      };
    }
  }

  private parseCommitCount(value: string | undefined): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  /**
   * Parse `git status --porcelain=v1 -z` output for a repo rooted at `repoRoot`.
   * Git reports repo-relative paths; each is mapped back to a viewer path via
   * `relativePath()` (plain in single-root, folder-name-prefixed in multi-root)
   * so status entries match the same convention as the tree/file/diff APIs and
   * reference-link resolution — regardless of which repo produced them. Files
   * that fall outside every trusted root (possible when a root is nested below
   * its repo toplevel) are skipped since the viewer can't browse them.
   */
  private parsePorcelainV1(
    output: string,
    repoRoot: string
  ): WorkspaceScmStatusResponse["files"] {
    const trustedRoots = this.trustedRoots;
    const files: WorkspaceScmFile[] = [];

    const nulDelimited = output.includes("\0");
    const records = nulDelimited ? output.split("\0") : output.split(/\r?\n/);
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record || record.length < 4) {
        continue;
      }
      const x = record[0] ?? " ";
      const y = record[1] ?? " ";
      let filePath = record.slice(3);

      // In -z mode rename/copy records list the new path first and the
      // original path in the following NUL-terminated field.
      let renamedFrom: string | undefined;
      if (x === "R" || y === "R" || x === "C" || y === "C") {
        if (nulDelimited) {
          renamedFrom = records[index + 1];
          index++;
        } else {
          const separatorIndex = filePath.indexOf(" -> ");
          if (separatorIndex >= 0) {
            renamedFrom = filePath.slice(0, separatorIndex);
            filePath = filePath.slice(separatorIndex + 4);
          }
        }
      }

      const normalized = normalizeScmPath(decodeGitPath(filePath));
      if (!normalized) {
        continue;
      }
      const absPath = path.resolve(repoRoot, normalized);
      if (!isPathWithinAnyDirectory(absPath, trustedRoots)) {
        continue;
      }

      const isUntracked = x === "?" && y === "?";
      const stagedStatus = isUntracked ? null : x !== " " ? x : null;
      const unstagedStatus = y !== " " ? y : null;

      let kind: DiffKind;
      if (isUntracked) {
        kind = SCM_FILE_KINDS.UNTRACKED;
      } else if (x === "A") {
        kind = SCM_FILE_KINDS.ADDED;
      } else if (x === "D" || y === "D") {
        kind = SCM_FILE_KINDS.DELETED;
      } else if (x === "R") {
        kind = SCM_FILE_KINDS.RENAMED;
      } else {
        kind = SCM_FILE_KINDS.MODIFIED;
      }

      files.push({
        path: this.relativePath(absPath),
        stagedStatus,
        unstagedStatus,
        kind,
      });

      if (renamedFrom) {
        const oldPath = normalizeScmPath(decodeGitPath(renamedFrom));
        if (oldPath) {
          const oldAbsPath = path.resolve(repoRoot, oldPath);
          if (isPathWithinAnyDirectory(oldAbsPath, trustedRoots)) {
            files.push({
              path: this.relativePath(oldAbsPath),
              stagedStatus,
              unstagedStatus,
              kind: SCM_FILE_KINDS.DELETED,
            });
          }
        }
      }
    }

    return files;
  }

  // ── Git diff ─────────────────────────────────────────────────────────────

  async getDiff(requestedPath: string): Promise<WorkspaceScmDiffResponse> {
    const resolved = this.safeResolve(requestedPath);
    if (!resolved) {
      throw new Error("Path not allowed");
    }
    const repoRoot = await this.requireRepoRootForPath(resolved);

    const relPath = this.relativePath(resolved);
    const normalizedRelPath = normalizeScmPath(relPath);
    const gitPath = toGitPath(this.relativeToRepo(resolved, repoRoot));
    const language = languageFromPath(resolved);

    // Determine kind from the owning repo's status.
    const status = await this.getRepoStatus(repoRoot);
    const fileStatus = status.files.find(
      (f) => normalizeScmPath(f.path) === normalizedRelPath
    );
    const kind: DiffKind = fileStatus?.kind ?? "modified";

    const oldBytes = await getBlobBytes(repoRoot, "HEAD", gitPath);
    let newBytes: Buffer | null = null;

    if (kind !== SCM_FILE_KINDS.DELETED) {
      try {
        newBytes = await fs.promises.readFile(resolved);
      } catch {
        newBytes = null;
      }
    }

    const responsePath = fileStatus?.path ?? normalizedRelPath;
    if (isImageRefPath(resolved)) {
      const image = this.buildImageDiffSides(
        oldBytes,
        newBytes,
        resolved,
        gitPath
      );
      if (image) {
        return {
          path: responsePath,
          kind,
          payloadKind: DIFF_PAYLOAD_KINDS.IMAGE,
          image,
        } as WorkspaceScmDiffResponse;
      }
    }

    if (this.isBinaryBuffer(oldBytes) || this.isBinaryBuffer(newBytes)) {
      return {
        path: responsePath,
        kind,
        payloadKind: DIFF_PAYLOAD_KINDS.BINARY,
      } as WorkspaceScmDiffResponse;
    }

    return {
      path: responsePath,
      language,
      oldContent: oldBytes?.toString("utf8") ?? "",
      newContent: newBytes?.toString("utf8") ?? "",
      kind,
      payloadKind: DIFF_PAYLOAD_KINDS.TEXT,
    };
  }

  private isBinaryBuffer(buffer: Buffer | null): boolean {
    if (!buffer) return false;
    const bytesToCheck = Math.min(buffer.length, BINARY_CHECK_BYTES);
    for (let index = 0; index < bytesToCheck; index++) {
      if (buffer[index] === 0) return true;
    }
    return false;
  }

  private buildImageDiffSides(
    oldBytes: Buffer | null,
    newBytes: Buffer | null,
    newPath: string,
    oldPath: string
  ): { oldImageDataUri?: string; newImageDataUri?: string } | null {
    const oldExtension = path.extname(oldPath).replace(/^\./, "");
    const newExtension = path.extname(newPath).replace(/^\./, "");
    const oldMimeType = imageExtensionToMimeType(oldExtension);
    const newMimeType = imageExtensionToMimeType(newExtension);
    if ((oldBytes && !oldMimeType) || (newBytes && !newMimeType)) {
      return null;
    }

    return {
      oldImageDataUri:
        oldBytes && oldMimeType
          ? `data:${oldMimeType};base64,${oldBytes.toString("base64")}`
          : undefined,
      newImageDataUri:
        newBytes && newMimeType
          ? `data:${newMimeType};base64,${newBytes.toString("base64")}`
          : undefined,
    };
  }

  private buildGitRefDiffEntry(
    repoRoot: string,
    newGitPath: string,
    oldGitPath: string,
    oldBytes: Buffer | null,
    newBytes: Buffer | null,
    changeType: DiffChangeType,
    includeOldPath: boolean
  ): WorkspaceGitRefDiffEntry | null {
    const absolutePath = path.resolve(repoRoot, newGitPath);
    const oldAbsolutePath = path.resolve(repoRoot, oldGitPath);
    if (
      !isPathWithinAnyDirectory(absolutePath, this.trustedRoots) ||
      !isPathWithinAnyDirectory(oldAbsolutePath, this.trustedRoots)
    ) {
      return null;
    }

    const entry = {
      path: normalizeViewerPath(this.relativePath(absolutePath)),
      ...(includeOldPath
        ? {
            oldPath: normalizeViewerPath(this.relativePath(oldAbsolutePath)),
          }
        : {}),
      changeType,
    };

    if (isImageRefPath(newGitPath)) {
      const image = this.buildImageDiffSides(
        oldBytes,
        newBytes,
        newGitPath,
        oldGitPath
      );
      if (image) {
        return {
          ...entry,
          payloadKind: DIFF_PAYLOAD_KINDS.IMAGE,
          image,
        };
      }
    }

    if (this.isBinaryBuffer(oldBytes) || this.isBinaryBuffer(newBytes)) {
      return {
        ...entry,
        payloadKind: DIFF_PAYLOAD_KINDS.BINARY,
      };
    }

    return {
      ...entry,
      payloadKind: DIFF_PAYLOAD_KINDS.TEXT,
      language: languageFromPath(absolutePath),
      oldContent: oldBytes?.toString("utf8") ?? "",
      newContent: newBytes?.toString("utf8") ?? "",
    };
  }

  // ── Git stage / unstage ──────────────────────────────────────────────────

  async stageFile(filePath: string): Promise<void> {
    const resolved = this.safeResolve(filePath);
    if (!resolved) throw new Error("Path not allowed");
    const repoRoot = await this.requireRepoRootForPath(resolved);
    const relPath = toGitPath(this.relativeToRepo(resolved, repoRoot));
    await execFileAsync("git", ["-C", repoRoot, "add", "--", relPath], {
      timeout: GIT_TIMEOUT_MS,
    });
  }

  async unstageFile(filePath: string): Promise<void> {
    const resolved = this.safeResolve(filePath);
    if (!resolved) throw new Error("Path not allowed");
    const repoRoot = await this.requireRepoRootForPath(resolved);
    const relPath = toGitPath(this.relativeToRepo(resolved, repoRoot));
    await execFileAsync(
      "git",
      ["-C", repoRoot, "restore", "--staged", "--", relPath],
      { timeout: GIT_TIMEOUT_MS }
    );
  }

  async discardFile(filePath: string): Promise<void> {
    const resolved = this.safeResolve(filePath);
    if (!resolved) throw new Error("Path not allowed");
    const repoRoot = await this.requireRepoRootForPath(resolved);

    const relPath = this.relativePath(resolved);
    const normalizedRelPath = normalizeScmPath(relPath);
    const status = await this.getRepoStatus(repoRoot);
    const fileStatus = status.files.find(
      (file) => normalizeScmPath(file.path) === normalizedRelPath
    );

    if (fileStatus?.kind === SCM_FILE_KINDS.UNTRACKED) {
      await fs.promises.rm(resolved, { recursive: true, force: true });
      return;
    }

    await execFileAsync(
      "git",
      [
        "-C",
        repoRoot,
        "restore",
        "--worktree",
        "--",
        toGitPath(this.relativeToRepo(resolved, repoRoot)),
      ],
      { timeout: GIT_TIMEOUT_MS }
    );
  }

  // ── Git commit ───────────────────────────────────────────────────────────

  async commit(message: string, repoId?: string): Promise<void> {
    if (!message.trim()) throw new Error("Commit message is required");
    const repoRoot = await this.resolveRepoRoot(repoId);
    await execFileAsync("git", ["-C", repoRoot, "commit", "-m", message], {
      timeout: GIT_TIMEOUT_MS,
    });
  }

  // ── Git push ─────────────────────────────────────────────────────────────

  async push(repoId?: string): Promise<WorkspacePushResponse> {
    const repoRoot = await this.resolveRepoRoot(repoId);
    const [branch, remote] = await Promise.all([
      this.currentBranch(repoRoot),
      this.currentRemote(repoRoot),
    ]);
    await execFileAsync("git", ["-C", repoRoot, "push"], {
      timeout: GIT_TIMEOUT_MS,
    });
    return { branch, remote };
  }

  // ── Commit message generation ────────────────────────────────────────────

  async generateCommitMessage(
    instructions?: string,
    repoId?: string
  ): Promise<CommitResult | null> {
    const repoRoot = await this.resolveRepoRoot(repoId);
    const diffResult = await this.commitGenerator.getDiff(repoRoot);
    if (!diffResult) {
      return null;
    }

    const { message, prompt, cliCommand, workflowKey, runRef } =
      await this.commitGenerator.generateMessage(
        diffResult.diff,
        repoRoot,
        undefined,
        instructions
      );

    commitMessageGenerationTracker.setLastRecord({
      source: "workspace-viewer",
      workingDirectory: repoRoot,
      commands: diffResult.commands,
      output: diffResult.diff,
      staged: diffResult.staged,
      truncated: diffResult.truncated,
      includesUntrackedFiles: diffResult.includesUntrackedFiles,
      generatedAt: Date.now(),
      prompt,
      generatedMessage: message,
      cliCommand,
      workflowKey,
      runRef,
    });

    return {
      message,
      staged: diffResult.staged,
      truncated: diffResult.truncated,
    };
  }

  // ── Git pull ─────────────────────────────────────────────────────────────

  async pull(repoId?: string): Promise<WorkspacePullResponse> {
    const repoRoot = await this.resolveRepoRoot(repoId);
    const [branch, remote] = await Promise.all([
      this.currentBranch(repoRoot),
      this.currentRemote(repoRoot),
    ]);
    await execFileAsync("git", ["-C", repoRoot, "pull"], {
      timeout: GIT_TIMEOUT_MS,
    });
    return { branch, remote };
  }

  // ── Git helpers ──────────────────────────────────────────────────────────

  private async currentBranch(repoRoot: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoRoot, "branch", "--show-current"],
        { timeout: GIT_TIMEOUT_MS }
      );
      return stdout.trim() || "HEAD";
    } catch {
      return "HEAD";
    }
  }

  private async currentRemote(repoRoot: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoRoot, "remote"],
        { timeout: GIT_TIMEOUT_MS }
      );
      return stdout.trim().split("\n")[0] ?? "origin";
    } catch {
      return "origin";
    }
  }

  // ── Commit log ───────────────────────────────────────────────────────────

  async getFileHistory(
    requestedPath: string,
    offset = 0,
    pageSize?: number,
    historyId?: string,
    repoId?: string
  ): Promise<WorkspaceFileHistoryPageResponse> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new WorkspaceTreeBadRequestError(
        "offset must be a non-negative integer"
      );
    }

    const resolved = this.safeResolve(requestedPath);
    if (!resolved) throw new Error("Path not allowed");
    const repoRoot = await this.requireRepoRootForPath(resolved);
    const viewerPath = normalizeViewerPath(this.relativePath(resolved));
    void repoId;

    if (historyId !== undefined) {
      if (!isValidHistoryId(historyId)) {
        throw new WorkspaceTreeBadRequestError("historyId is invalid");
      }
      const snapshot = this.getFileHistorySnapshot(historyId);
      if (!snapshot) throw new WorkspaceTreeExpiredError();
      if (
        !pathsEqual(snapshot.repoRoot, repoRoot) ||
        snapshot.requestedPath !== viewerPath
      ) {
        throw new WorkspaceTreeBadRequestError(
          "path does not match the history snapshot"
        );
      }
      if (offset % snapshot.pageSize !== 0) {
        throw new WorkspaceTreeBadRequestError(
          "offset must be aligned to pageSize"
        );
      }
      if (offset > snapshot.entries.length) {
        throw new WorkspaceTreeBadRequestError("offset is outside the history");
      }
      return this.materializeFileHistoryPage(snapshot, offset);
    }

    const resolvedPageSize = this.resolveFileHistoryPageSize(pageSize);
    try {
      const stat = await fs.promises.stat(resolved);
      if (stat.isDirectory()) {
        throw new WorkspaceTreeBadRequestError("path must be a file");
      }
    } catch (error) {
      if (error instanceof WorkspaceTreeBadRequestError) throw error;
      // A deleted file can still have useful history, so an absent current
      // filesystem entry is allowed; Git remains the source of truth below.
    }

    const gitPath = toGitPath(this.relativeToRepo(resolved, repoRoot));
    const headHash = await resolveCommit(repoRoot, "HEAD");
    const [historyRows, unpushedHashes] = await Promise.all([
      // Omitting max-count is intentional: the complete result is the frozen
      // snapshot from which all later pages are served.
      getFileHistoryCommits(repoRoot, gitPath, undefined, 0, headHash, true),
      this.getUnpushedHistoryHashes(repoRoot, headHash),
    ]);
    const entries = historyRows
      .filter((row) => {
        const oldAbsolute = path.resolve(repoRoot, row.oldPath);
        const newAbsolute = path.resolve(repoRoot, row.path);
        return (
          isPathWithinAnyDirectory(oldAbsolute, this.trustedRoots) &&
          isPathWithinAnyDirectory(newAbsolute, this.trustedRoots)
        );
      })
      .map(
        (row) =>
          ({
            hash: row.hash,
            shortHash: row.shortHash,
            subject: row.subject,
            author: row.author,
            relativeDate: row.relativeDate,
            isHead: row.hash === headHash,
            pushed: !unpushedHashes.has(row.hash),
            refs: classifyRefNames(row.refNames),
            isMerge: row.parentHashes.length > 1,
            parentHashes: row.parentHashes,
            path: normalizeViewerPath(
              this.relativePath(path.resolve(repoRoot, row.path))
            ),
            oldPath: normalizeViewerPath(
              this.relativePath(path.resolve(repoRoot, row.oldPath))
            ),
          }) satisfies WorkspaceFileHistoryEntry
      );

    const snapshot: FileHistorySnapshot = {
      historyId: this.createFileHistoryId(),
      requestedPath: viewerPath,
      repoRoot,
      headHash,
      pageSize: resolvedPageSize,
      entries: Object.freeze(entries),
      lastAccessedAt: Date.now(),
    };
    this.fileHistorySnapshots.set(snapshot.historyId, snapshot);
    this.trimFileHistorySnapshots();

    if (offset % snapshot.pageSize !== 0) {
      throw new WorkspaceTreeBadRequestError(
        "offset must be aligned to pageSize"
      );
    }
    if (offset > snapshot.entries.length) {
      throw new WorkspaceTreeBadRequestError("offset is outside the history");
    }
    return this.materializeFileHistoryPage(snapshot, offset);
  }

  async getFileHistoryDiff(
    requestedPath: string,
    commit: string,
    repoId?: string
  ): Promise<WorkspaceFileHistoryDiffResponse> {
    const resolved = this.safeResolve(requestedPath);
    if (!resolved) throw new Error("Path not allowed");
    const repoRoot = await this.requireRepoRootForPath(resolved);
    void repoId;

    const resolvedCommit = await resolveCommit(repoRoot, commit);

    const requestedGitPath = toGitPath(this.relativeToRepo(resolved, repoRoot));
    const changedFiles = await getChangedFilesWithBinaryStatus(repoRoot, [
      "show",
      "--format=",
      "--no-ext-diff",
      "--end-of-options",
      resolvedCommit,
    ]);
    const changedFile = changedFiles.find(
      (file) =>
        file.path === requestedGitPath || file.oldPath === requestedGitPath
    );
    if (!changedFile) {
      throw new WorkspaceTreeBadRequestError(
        "commit does not touch the requested path"
      );
    }

    const commitPath = changedFile.path;
    const parentPath = changedFile.oldPath ?? commitPath;
    const commitAbsolutePath = path.resolve(repoRoot, commitPath);
    const parentAbsolutePath = path.resolve(repoRoot, parentPath);
    if (
      !isPathWithinAnyDirectory(commitAbsolutePath, this.trustedRoots) ||
      !isPathWithinAnyDirectory(parentAbsolutePath, this.trustedRoots)
    ) {
      throw new Error("Path not allowed");
    }

    const [oldBytes, newBytes, commitInfo] = await Promise.all([
      getBlobBytes(repoRoot, `${resolvedCommit}^`, parentPath),
      getBlobBytes(repoRoot, resolvedCommit, commitPath),
      getCommitInfo(repoRoot, resolvedCommit),
    ]);
    const changeType = this.diffChangeType(changedFile.status);
    const entry = this.buildGitRefDiffEntry(
      repoRoot,
      commitPath,
      parentPath,
      oldBytes,
      newBytes,
      changeType,
      true
    );
    if (!entry) throw new Error("Path not allowed");
    return {
      ...commitInfo,
      ...entry,
      oldPath: normalizeViewerPath(this.relativePath(parentAbsolutePath)),
    };
  }

  private resolveFileHistoryPageSize(requestedPageSize?: number): number {
    if (requestedPageSize === undefined) {
      return WORKSPACE_FILE_HISTORY_DEFAULT_PAGE_SIZE;
    }
    if (!Number.isSafeInteger(requestedPageSize) || requestedPageSize < 1) {
      throw new WorkspaceTreeBadRequestError(
        "pageSize must be a positive integer"
      );
    }
    return Math.min(WORKSPACE_FILE_HISTORY_MAX_PAGE_SIZE, requestedPageSize);
  }

  private createFileHistoryId(): string {
    let historyId = randomUUID();
    while (this.fileHistorySnapshots.has(historyId)) {
      historyId = randomUUID();
    }
    return historyId;
  }

  private getFileHistorySnapshot(
    historyId: string
  ): FileHistorySnapshot | undefined {
    const now = Date.now();
    for (const [id, snapshot] of this.fileHistorySnapshots) {
      if (now - snapshot.lastAccessedAt >= FILE_HISTORY_SNAPSHOT_TTL_MS) {
        this.fileHistorySnapshots.delete(id);
      }
    }
    const snapshot = this.fileHistorySnapshots.get(historyId);
    if (!snapshot) return undefined;
    const refreshed = { ...snapshot, lastAccessedAt: now };
    this.fileHistorySnapshots.delete(historyId);
    this.fileHistorySnapshots.set(historyId, refreshed);
    return refreshed;
  }

  private trimFileHistorySnapshots(): void {
    while (this.fileHistorySnapshots.size > FILE_HISTORY_SNAPSHOT_MAX_COUNT) {
      const oldest = this.fileHistorySnapshots.keys().next().value;
      if (oldest === undefined) return;
      this.fileHistorySnapshots.delete(oldest);
    }
  }

  private materializeFileHistoryPage(
    snapshot: FileHistorySnapshot,
    offset: number
  ): WorkspaceFileHistoryPageResponse {
    return {
      historyId: snapshot.historyId,
      pageSize: snapshot.pageSize,
      totalEntries: snapshot.entries.length,
      offset,
      entries: snapshot.entries.slice(offset, offset + snapshot.pageSize),
    };
  }

  private createGitRefDiffId(): string {
    let diffId = randomUUID();
    while (this.gitRefDiffSnapshots.has(diffId)) {
      diffId = randomUUID();
    }
    return diffId;
  }

  private getGitRefDiffSnapshot(
    diffId: string
  ): GitRefDiffSnapshot | undefined {
    const now = Date.now();
    for (const [id, snapshot] of this.gitRefDiffSnapshots) {
      if (now - snapshot.lastAccessedAt >= GIT_REF_DIFF_SNAPSHOT_TTL_MS) {
        this.gitRefDiffSnapshots.delete(id);
      }
    }
    const snapshot = this.gitRefDiffSnapshots.get(diffId);
    if (!snapshot) return undefined;
    const refreshed = { ...snapshot, lastAccessedAt: now };
    this.gitRefDiffSnapshots.delete(diffId);
    this.gitRefDiffSnapshots.set(diffId, refreshed);
    return refreshed;
  }

  private trimGitRefDiffSnapshots(): void {
    while (this.gitRefDiffSnapshots.size > GIT_REF_DIFF_SNAPSHOT_MAX_COUNT) {
      const oldest = this.gitRefDiffSnapshots.keys().next().value;
      if (oldest === undefined) return;
      this.gitRefDiffSnapshots.delete(oldest);
    }
  }

  private createCommitLogId(): string {
    let historyId = randomUUID();
    while (this.commitLogSnapshots.has(historyId)) {
      historyId = randomUUID();
    }
    return historyId;
  }

  private getCommitLogSnapshot(
    historyId: string
  ): CommitLogSnapshot | undefined {
    const now = Date.now();
    for (const [id, snapshot] of this.commitLogSnapshots) {
      if (now - snapshot.lastAccessedAt >= COMMIT_LOG_SNAPSHOT_TTL_MS) {
        this.commitLogSnapshots.delete(id);
      }
    }
    const snapshot = this.commitLogSnapshots.get(historyId);
    if (!snapshot) return undefined;
    const refreshed = { ...snapshot, lastAccessedAt: now };
    this.commitLogSnapshots.delete(historyId);
    this.commitLogSnapshots.set(historyId, refreshed);
    return refreshed;
  }

  private trimCommitLogSnapshots(): void {
    while (this.commitLogSnapshots.size > COMMIT_LOG_SNAPSHOT_MAX_COUNT) {
      const oldest = this.commitLogSnapshots.keys().next().value;
      if (oldest === undefined) return;
      this.commitLogSnapshots.delete(oldest);
    }
  }

  private materializeCommitLogPage(
    snapshot: CommitLogSnapshot,
    offset: number
  ): WorkspaceCommitLogResponse {
    return {
      historyId: snapshot.historyId,
      pageSize: snapshot.pageSize,
      totalEntries: snapshot.commits.length,
      offset,
      commits: snapshot.commits.slice(offset, offset + snapshot.pageSize),
      hasMore: offset + snapshot.pageSize < snapshot.commits.length,
      currentBranch: snapshot.currentBranch,
      detached: snapshot.detached,
    };
  }

  private async getUnpushedHistoryHashes(
    repoRoot: string,
    headHash: string
  ): Promise<Set<string>> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoRoot, "rev-list", "--no-walk", `@{upstream}..${headHash}`],
        { timeout: GIT_TIMEOUT_MS }
      );
      return new Set(stdout.trim().split("\n").filter(Boolean));
    } catch {
      return new Set();
    }
  }

  async getCommitLog(
    skip = 0,
    limit = 30,
    branchHint?: string,
    repoId?: string,
    historyId?: string
  ): Promise<WorkspaceCommitLogResponse> {
    if (!Number.isSafeInteger(skip) || skip < 0) {
      throw new WorkspaceTreeBadRequestError(
        "skip must be a non-negative integer"
      );
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new WorkspaceTreeBadRequestError(
        "limit must be a positive integer"
      );
    }

    const repoRoot = await this.resolveRepoRoot(repoId);

    // When detached, the caller passes the branch it came from so the branch's
    // newer ("ahead") commits stay visible instead of vanishing behind HEAD.
    // The hint is a plain ref name validated against existing local branches to
    // avoid feeding arbitrary input to git as a revision.
    const safeBranch = await this.resolveBranchHint(branchHint, repoRoot);

    if (historyId !== undefined) {
      if (!isValidHistoryId(historyId)) {
        throw new WorkspaceTreeBadRequestError("historyId is invalid");
      }
      const snapshot = this.getCommitLogSnapshot(historyId);
      if (!snapshot) throw new WorkspaceTreeExpiredError();
      const { detached } = await this.getCommitLogMetadata(repoRoot);
      if (
        !pathsEqual(snapshot.repoRoot, repoRoot) ||
        snapshot.branchHint !== safeBranch ||
        snapshot.detached !== detached
      ) {
        throw new WorkspaceTreeBadRequestError(
          "context does not match the history snapshot"
        );
      }
      if (skip % snapshot.pageSize !== 0) {
        throw new WorkspaceTreeBadRequestError(
          "skip must be aligned to pageSize"
        );
      }
      if (skip > snapshot.commits.length) {
        throw new WorkspaceTreeBadRequestError(
          "skip is outside the commit history"
        );
      }
      return this.materializeCommitLogPage(snapshot, skip);
    }

    const metadata = await this.getCommitLogMetadata(repoRoot);
    // Omitting max-count is intentional: the complete result is the frozen
    // snapshot from which all later pages are served.
    const rows = await getRecentCommits(
      repoRoot,
      undefined,
      0,
      safeBranch,
      true
    );
    const commits: WorkspaceCommitLogEntry[] = rows.map((c) => ({
      hash: c.hash,
      shortHash: c.shortHash,
      subject: c.subject,
      author: c.author,
      relativeDate: c.relativeDate,
      isHead: metadata.headHash !== null && c.hash === metadata.headHash,
      pushed: !metadata.unpushedHashes.has(c.hash),
      isMerge: c.parentHashes.length > 1,
      parentHashes: c.parentHashes,
      refs: classifyRefNames(c.refNames),
    }));

    const snapshot: CommitLogSnapshot = {
      historyId: this.createCommitLogId(),
      repoRoot,
      branchHint: safeBranch,
      detached: metadata.detached,
      currentBranch: metadata.currentBranch,
      pageSize: limit,
      commits: Object.freeze(commits),
      lastAccessedAt: Date.now(),
    };
    this.commitLogSnapshots.set(snapshot.historyId, snapshot);
    this.trimCommitLogSnapshots();

    if (skip % snapshot.pageSize !== 0) {
      throw new WorkspaceTreeBadRequestError(
        "skip must be aligned to pageSize"
      );
    }
    if (skip > snapshot.commits.length) {
      throw new WorkspaceTreeBadRequestError(
        "skip is outside the commit history"
      );
    }
    return this.materializeCommitLogPage(snapshot, skip);
  }

  private async getCommitLogMetadata(repoRoot: string): Promise<{
    detached: boolean;
    currentBranch: string | null;
    headHash: string | null;
    unpushedHashes: Set<string>;
  }> {
    const [branchName, headHashResult, upstreamCommitsResult] =
      await Promise.allSettled([
        execFileAsync("git", ["-C", repoRoot, "branch", "--show-current"], {
          timeout: GIT_TIMEOUT_MS,
        }),
        execFileAsync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
          timeout: GIT_TIMEOUT_MS,
        }),
        execFileAsync(
          "git",
          ["-C", repoRoot, "rev-list", "--no-walk", "@{upstream}..HEAD"],
          { timeout: GIT_TIMEOUT_MS }
        ),
      ]);

    const rawBranch =
      branchName.status === PROMISE_SETTLED_STATUSES.FULFILLED
        ? branchName.value.stdout.trim()
        : "HEAD";
    const detached = rawBranch === "" || rawBranch === "HEAD";
    const currentBranch = detached ? null : rawBranch;
    const headHash =
      headHashResult.status === PROMISE_SETTLED_STATUSES.FULFILLED
        ? headHashResult.value.stdout.trim()
        : null;

    const unpushedHashes = new Set<string>();
    if (upstreamCommitsResult.status === PROMISE_SETTLED_STATUSES.FULFILLED) {
      for (const line of upstreamCommitsResult.value.stdout
        .trim()
        .split("\n")
        .filter(Boolean)) {
        unpushedHashes.add(line.trim());
      }
    }
    // If no upstream is configured, upstreamCommitsResult fails — treat all as pushed.
    return { detached, currentBranch, headHash, unpushedHashes };
  }

  /**
   * Validates a branch hint against the repo's local branches. Returns the
   * branch name when it exists, otherwise undefined (falls back to HEAD).
   */
  private async resolveBranchHint(
    branchHint: string | undefined,
    repoRoot: string
  ): Promise<string | undefined> {
    const name = branchHint?.trim();
    if (!name) return undefined;
    try {
      await execFileAsync(
        "git",
        [
          "-C",
          repoRoot,
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${name}`,
        ],
        { timeout: GIT_TIMEOUT_MS }
      );
      return name;
    } catch {
      return undefined;
    }
  }

  // ── Checkout ─────────────────────────────────────────────────────────────

  async checkoutCommit(
    hash: string,
    repoId?: string
  ): Promise<{ detached: boolean }> {
    const repoRoot = await this.resolveRepoRoot(repoId);
    // Validate the hash exists as a commit object
    await execFileAsync(
      "git",
      ["-C", repoRoot, "cat-file", "-e", `${hash}^{commit}`],
      { timeout: GIT_TIMEOUT_MS }
    );
    await execFileAsync("git", ["-C", repoRoot, "checkout", hash], {
      timeout: GIT_TIMEOUT_MS,
    });
    return { detached: true };
  }

  async checkoutBranch(
    branch: string,
    repoId?: string
  ): Promise<{ branch: string }> {
    const repoRoot = await this.resolveRepoRoot(repoId);
    await execFileAsync("git", ["-C", repoRoot, "checkout", branch], {
      timeout: GIT_TIMEOUT_MS,
    });
    return { branch };
  }

  // ── Git ref diff ──────────────────────────────────────────────────────────

  private resolveGitRefDiff(ref: string): GitRefDiffResolution {
    if (ref === GIT_REF_DIFF_REFS.WORKING_TREE) {
      return {
        kind: "workingTree",
        sources: { baseRef: ":", targetIsWorkingTree: true },
        changedFilesArgs: ["diff"],
      };
    }
    if (ref === GIT_REF_DIFF_REFS.STAGED) {
      return {
        kind: GIT_CHANGE_KINDS.STAGED,
        sources: {
          baseRef: "HEAD",
          targetRef: ":",
          targetIsWorkingTree: false,
        },
        changedFilesArgs: ["diff", "--cached"],
      };
    }
    if (ref.startsWith(GIT_REF_DIFF_REFS.STASH_PREFIX)) {
      const index = parseInt(
        ref.slice(GIT_REF_DIFF_REFS.STASH_PREFIX.length),
        10
      );
      if (!Number.isFinite(index)) {
        throw new Error(`Invalid stash ref: ${ref}`);
      }
      const stashRef = `stash@{${index}}`;
      return {
        kind: "stash",
        sources: {
          baseRef: `${stashRef}^1`,
          targetRef: stashRef,
          targetIsWorkingTree: false,
        },
        changedFilesArgs: ["stash", "show", stashRef],
        stashIndex: index,
      };
    }

    const hash = ref.startsWith("~") ? ref.slice(1) : ref;
    return {
      kind: "commit",
      sources: {
        baseRef: `${hash}^`,
        targetRef: hash,
        targetIsWorkingTree: false,
      },
      changedFilesArgs: [
        "show",
        "--format=",
        "--no-ext-diff",
        "--end-of-options",
        hash,
      ],
      commitHash: hash,
    };
  }

  private diffChangeType(status: string): DiffChangeType {
    const statusCode = status[0];
    const changeTypes: Record<string, DiffChangeType> = {
      A: DIFF_CHANGE_TYPES.CREATED,
      C: DIFF_CHANGE_TYPES.RENAMED,
      D: DIFF_CHANGE_TYPES.DELETED,
      R: DIFF_CHANGE_TYPES.RENAMED,
    };
    return changeTypes[statusCode ?? ""] ?? DIFF_CHANGE_TYPES.MODIFIED;
  }

  private async readWorkingTreeDiffBytes(
    repoRoot: string,
    gitPath: string,
    changeType: DiffChangeType
  ): Promise<Buffer | null> {
    if (changeType === DIFF_CHANGE_TYPES.DELETED) return null;
    try {
      return await fs.promises.readFile(path.join(repoRoot, gitPath));
    } catch {
      return null;
    }
  }

  private async buildNonTextDiffEntries(
    repoRoot: string,
    changedFiles: readonly GitChangedFile[],
    sources: NonTextDiffSources
  ): Promise<WorkspaceGitRefDiffResponse["nonTextEntries"]> {
    const entries = await Promise.all(
      changedFiles
        .filter((file) => file.isBinary)
        .map(async (file) => {
          const absolutePath = path.resolve(repoRoot, file.path);
          if (!isPathWithinAnyDirectory(absolutePath, this.trustedRoots)) {
            return null;
          }

          const changeType = this.diffChangeType(file.status);
          const oldGitPath = file.oldPath ?? file.path;
          const oldBytes = await getBlobBytes(
            repoRoot,
            sources.baseRef,
            oldGitPath
          );
          const newBytes = sources.targetIsWorkingTree
            ? await this.readWorkingTreeDiffBytes(
                repoRoot,
                file.path,
                changeType
              )
            : await getBlobBytes(
                repoRoot,
                sources.targetRef ?? "HEAD",
                file.path
              );
          const viewerPath = this.relativePath(absolutePath);
          const viewerOldPath = file.oldPath
            ? this.relativePath(path.resolve(repoRoot, file.oldPath))
            : undefined;

          if (isImageRefPath(file.path)) {
            const image = this.buildImageDiffSides(
              oldBytes,
              newBytes,
              file.path,
              oldGitPath
            );
            if (image) {
              return {
                path: viewerPath,
                oldPath: viewerOldPath,
                changeType,
                payloadKind: DIFF_PAYLOAD_KINDS.IMAGE,
                image,
              };
            }
          }

          return {
            path: viewerPath,
            oldPath: viewerOldPath,
            changeType,
            payloadKind: DIFF_PAYLOAD_KINDS.BINARY,
          };
        })
    );
    return entries.filter(
      (entry): entry is NonNullable<typeof entry> => entry !== null
    );
  }

  private resolveGitRefDiffPageSize(requestedPageSize?: number): number {
    if (requestedPageSize === undefined) {
      return WORKSPACE_GIT_REF_DIFF_DEFAULT_PAGE_SIZE;
    }
    if (
      !Number.isSafeInteger(requestedPageSize) ||
      requestedPageSize < WORKSPACE_GIT_REF_DIFF_MIN_PAGE_SIZE
    ) {
      throw new WorkspaceTreeBadRequestError(
        "pageSize must be a positive integer"
      );
    }
    return Math.min(WORKSPACE_GIT_REF_DIFF_MAX_PAGE_SIZE, requestedPageSize);
  }

  private isVisibleGitChangedFile(
    repoRoot: string,
    file: GitChangedFile
  ): boolean {
    const newAbsolutePath = path.resolve(repoRoot, file.path);
    const oldAbsolutePath = path.resolve(repoRoot, file.oldPath ?? file.path);
    return (
      isPathWithinAnyDirectory(newAbsolutePath, this.trustedRoots) &&
      isPathWithinAnyDirectory(oldAbsolutePath, this.trustedRoots)
    );
  }

  private async buildGitRefDiffPageEntry(
    repoRoot: string,
    file: GitChangedFile,
    sources: NonTextDiffSources
  ): Promise<WorkspaceGitRefDiffEntry | null> {
    const oldGitPath = file.oldPath ?? file.path;
    const [oldBytes, newBytes] = await Promise.all([
      getBlobBytes(repoRoot, sources.baseRef, oldGitPath),
      sources.targetIsWorkingTree
        ? this.readWorkingTreeDiffBytes(
            repoRoot,
            file.path,
            this.diffChangeType(file.status)
          )
        : getBlobBytes(repoRoot, sources.targetRef ?? "HEAD", file.path),
    ]);
    return this.buildGitRefDiffEntry(
      repoRoot,
      file.path,
      oldGitPath,
      oldBytes,
      newBytes,
      this.diffChangeType(file.status),
      file.oldPath !== undefined
    );
  }

  async getGitRefDiffPage(
    ref: string,
    offset = 0,
    pageSize?: number,
    diffId?: string,
    repoId?: string
  ): Promise<WorkspaceGitRefDiffPageResponse> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new WorkspaceTreeBadRequestError(
        "offset must be a non-negative integer"
      );
    }

    const repoRoot = await this.resolveRepoRoot(repoId);
    let snapshot: GitRefDiffSnapshot;

    if (diffId !== undefined) {
      if (!isValidHistoryId(diffId)) {
        throw new WorkspaceTreeBadRequestError("diffId is invalid");
      }
      const existing = this.getGitRefDiffSnapshot(diffId);
      if (!existing) throw new WorkspaceTreeExpiredError();
      if (existing.ref !== ref || !pathsEqual(existing.repoRoot, repoRoot)) {
        throw new WorkspaceTreeBadRequestError(
          "ref or repository does not match the diff snapshot"
        );
      }
      snapshot = existing;
    } else {
      const resolvedPageSize = this.resolveGitRefDiffPageSize(pageSize);
      const resolution = this.resolveGitRefDiff(ref);
      const [changedFiles, commitInfo] = await Promise.all([
        getChangedFilesWithBinaryStatus(repoRoot, resolution.changedFilesArgs),
        resolution.commitHash
          ? getCommitInfo(repoRoot, resolution.commitHash)
          : Promise.resolve(undefined),
      ]);
      const visibleChangedFiles = changedFiles
        .filter((file) => this.isVisibleGitChangedFile(repoRoot, file))
        .map((file) => Object.freeze({ ...file }));
      snapshot = Object.freeze({
        diffId: this.createGitRefDiffId(),
        ref,
        repoRoot,
        pageSize: resolvedPageSize,
        sources: Object.freeze({ ...resolution.sources }),
        changedFiles: Object.freeze(visibleChangedFiles),
        commitInfo: commitInfo ? Object.freeze({ ...commitInfo }) : undefined,
        lastAccessedAt: Date.now(),
      });
      this.gitRefDiffSnapshots.set(snapshot.diffId, snapshot);
      this.trimGitRefDiffSnapshots();
    }

    if (offset % snapshot.pageSize !== 0) {
      throw new WorkspaceTreeBadRequestError(
        "offset must be aligned to pageSize"
      );
    }
    if (offset > snapshot.changedFiles.length) {
      throw new WorkspaceTreeBadRequestError(
        "offset is outside the git ref diff"
      );
    }

    const files = snapshot.changedFiles.slice(
      offset,
      offset + snapshot.pageSize
    );
    const entries = (
      await Promise.all(
        files.map((file) =>
          this.buildGitRefDiffPageEntry(repoRoot, file, snapshot.sources)
        )
      )
    ).filter((entry): entry is WorkspaceGitRefDiffEntry => entry !== null);
    return {
      diffId: snapshot.diffId,
      pageSize: snapshot.pageSize,
      totalEntries: snapshot.changedFiles.length,
      offset,
      entries,
      commitInfo: snapshot.commitInfo,
    };
  }

  async getGitRefDiff(
    ref: string,
    repoId?: string
  ): Promise<WorkspaceGitRefDiffResponse> {
    const repoRoot = await this.resolveRepoRoot(repoId);
    const resolution = this.resolveGitRefDiff(ref);

    if (resolution.kind === "workingTree") {
      const [unifiedDiff, changedFiles] = await Promise.all([
        getWorkingTreeDiff(repoRoot),
        getChangedFilesWithBinaryStatus(repoRoot, resolution.changedFilesArgs),
      ]);
      return {
        unifiedDiff,
        nonTextEntries: await this.buildNonTextDiffEntries(
          repoRoot,
          changedFiles,
          resolution.sources
        ),
      };
    }
    if (resolution.kind === GIT_CHANGE_KINDS.STAGED) {
      const [unifiedDiff, changedFiles] = await Promise.all([
        getStagedDiff(repoRoot),
        getChangedFilesWithBinaryStatus(repoRoot, resolution.changedFilesArgs),
      ]);
      return {
        unifiedDiff,
        nonTextEntries: await this.buildNonTextDiffEntries(
          repoRoot,
          changedFiles,
          resolution.sources
        ),
      };
    }
    if (resolution.kind === "stash") {
      const stashIndex = resolution.stashIndex ?? 0;
      const [unifiedDiff, changedFiles] = await Promise.all([
        getStashDiff(repoRoot, stashIndex),
        getChangedFilesWithBinaryStatus(repoRoot, resolution.changedFilesArgs),
      ]);
      return {
        unifiedDiff,
        nonTextEntries: await this.buildNonTextDiffEntries(
          repoRoot,
          changedFiles,
          resolution.sources
        ),
      };
    }
    // Treat as commit hash
    const hash = resolution.commitHash ?? "";
    const [unifiedDiff, commitInfo, changedFiles] = await Promise.all([
      getCommitDiff(repoRoot, hash),
      getCommitInfo(repoRoot, hash),
      getChangedFilesWithBinaryStatus(repoRoot, resolution.changedFilesArgs),
    ]);
    return {
      unifiedDiff,
      commitInfo,
      nonTextEntries: await this.buildNonTextDiffEntries(
        repoRoot,
        changedFiles,
        resolution.sources
      ),
    };
  }

  /**
   * Diff a recorded worktree run's branch against its recorded base commit —
   * the browser equivalent of the VS Code `ctrlyoke.viewWorktreeDiff` command.
   * `sourceCheckoutRoot` is server-recorded `_runtime.worktree` data echoed
   * back by the client, not a viewer-relative path, so it is validated the
   * same way other path-carrying ops are: it must resolve inside a discovered
   * repo (`requireRepoRootForPath`) rather than being trusted directly.
   */
  async getWorktreeDiff(
    sourceCheckoutRoot: string,
    baseCommit: string,
    branchName: string
  ): Promise<WorkspaceGitRefDiffResponse> {
    const repoRoot = await this.requireRepoRootForPath(
      path.resolve(sourceCheckoutRoot)
    );
    const unifiedDiff = await getDiffBetweenRefs(
      repoRoot,
      baseCommit,
      `refs/heads/${branchName}`
    );
    return { unifiedDiff };
  }

  dispose(): void {
    this.listingSnapshotCache.dispose();
    this.fileHistorySnapshots.clear();
    this.commitLogSnapshots.clear();
    this.gitRefDiffSnapshots.clear();
  }
}

function normalizeViewerPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isValidListingId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function isValidHistoryId(value: string): boolean {
  return isValidListingId(value);
}
