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
  GitRefLabel,
} from "../types/HostedWorkspaceViewerTypes";
import {
  getRecentCommits,
  getWorkingTreeDiff,
  getStagedDiff,
  getStashDiff,
  getCommitDiff,
  getCommitInfo,
  getIgnoredEntryNames,
} from "../utils/GitUtils";

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

  constructor(private readonly workspaceRoot: string) {}

  // ── Path safety ──────────────────────────────────────────────────────────

  private safeResolve(requestedPath: string): string | null {
    const normalizedRoot = path.resolve(this.workspaceRoot);
    const resolved = path.resolve(normalizedRoot, requestedPath);

    // Reject if the normalised path escapes the workspace
    if (
      !resolved.startsWith(normalizedRoot + path.sep) &&
      resolved !== normalizedRoot
    ) {
      return null;
    }

    // Try to resolve symlinks on the full path
    try {
      const realResolved = fs.realpathSync(resolved);
      const realRoot = fs.realpathSync(normalizedRoot);
      if (
        !realResolved.startsWith(realRoot + path.sep) &&
        realResolved !== realRoot
      ) {
        return null;
      }
      return realResolved;
    } catch {
      // Path doesn't exist yet (e.g. new file write) — fall back to parent check
      const parent = path.dirname(resolved);
      try {
        const realParent = fs.realpathSync(parent);
        const realRoot = fs.realpathSync(normalizedRoot);
        if (
          !realParent.startsWith(realRoot + path.sep) &&
          realParent !== realRoot
        ) {
          return null;
        }
      } catch {
        // Parent also doesn't exist; rely on the normalised check above
      }
      return resolved;
    }
  }

  /** Returns workspace-relative path using the OS separator. */
  private relativePath(absolutePath: string): string {
    const normalizedRoot = path.resolve(this.workspaceRoot);
    return path.relative(normalizedRoot, absolutePath);
  }

  // ── Directory listing ────────────────────────────────────────────────────

  async listDirectory(requestedPath: string): Promise<WorkspaceTreeResponse> {
    const rootLabel = path.basename(this.workspaceRoot);

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
      };
    }

    const relDir = this.relativePath(resolved);
    const parentPath =
      relDir === "" ? null : this.relativePath(path.dirname(resolved));

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

      const ignoredNames = await getIgnoredEntryNames(
        this.workspaceRoot,
        relDir
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

      return { rootLabel, path: relDir, parentPath, entries, isGitRepo };
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
    if (!resolved || this.relativePath(resolved) === "") {
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
    if (!resolvedSource || this.relativePath(resolvedSource) === "") {
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

    const normalizedRoot = path.resolve(this.workspaceRoot);
    const resolvedDestDir = path.resolve(normalizedRoot, requestedDestDir);
    if (
      !resolvedDestDir.startsWith(normalizedRoot + path.sep) &&
      resolvedDestDir !== normalizedRoot
    ) {
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

    const [realRoot, realAncestor] = await Promise.all([
      fs.promises.realpath(normalizedRoot),
      fs.promises.realpath(existingAncestor),
    ]);
    if (
      !realAncestor.startsWith(realRoot + path.sep) &&
      realAncestor !== realRoot
    ) {
      throw new Error("Path not allowed");
    }

    const destPath = path.resolve(resolvedDestDir, destinationName);
    if (
      !destPath.startsWith(normalizedRoot + path.sep) &&
      destPath !== normalizedRoot
    ) {
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

  async getStatus(): Promise<WorkspaceScmStatusResponse> {
    const [statusResult, syncCountsResult] = await Promise.allSettled([
      execFileAsync(
        "git",
        ["-C", this.workspaceRoot, "status", "--porcelain=v1"],
        {
          timeout: GIT_TIMEOUT_MS,
        }
      ),
      this.getSyncCounts(),
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
      files: this.parsePorcelainV1(statusResult.value.stdout),
      ...syncCounts,
    };
  }

  private async getSyncCounts(): Promise<
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
          this.workspaceRoot,
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

  private parsePorcelainV1(
    output: string
  ): WorkspaceScmStatusResponse["files"] {
    return output
      .split("\n")
      .filter((line) => line.length >= 3)
      .map((line) => {
        const x = line[0] ?? " ";
        const y = line[1] ?? " ";
        let filePath = line.slice(3);

        // Renamed files: "old-path -> new-path"
        const arrowIdx = filePath.indexOf(" -> ");
        if (arrowIdx !== -1) {
          filePath = filePath.slice(arrowIdx + 4);
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

        return {
          path: normalizeScmPath(filePath),
          stagedStatus,
          unstagedStatus,
          kind,
        };
      });
  }

  // ── Git diff ─────────────────────────────────────────────────────────────

  async getDiff(requestedPath: string): Promise<WorkspaceScmDiffResponse> {
    const resolved = this.safeResolve(requestedPath);
    if (!resolved) {
      throw new Error("Path not allowed");
    }

    const relPath = this.relativePath(resolved);
    const normalizedRelPath = normalizeScmPath(relPath);
    const gitPath = toGitPath(relPath);
    const language = languageFromPath(resolved);

    // Determine kind from status
    const status = await this.getStatus();
    const fileStatus = status.files.find(
      (f) => normalizeScmPath(f.path) === normalizedRelPath
    );
    const kind: DiffKind = fileStatus?.kind ?? "modified";

    const oldContent = await this.getHeadContent(gitPath);
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

  private async getHeadContent(gitRelPath: string): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", this.workspaceRoot, "show", `HEAD:${gitRelPath}`],
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
    const relPath = toGitPath(this.relativePath(resolved));
    await execFileAsync(
      "git",
      ["-C", this.workspaceRoot, "add", "--", relPath],
      { timeout: GIT_TIMEOUT_MS }
    );
  }

  async unstageFile(filePath: string): Promise<void> {
    const resolved = this.safeResolve(filePath);
    if (!resolved) throw new Error("Path not allowed");
    const relPath = toGitPath(this.relativePath(resolved));
    await execFileAsync(
      "git",
      ["-C", this.workspaceRoot, "restore", "--staged", "--", relPath],
      { timeout: GIT_TIMEOUT_MS }
    );
  }

  async discardFile(filePath: string): Promise<void> {
    const resolved = this.safeResolve(filePath);
    if (!resolved) throw new Error("Path not allowed");

    const relPath = this.relativePath(resolved);
    const normalizedRelPath = normalizeScmPath(relPath);
    const status = await this.getStatus();
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
        this.workspaceRoot,
        "restore",
        "--worktree",
        "--",
        toGitPath(relPath),
      ],
      { timeout: GIT_TIMEOUT_MS }
    );
  }

  // ── Git commit ───────────────────────────────────────────────────────────

  async commit(message: string): Promise<void> {
    if (!message.trim()) throw new Error("Commit message is required");
    await execFileAsync(
      "git",
      ["-C", this.workspaceRoot, "commit", "-m", message],
      { timeout: GIT_TIMEOUT_MS }
    );
  }

  // ── Git push ─────────────────────────────────────────────────────────────

  async push(): Promise<WorkspacePushResponse> {
    const [branch, remote] = await Promise.all([
      this.currentBranch(),
      this.currentRemote(),
    ]);
    await execFileAsync("git", ["-C", this.workspaceRoot, "push"], {
      timeout: GIT_TIMEOUT_MS,
    });
    return { branch, remote };
  }

  // ── Commit message generation ────────────────────────────────────────────

  async generateCommitMessage(
    instructions?: string
  ): Promise<CommitResult | null> {
    const diffResult = await this.commitGenerator.getDiff(this.workspaceRoot);
    if (!diffResult) {
      return null;
    }

    const { message, prompt, cliCommand } =
      await this.commitGenerator.generateMessage(
        diffResult.diff,
        this.workspaceRoot,
        undefined,
        instructions
      );

    commitMessageGenerationTracker.setLastRecord({
      source: "workspace-viewer",
      workingDirectory: this.workspaceRoot,
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

  async pull(): Promise<WorkspacePullResponse> {
    const [branch, remote] = await Promise.all([
      this.currentBranch(),
      this.currentRemote(),
    ]);
    await execFileAsync("git", ["-C", this.workspaceRoot, "pull"], {
      timeout: GIT_TIMEOUT_MS,
    });
    return { branch, remote };
  }

  // ── Git helpers ──────────────────────────────────────────────────────────

  private async currentBranch(): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", this.workspaceRoot, "branch", "--show-current"],
        { timeout: GIT_TIMEOUT_MS }
      );
      return stdout.trim() || "HEAD";
    } catch {
      return "HEAD";
    }
  }

  private async currentRemote(): Promise<string> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", this.workspaceRoot, "remote"],
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
    branchHint?: string
  ): Promise<WorkspaceCommitLogResponse> {
    // When detached, the caller passes the branch it came from so the branch's
    // newer ("ahead") commits stay visible instead of vanishing behind HEAD.
    // The hint is a plain ref name validated against existing local branches to
    // avoid feeding arbitrary input to git as a revision.
    const safeBranch = await this.resolveBranchHint(branchHint);

    // Fetch one extra to determine hasMore
    const rows = await getRecentCommits(
      this.workspaceRoot,
      limit + 1,
      skip,
      safeBranch
    );
    const hasMore = rows.length > limit;
    const commits = hasMore ? rows.slice(0, limit) : rows;

    const [branchName, headHashResult, upstreamCommitsResult] =
      await Promise.allSettled([
        execFileAsync(
          "git",
          ["-C", this.workspaceRoot, "branch", "--show-current"],
          { timeout: GIT_TIMEOUT_MS }
        ),
        execFileAsync("git", ["-C", this.workspaceRoot, "rev-parse", "HEAD"], {
          timeout: GIT_TIMEOUT_MS,
        }),
        execFileAsync(
          "git",
          [
            "-C",
            this.workspaceRoot,
            "rev-list",
            "--no-walk",
            "@{upstream}..HEAD",
          ],
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
    branchHint?: string
  ): Promise<string | undefined> {
    const name = branchHint?.trim();
    if (!name) return undefined;
    try {
      await execFileAsync(
        "git",
        [
          "-C",
          this.workspaceRoot,
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

  async checkoutCommit(hash: string): Promise<{ detached: boolean }> {
    // Validate the hash exists as a commit object
    await execFileAsync(
      "git",
      ["-C", this.workspaceRoot, "cat-file", "-e", `${hash}^{commit}`],
      { timeout: GIT_TIMEOUT_MS }
    );
    await execFileAsync("git", ["-C", this.workspaceRoot, "checkout", hash], {
      timeout: GIT_TIMEOUT_MS,
    });
    return { detached: true };
  }

  async checkoutBranch(branch: string): Promise<{ branch: string }> {
    await execFileAsync("git", ["-C", this.workspaceRoot, "checkout", branch], {
      timeout: GIT_TIMEOUT_MS,
    });
    return { branch };
  }

  // ── Git ref diff ──────────────────────────────────────────────────────────

  async getGitRefDiff(ref: string): Promise<WorkspaceGitRefDiffResponse> {
    const DIFF_REF = "~diff";
    const STAGED_REF = "~staged";
    const STASH_PREFIX = "~stash:";

    if (ref === DIFF_REF) {
      return { unifiedDiff: await getWorkingTreeDiff(this.workspaceRoot) };
    }
    if (ref === STAGED_REF) {
      return { unifiedDiff: await getStagedDiff(this.workspaceRoot) };
    }
    if (ref.startsWith(STASH_PREFIX)) {
      const index = parseInt(ref.slice(STASH_PREFIX.length), 10);
      if (!Number.isFinite(index)) {
        throw new Error(`Invalid stash ref: ${ref}`);
      }
      return { unifiedDiff: await getStashDiff(this.workspaceRoot, index) };
    }
    // Treat as commit hash
    const hash = ref.startsWith("~") ? ref.slice(1) : ref;
    const [unifiedDiff, commitInfo] = await Promise.all([
      getCommitDiff(this.workspaceRoot, hash),
      getCommitInfo(this.workspaceRoot, hash),
    ]);
    return { unifiedDiff, commitInfo };
  }
}
