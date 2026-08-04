import * as fs from "fs";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { Log } from "../utils/Log";
import {
  CommitMessageGenerator,
  type CommitResult,
} from "../git/CommitMessageGenerator";
import { commitMessageGenerationTracker } from "../git/CommitMessageGenerationTracker";
import type {
  WorkspaceTreeResponse,
  WorkspaceTreeEntry,
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
  WorkspaceGitRefDiffResponse,
  WorkspaceScmFile,
  WorkspaceRepo,
  WorkspaceReposResponse,
  GitRefLabel,
} from "../types/HostedWorkspaceViewerTypes";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
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
import {
  getRecentCommits,
  getWorkingTreeDiff,
  getStagedDiff,
  getStashDiff,
  getCommitDiff,
  getCommitInfo,
  getIgnoredEntryNames,
} from "../utils/GitUtils";
import {
  isImageRefPath,
  imageExtensionToMimeType,
} from "../types/DashboardConstants";
import { pathsEqual } from "../utils/PathCasing";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2 MB
const BINARY_CHECK_BYTES = 8192;
const MAX_ENTRIES = 1000;

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
  dockerfile: "dockerfile",
  txt: "plaintext",
};

function languageFromPath(filePath: string): string | undefined {
  const base = path.basename(filePath).toLowerCase();
  // Special full-filename matches
  if (base === "dockerfile") return "dockerfile";
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

/**
 * Classifies raw `git log` decoration ref names (from `%D`) into typed labels
 * used by the commit-history git-graph pills. Examples of inputs:
 *   "HEAD -> main", "origin/main", "tag: v1.0", "HEAD", "upstream/feature"
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
    } else if (name.startsWith("tag: ")) {
      labels.push({ name: name.slice("tag: ".length).trim(), type: "tag" });
    } else if (/^[^/]+\/HEAD$/.test(name)) {
      // "<remote>/HEAD" (e.g. origin/HEAD) is a symbolic alias for the
      // remote's default branch, not a real branch — skip it so it doesn't
      // render as a second, redundant remote-branch pill alongside the
      // branch it points to (e.g. origin/main).
      continue;
    } else if (name.includes("/")) {
      // Anything with a slash is a remote-tracking ref (e.g. origin/main).
      labels.push({ name, type: "remoteBranch" });
    } else {
      labels.push({ name, type: "localBranch" });
    }
  }
  return labels;
}

export class HostedWorkspaceViewerService {
  private readonly commitGenerator = new CommitMessageGenerator();

  constructor(
    private readonly workspaceRoot: string,
    private readonly namedRoots: ResolverWorkspaceFolder[] = []
  ) {}

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
    return this.isMultiRoot
      ? this.namedRoots.map((root) => path.resolve(root.fsPath))
      : [path.resolve(this.workspaceRoot)];
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

  private safeResolve(requestedPath: string): string | null {
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

  // ── Directory listing ────────────────────────────────────────────────────

  /**
   * The virtual top level shown for a multi-root workspace: one directory
   * entry per open root, named after the root's folder name. Browsing into
   * one produces folder-name-prefixed paths for everything below it.
   */
  private listRoots(): WorkspaceTreeResponse {
    const entries: WorkspaceTreeEntry[] = this.namedRoots.map((root) => ({
      name: root.name,
      path: root.name,
      kind: "directory" as const,
    }));
    return {
      rootLabel: "workspace",
      path: "",
      parentPath: null,
      entries,
      isGitRepo: false,
      isRootsList: true,
    };
  }

  async listDirectory(requestedPath: string): Promise<WorkspaceTreeResponse> {
    if (this.isMultiRoot && requestedPath.trim() === "") {
      return this.listRoots();
    }

    const rootLabel = this.isMultiRoot
      ? "workspace"
      : path.basename(this.workspaceRoot);

    const resolved = this.safeResolve(requestedPath);
    if (!resolved) {
      Log.warn(
        `WorkspaceViewer: path escape attempt rejected: ${requestedPath}`
      );
      return {
        rootLabel,
        path: "",
        parentPath: null,
        entries: [],
        isGitRepo: false,
        isRootsList: false,
      };
    }

    const relDir = this.relativePath(resolved);
    let parentPath: string | null;
    if (relDir === "") {
      parentPath = null;
    } else if (this.isMultiRoot && !relDir.includes("/")) {
      // relDir is a bare root name — its parent is the virtual roots list.
      parentPath = "";
    } else {
      parentPath = this.relativePath(path.dirname(resolved));
    }

    try {
      const dirents = await fs.promises.readdir(resolved, {
        withFileTypes: true,
      });

      const dirs = dirents
        .filter((d) => d.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name));
      const files = dirents
        .filter((d) => d.isFile())
        .sort((a, b) => a.name.localeCompare(b.name));

      const allEntries = [...dirs, ...files].slice(0, MAX_ENTRIES);

      // Each root can be its own git repo, so gitignore status is always
      // computed against the root that actually contains `resolved`, not the
      // primary root — the `relDir` used elsewhere is folder-name-prefixed in
      // multi-root and would resolve to the wrong repo if passed directly.
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

      const entries = await Promise.all(
        allEntries.map(async (dirent) => {
          const entryAbsolute = path.join(resolved, dirent.name);
          const entryRelative = this.relativePath(entryAbsolute);
          // git never lists ".git" itself via ls-files, so it can't appear in
          // ignoredNames — treat it as ignored explicitly (it's always a
          // VCS-internal directory the user doesn't want to browse/track).
          const gitIgnored =
            dirent.name === ".git"
              ? isGitRepo
              : dirent.isDirectory()
                ? (ignoredNames?.has(`${dirent.name}/`) ?? false)
                : (ignoredNames?.has(dirent.name) ?? false);
          if (dirent.isDirectory()) {
            return {
              name: dirent.name,
              path: entryRelative,
              kind: "directory" as const,
              gitIgnored,
            };
          }
          let size: number | undefined;
          try {
            const stat = await fs.promises.stat(entryAbsolute);
            size = stat.size;
          } catch {
            // ignore stat failures
          }
          return {
            name: dirent.name,
            path: entryRelative,
            kind: "file" as const,
            size,
            gitIgnored,
          };
        })
      );

      return {
        rootLabel,
        path: relDir,
        parentPath,
        entries,
        isGitRepo,
        isRootsList: false,
      };
    } catch (err) {
      Log.error(
        `WorkspaceViewer: listDirectory failed for ${resolved}: ${String(err)}`
      );
      return {
        rootLabel,
        path: relDir,
        parentPath,
        entries: [],
        isGitRepo: false,
        isRootsList: false,
      };
    }
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
    const eol: "lf" | "crlf" = raw.includes("\r\n") ? "crlf" : "lf";
    const relPath = this.relativePath(resolved);

    return {
      path: relPath,
      name: path.basename(resolved),
      language: languageFromPath(resolved),
      size: stat.size,
      eol,
      content: raw,
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
    let originalEol: "lf" | "crlf" = "lf";
    try {
      if (await this.isBinaryFile(resolved)) {
        throw new Error("Cannot overwrite binary file");
      }
      const existing = await fs.promises.readFile(resolved, "utf8");
      originalEol = existing.includes("\r\n") ? "crlf" : "lf";
    } catch (err) {
      if (
        err instanceof Error &&
        err.message === "Cannot overwrite binary file"
      ) {
        throw err;
      }
      // File doesn't exist yet — new file, keep LF
    }

    // Normalize incoming content to the original EOL
    let content = req.content.replace(/\r\n/g, "\n");
    if (originalEol === "crlf") {
      content = content.replace(/\n/g, "\r\n");
    }

    const tmpPath = `${resolved}.fp-tmp`;
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
      execFileAsync("git", ["-C", repoRoot, "status", "--porcelain=v1"], {
        timeout: GIT_TIMEOUT_MS,
      }),
      this.getSyncCounts(repoRoot),
    ]);

    if (statusResult.status !== "fulfilled") {
      return {
        files: [],
        incomingCommitCount: 0,
        outgoingCommitCount: 0,
      };
    }

    const syncCounts =
      syncCountsResult.status === "fulfilled"
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
   * Parse `git status --porcelain=v1` output for a repo rooted at `repoRoot`.
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

    for (const line of output.split("\n")) {
      if (line.length < 3) {
        continue;
      }
      const x = line[0] ?? " ";
      const y = line[1] ?? " ";
      let filePath = line.slice(3);

      // Renamed files: "old-path -> new-path"
      const arrowIdx = filePath.indexOf(" -> ");
      if (arrowIdx !== -1) {
        filePath = filePath.slice(arrowIdx + 4);
      }

      const normalized = normalizeScmPath(filePath);
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
        kind = "untracked";
      } else if (x === "A") {
        kind = "added";
      } else if (x === "D" || y === "D") {
        kind = "deleted";
      } else if (x === "R") {
        kind = "renamed";
      } else {
        kind = "modified";
      }

      files.push({
        path: this.relativePath(absPath),
        stagedStatus,
        unstagedStatus,
        kind,
      });
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

    const oldContent = await this.getHeadContent(gitPath, repoRoot);
    let newContent = "";

    if (kind !== "deleted") {
      try {
        newContent = await fs.promises.readFile(resolved, "utf8");
      } catch {
        newContent = "";
      }
    }

    return {
      path: fileStatus?.path ?? normalizedRelPath,
      language,
      oldContent,
      newContent,
      kind,
    };
  }

  private async getHeadContent(
    gitRelPath: string,
    repoRoot: string
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", repoRoot, "show", `HEAD:${gitRelPath}`],
        { timeout: GIT_TIMEOUT_MS }
      );
      return stdout;
    } catch {
      return "";
    }
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

    if (fileStatus?.kind === "untracked") {
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

    const { message, prompt, cliCommand } =
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

  async getCommitLog(
    skip = 0,
    limit = 30,
    branchHint?: string,
    repoId?: string
  ): Promise<WorkspaceCommitLogResponse> {
    const repoRoot = await this.resolveRepoRoot(repoId);

    // When detached, the caller passes the branch it came from so the branch's
    // newer ("ahead") commits stay visible instead of vanishing behind HEAD.
    // The hint is a plain ref name validated against existing local branches to
    // avoid feeding arbitrary input to git as a revision.
    const safeBranch = await this.resolveBranchHint(branchHint, repoRoot);

    // Fetch one extra to determine hasMore
    const rows = await getRecentCommits(repoRoot, limit + 1, skip, safeBranch);
    const hasMore = rows.length > limit;
    const commits = hasMore ? rows.slice(0, limit) : rows;

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
      branchName.status === "fulfilled"
        ? branchName.value.stdout.trim()
        : "HEAD";
    const detached = rawBranch === "" || rawBranch === "HEAD";
    const currentBranch = detached ? null : rawBranch;

    const headHash =
      headHashResult.status === "fulfilled"
        ? headHashResult.value.stdout.trim()
        : null;

    // Commits that are ahead of upstream (not yet pushed)
    const unpushedHashes = new Set<string>();
    if (upstreamCommitsResult.status === "fulfilled") {
      for (const line of upstreamCommitsResult.value.stdout
        .trim()
        .split("\n")
        .filter(Boolean)) {
        unpushedHashes.add(line.trim());
      }
    }
    // If no upstream is configured, upstreamCommitsResult fails — treat all as pushed

    const result: WorkspaceCommitLogEntry[] = commits.map((c) => ({
      hash: c.hash,
      shortHash: c.shortHash,
      subject: c.subject,
      author: c.author,
      relativeDate: c.relativeDate,
      isHead: headHash !== null && c.hash === headHash,
      pushed: !unpushedHashes.has(c.hash),
      isMerge: c.parentHashes.length > 1,
      refs: classifyRefNames(c.refNames),
    }));

    return { commits: result, hasMore, currentBranch, detached };
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

  async getGitRefDiff(
    ref: string,
    repoId?: string
  ): Promise<WorkspaceGitRefDiffResponse> {
    const DIFF_REF = "~diff";
    const STAGED_REF = "~staged";
    const STASH_PREFIX = "~stash:";
    const repoRoot = await this.resolveRepoRoot(repoId);

    if (ref === DIFF_REF) {
      return { unifiedDiff: await getWorkingTreeDiff(repoRoot) };
    }
    if (ref === STAGED_REF) {
      return { unifiedDiff: await getStagedDiff(repoRoot) };
    }
    if (ref.startsWith(STASH_PREFIX)) {
      const index = parseInt(ref.slice(STASH_PREFIX.length), 10);
      if (!Number.isFinite(index)) {
        throw new Error(`Invalid stash ref: ${ref}`);
      }
      return { unifiedDiff: await getStashDiff(repoRoot, index) };
    }
    // Treat as commit hash
    const hash = ref.startsWith("~") ? ref.slice(1) : ref;
    const [unifiedDiff, commitInfo] = await Promise.all([
      getCommitDiff(repoRoot, hash),
      getCommitInfo(repoRoot, hash),
    ]);
    return { unifiedDiff, commitInfo };
  }
}
