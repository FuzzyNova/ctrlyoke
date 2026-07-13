import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import * as Diff from "diff";
import { PATH_CONSTANTS } from "./ConfigurationUtils";
import type {
  SnapshotFileChange,
  PromptChangeType,
  WorkspaceSnapshot,
  WorkspaceSnapshotGitInfo,
  SnapshotRepoInfo,
} from "../types/OutputHistoryTypes";
import type {
  UndoFileInstruction,
  UndoResult,
} from "../types/WebviewMessageTypes";
import type { UnifiedDiffHunk } from "../types/CliOutputTypes";
import { Log } from "./Log";
import {
  SNAPSHOT_BASE_SOURCES,
  SNAPSHOT_STRATEGIES,
  UNDO_FILE_ACTIONS,
  type SnapshotStrategy,
} from "../types/DashboardConstants";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import {
  resolveNamedRelativePath,
  stripViewerPrefix,
  joinViewerPath,
} from "../platform/WorkspaceViewerPath";
import { discoverRepos } from "./WorkspaceRepoDiscovery";
import { isPathWithinDirectory } from "./PathSecurity";

const execFileAsync = promisify(execFile);

const MAX_CONTENT_SIZE = 512 * 1024; // 512 KB

/** Normalize Windows line endings to LF before diff computation. */
function normalizeLf(content: string): string {
  return content.replace(/\r\n/g, "\n");
}
const BINARY_CHECK_SIZE = 8 * 1024; // 8 KB

/** Artifact directories/files to always exclude in filesystem strategy */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  "coverage",
  ".nyc_output",
  ".cache",
  ".parcel-cache",
  "__pycache__",
  ".pytest_cache",
  ".venv",
  "venv",
  "target",
  "vendor",
  ".gradle",
  ".idea",
  PATH_CONSTANTS.CTRLYOKE_DIR,
  ".git",
]);

const EXCLUDED_EXTENSIONS = new Set([".pyc", ".class", ".o", ".obj"]);

interface RawFileState {
  contentHash: string; // SHA-256
  content?: string; // before-state content, under size limit
  isAtHead: boolean; // true only under git strategy
}

/**
 * One capture unit: a single git repo or a filesystem root. `files` are keyed
 * by the path git/fs reports RELATIVE TO `root` (POSIX) — the same key used for
 * git pathspecs and `git show HEAD:<key>` — while `prefix`/`pathspec` map those
 * keys to folder-name-prefixed viewer paths for multi-root. Single-root uses a
 * single segment with `prefix: ""` and `pathspec: ""`, so its behavior is
 * byte-identical to the pre-multi-root implementation.
 */
export interface RawWorkspaceSegment {
  /** Folder-name prefix for viewer paths in this segment ("" for single-root/primary). */
  prefix: string;
  /** Absolute git toplevel (git segments) or root dir (filesystem segments). */
  root: string;
  /** The workspace root's path relative to `root` (POSIX); "" when the root IS `root`. */
  pathspec: string;
  strategy: SnapshotStrategy;
  git?: WorkspaceSnapshotGitInfo;
  files: Map<string, RawFileState>;
}

export interface RawWorkspaceState {
  capturedAt: number;
  /** Primary segment's strategy, surfaced for back-compat single-root reads. */
  strategy: SnapshotStrategy;
  /** Primary segment's git info, surfaced for back-compat single-root reads. */
  git?: WorkspaceSnapshotGitInfo;
  segments: RawWorkspaceSegment[];
}

/** Convert OS-separator paths to POSIX for viewer paths and git pathspecs. */
function toPosixPath(p: string): string {
  return p.split(path.sep).join("/");
}

interface SnapshotFileData {
  exists: boolean;
  content?: string;
  hash?: string;
}

function computeHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function isBinary(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_SIZE);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

async function readFileForSnapshot(
  filePath: string
): Promise<{ content?: string; hash: string } | null> {
  try {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > MAX_CONTENT_SIZE) {
      // Too large — hash only
      const buffer = await fs.promises.readFile(filePath);
      if (isBinary(buffer)) {
        return null;
      }
      const content = buffer.toString("utf8");
      return { hash: computeHash(content) };
    }
    const buffer = await fs.promises.readFile(filePath);
    if (isBinary(buffer)) {
      return null;
    }
    const content = buffer.toString("utf8");
    return { content, hash: computeHash(content) };
  } catch {
    return null;
  }
}

async function getSnapshotFileData(
  filePath: string
): Promise<SnapshotFileData> {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
  } catch {
    return { exists: false };
  }

  const fileData = await readFileForSnapshot(filePath);
  if (!fileData) {
    return { exists: true };
  }
  return {
    exists: true,
    content: fileData.content,
    hash: fileData.hash,
  };
}

/** Parse .gitignore lines into simple matchers. Returns a function that checks if a relative path should be excluded. */
function buildGitignoreMatcher(
  gitignorePath: string
): (relPosix: string, isDir: boolean) => boolean {
  let lines: string[] = [];
  try {
    const raw = fs.readFileSync(gitignorePath, "utf8");
    lines = raw.split(/\r?\n/);
  } catch {
    return () => false;
  }

  const dirPatterns: string[] = [];
  const namePatterns: string[] = [];
  const globPatterns: RegExp[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) {
      continue;
    }
    if (line.endsWith("/")) {
      // Directory pattern — strip trailing slash
      dirPatterns.push(line.slice(0, -1));
    } else if (line.includes("*")) {
      // Simple glob: match filename only
      const escaped = line
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*");
      try {
        globPatterns.push(new RegExp(`^${escaped}$`));
      } catch {
        // ignore invalid pattern
      }
    } else {
      // Bare name — matches dir or file
      namePatterns.push(line);
    }
  }

  return (relPosix: string, isDir: boolean): boolean => {
    const parts = relPosix.split("/");
    const fileName = parts[parts.length - 1];

    // Check each directory segment against dirPatterns and namePatterns
    for (const segment of parts) {
      if (dirPatterns.includes(segment) || namePatterns.includes(segment)) {
        return true;
      }
    }

    // Glob patterns match filename
    for (const pattern of globPatterns) {
      if (pattern.test(fileName)) {
        return true;
      }
    }

    // For dirs also check dirPatterns on leaf
    if (isDir && dirPatterns.includes(fileName)) {
      return true;
    }

    return false;
  };
}

async function walkDirectory(
  dir: string,
  workspacePath: string,
  gitignoreMatcher: (relPosix: string, isDir: boolean) => boolean,
  result: Map<string, RawFileState>
): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relNative = path.relative(workspacePath, fullPath);
    const relPosix = relNative.replace(/\\/g, "/");

    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      if (gitignoreMatcher(relPosix, true)) {
        continue;
      }
      await walkDirectory(fullPath, workspacePath, gitignoreMatcher, result);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (EXCLUDED_EXTENSIONS.has(ext)) {
        continue;
      }
      if (gitignoreMatcher(relPosix, false)) {
        continue;
      }
      const fileData = await readFileForSnapshot(fullPath);
      if (!fileData) {
        continue;
      }
      result.set(relPosix, {
        contentHash: fileData.hash,
        content: fileData.content,
        isAtHead: false,
      });
    }
  }
}

/**
 * Convert a forward-direction UnifiedDiffHunk[] to a reversed unified diff string
 * that can be passed to Diff.applyPatch() to undo a specific edit without affecting
 * any other edits to the file.
 *
 * Each hunk is reversed by:
 *  - Swapping old/new line counts in the @@ header
 *  - Turning '+' lines into '-' (they're in the current file; we remove them)
 *  - Turning '-' lines into '+' (they were in the old file; we restore them)
 *  - Leaving context lines unchanged
 */
function buildReversePatchString(hunks: UnifiedDiffHunk[]): string {
  let patch = "--- b\n+++ a\n";
  for (const hunk of hunks) {
    // Strip trailing empty context lines (" " — a bare space representing the file's
    // trailing newline). Diff.applyPatch fails on CRLF files when such a line is present
    // because the trailing empty string it implies is not part of jsdiff's line model.
    let lines = hunk.lines;
    let oldLines = hunk.oldLines;
    let newLines = hunk.newLines;
    while (lines.length > 0 && lines[lines.length - 1] === " ") {
      lines = lines.slice(0, -1);
      oldLines--;
      newLines--;
    }

    patch += `@@ -${hunk.newStart},${newLines} +${hunk.oldStart},${oldLines} @@\n`;
    for (const line of lines) {
      if (line.startsWith("+")) {
        patch += "-" + line.slice(1) + "\n";
      } else if (line.startsWith("-")) {
        patch += "+" + line.slice(1) + "\n";
      } else {
        patch += line + "\n";
      }
    }
  }
  return patch;
}

export class WorkspaceSnapshotService {
  private buildModifiedChange(
    viewerPath: string,
    repo: string | undefined,
    beforeState: RawFileState,
    afterState: SnapshotFileData
  ): SnapshotFileChange {
    const change: SnapshotFileChange = {
      path: viewerPath,
      repo,
      changeType: "modified" as PromptChangeType,
      baseSource: SNAPSHOT_BASE_SOURCES.CAPTURED_BEFORE,
      afterHash: afterState.hash,
    };

    if (beforeState.content !== undefined && afterState.content !== undefined) {
      change.beforeContent = beforeState.content;
      const patchResult = Diff.structuredPatch(
        "",
        "",
        normalizeLf(beforeState.content),
        normalizeLf(afterState.content)
      );
      if (patchResult.hunks.length > 0) {
        change.structuredPatch = patchResult.hunks as UnifiedDiffHunk[];
      }
      if (beforeState.content.includes("\r\n")) {
        change.lineEnding = "crlf";
      }
    } else {
      change.contentCaptureSkipped = true;
    }

    return change;
  }

  private async getGitSnapshotInfo(
    workspacePath: string
  ): Promise<WorkspaceSnapshotGitInfo | undefined> {
    try {
      const [{ stdout: headCommit }, { stdout: branchOutput }] =
        await Promise.all([
          execFileAsync("git", ["rev-parse", "HEAD"], {
            cwd: workspacePath,
          }),
          execFileAsync("git", ["branch", "--show-current"], {
            cwd: workspacePath,
          }),
        ]);

      const normalizedHeadCommit = headCommit.trim();
      if (!normalizedHeadCommit) {
        return undefined;
      }

      const normalizedBranch = branchOutput.trim();
      return normalizedBranch
        ? { headCommit: normalizedHeadCommit, branch: normalizedBranch }
        : { headCommit: normalizedHeadCommit };
    } catch {
      return undefined;
    }
  }

  /** Read a file's content at a specific commit, skipping binary/oversized blobs. */
  private async readGitBlob(
    workspacePath: string,
    commit: string,
    filePath: string
  ): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["show", `${commit}:${filePath}`],
        { cwd: workspacePath, maxBuffer: MAX_CONTENT_SIZE * 4 }
      );
      if (Buffer.byteLength(stdout, "utf8") > MAX_CONTENT_SIZE) {
        return undefined;
      }
      return stdout;
    } catch {
      return undefined;
    }
  }

  /**
   * True when a path's committed-after content is byte-identical to content
   * that was already dirty/untracked before the prompt ran. That means the
   * commit only persisted pre-existing work (e.g. the AI ran `git commit` on
   * changes a human made earlier) rather than content the prompt produced, so
   * it should not be attributed to this prompt's undo history.
   */
  private matchesPreExistingDirtyContent(
    beforeSeg: RawWorkspaceSegment,
    filePath: string,
    afterHash: string | undefined
  ): boolean {
    if (afterHash === undefined) {
      return false;
    }
    const dirtyBefore = beforeSeg.files.get(filePath);
    return dirtyBefore !== undefined && dirtyBefore.contentHash === afterHash;
  }

  /**
   * Diff the file trees between two commits to surface changes that were made
   * AND committed within a single prompt — the dirty-worktree comparison in
   * `computeSnapshotChanges` cannot see these because `git status --porcelain`
   * is clean both before and after the prompt runs.
   *
   * `skipPaths` excludes paths already represented in the dirty-file diff so a
   * file touched both as a leftover dirty edit and as part of a commit isn't
   * recorded twice.
   */
  private async getCommitRangeChanges(
    segment: RawWorkspaceSegment,
    beforeSeg: RawWorkspaceSegment,
    afterCommit: string,
    skipPaths: Set<string>
  ): Promise<SnapshotFileChange[]> {
    const beforeCommit = beforeSeg.git?.headCommit;
    if (!beforeCommit) {
      return [];
    }
    const workspacePath = segment.root;
    const repo = segment.prefix || undefined;
    const changes: SnapshotFileChange[] = [];
    let stdout: string;
    try {
      const diffArgs = [
        "diff",
        "--name-status",
        "--no-renames",
        `${beforeCommit}..${afterCommit}`,
      ];
      // Scope the commit-range diff to this root's subtree so a repo shared by
      // multiple roots attributes each committed change to the right segment.
      if (segment.pathspec) {
        diffArgs.push("--", segment.pathspec);
      }
      const result = await execFileAsync("git", diffArgs, {
        cwd: workspacePath,
      });
      stdout = result.stdout;
    } catch (err) {
      Log.warn(
        `WorkspaceSnapshotService: git diff for commit range failed: ${err}`
      );
      return changes;
    }

    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      const [status, ...pathParts] = line.split("\t");
      const filePath = pathParts.join("\t").replace(/\\/g, "/");
      if (!filePath || skipPaths.has(filePath)) continue;
      // Defensive: keep only paths inside this segment's subtree.
      if (
        segment.pathspec &&
        filePath !== segment.pathspec &&
        !filePath.startsWith(`${segment.pathspec}/`)
      ) {
        continue;
      }
      const viewerPath = this.segmentViewerPath(segment, filePath);

      const statusChar = status?.[0];
      if (statusChar === "A") {
        const afterContent = await this.readGitBlob(
          workspacePath,
          afterCommit,
          filePath
        );
        const afterHash =
          afterContent !== undefined ? computeHash(afterContent) : undefined;
        if (
          this.matchesPreExistingDirtyContent(beforeSeg, filePath, afterHash)
        ) {
          continue;
        }
        changes.push({
          path: viewerPath,
          repo,
          changeType: "created",
          afterHash,
        });
      } else if (statusChar === "D") {
        const beforeContent = await this.readGitBlob(
          workspacePath,
          beforeCommit,
          filePath
        );
        const change: SnapshotFileChange = {
          path: viewerPath,
          repo,
          changeType: "deleted",
        };
        if (beforeContent !== undefined) {
          change.contentToRestore = beforeContent;
        } else {
          change.contentCaptureSkipped = true;
        }
        changes.push(change);
      } else if (statusChar === "M" || statusChar === "T") {
        const [beforeContent, afterContent] = await Promise.all([
          this.readGitBlob(workspacePath, beforeCommit, filePath),
          this.readGitBlob(workspacePath, afterCommit, filePath),
        ]);
        const afterHash =
          afterContent !== undefined ? computeHash(afterContent) : undefined;
        if (
          this.matchesPreExistingDirtyContent(beforeSeg, filePath, afterHash)
        ) {
          continue;
        }
        const change: SnapshotFileChange = {
          path: viewerPath,
          repo,
          changeType: "modified",
          baseSource: SNAPSHOT_BASE_SOURCES.GIT_HEAD,
          afterHash,
        };
        if (beforeContent !== undefined && afterContent !== undefined) {
          change.beforeContent = beforeContent;
          const patchResult = Diff.structuredPatch(
            "",
            "",
            normalizeLf(beforeContent),
            normalizeLf(afterContent)
          );
          if (patchResult.hunks.length > 0) {
            change.structuredPatch = patchResult.hunks as UnifiedDiffHunk[];
          }
          if (beforeContent.includes("\r\n")) {
            change.lineEnding = "crlf";
          }
        } else {
          change.contentCaptureSkipped = true;
        }
        changes.push(change);
      }
      // Other statuses (copies, type changes outside M/T) are rare for AI-driven
      // edits and are intentionally left to the existing dirty-file diff, if any.
    }

    return changes;
  }

  async selectStrategy(workspacePath: string): Promise<SnapshotStrategy> {
    try {
      await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
        cwd: workspacePath,
      });
      return SNAPSHOT_STRATEGIES.GIT;
    } catch {
      return SNAPSHOT_STRATEGIES.FILESYSTEM;
    }
  }

  async captureWorkspaceState(
    workspacePath: string,
    strategy: SnapshotStrategy,
    namedRoots?: readonly ResolverWorkspaceFolder[]
  ): Promise<RawWorkspaceState> {
    const capturedAt = Date.now();

    // Single-root (0/1 named roots): one segment against `workspacePath` with no
    // prefix/pathspec — byte-identical to the pre-multi-root implementation.
    if (!namedRoots || namedRoots.length <= 1) {
      const seg = await this.captureSegment(workspacePath, strategy, "");
      return {
        capturedAt,
        strategy,
        git: seg.git,
        segments: [
          {
            prefix: "",
            root: workspacePath,
            pathspec: "",
            strategy,
            git: seg.git,
            files: seg.files,
          },
        ],
      };
    }

    const segments = await this.captureMultiRootSegments(namedRoots);
    const primary = this.primarySegment(segments, workspacePath);
    return {
      capturedAt,
      strategy: primary?.strategy ?? strategy,
      git: primary?.git,
      segments,
    };
  }

  /**
   * Capture one repo/root: git dirty files (optionally scoped to a `pathspec`
   * subtree) or a filesystem walk. `files` are keyed by the path relative to
   * `root` (git-reported for git, root-relative for filesystem).
   */
  private async captureSegment(
    root: string,
    strategy: SnapshotStrategy,
    pathspec: string
  ): Promise<{
    git?: WorkspaceSnapshotGitInfo;
    files: Map<string, RawFileState>;
  }> {
    const files = new Map<string, RawFileState>();
    let git: WorkspaceSnapshotGitInfo | undefined;

    try {
      if (strategy === SNAPSHOT_STRATEGIES.GIT) {
        git = await this.getGitSnapshotInfo(root);
        let stdout = "";
        try {
          const args = ["status", "--porcelain"];
          if (pathspec) {
            args.push("--", pathspec);
          }
          const result = await execFileAsync("git", args, { cwd: root });
          stdout = result.stdout;
        } catch (err) {
          Log.warn(`WorkspaceSnapshotService: git status failed: ${err}`);
          return { git, files };
        }

        const lines = stdout.split("\n").filter((l) => l.length >= 3);
        for (const line of lines) {
          // Format: XY<space><path> where XY are two status chars
          const xy = line.slice(0, 2);
          let filePath = line.slice(3);
          // Git quotes paths containing special chars
          if (filePath.startsWith('"') && filePath.endsWith('"')) {
            filePath = filePath.slice(1, -1);
          }
          filePath = filePath.replace(/\\/g, "/");
          if (!filePath) {
            continue;
          }
          // Defensive: git status honours the pathspec, but skip anything that
          // still falls outside the root's subtree so a shared repo's other
          // roots never leak into this segment.
          if (
            pathspec &&
            filePath !== pathspec &&
            !filePath.startsWith(`${pathspec}/`)
          ) {
            continue;
          }

          // isAtHead: true when the file exists in git HEAD (tracked, modified/deleted).
          // False for new/untracked (??) or newly staged (A) files.
          const isAtHead = xy !== "??" && xy[0] !== "A";

          const absPath = path.join(root, filePath);
          const fileData = await readFileForSnapshot(absPath);
          if (!fileData) {
            continue;
          }
          files.set(filePath, {
            contentHash: fileData.hash,
            content: fileData.content,
            isAtHead,
          });
        }
      } else {
        // filesystem strategy
        const gitignorePath = path.join(root, ".gitignore");
        const gitignoreMatcher = buildGitignoreMatcher(gitignorePath);
        await walkDirectory(root, root, gitignoreMatcher, files);
      }
    } catch (err) {
      Log.warn(`WorkspaceSnapshotService: captureSegment error: ${err}`);
      return { git, files: new Map() };
    }

    return { git, files };
  }

  /**
   * Build one capture segment per workspace root: git segments (scoped to the
   * root's subtree of its discovered repo) for roots inside a repo, filesystem
   * segments otherwise. Two roots sharing a repo become two segments scoped by
   * their respective pathspecs, so files never double-count.
   */
  private async captureMultiRootSegments(
    namedRoots: readonly ResolverWorkspaceFolder[]
  ): Promise<RawWorkspaceSegment[]> {
    const repos = await discoverRepos([...namedRoots]);
    const segments: RawWorkspaceSegment[] = [];

    for (const root of namedRoots) {
      const rootAbs = path.resolve(root.fsPath);
      const repo = repos.find(
        (r) =>
          path.resolve(r.rootPath) === rootAbs ||
          isPathWithinDirectory(rootAbs, r.rootPath)
      );
      if (repo) {
        const pathspec = toPosixPath(
          path.relative(path.resolve(repo.rootPath), rootAbs)
        );
        const seg = await this.captureSegment(
          repo.rootPath,
          SNAPSHOT_STRATEGIES.GIT,
          pathspec
        );
        segments.push({
          prefix: root.name,
          root: repo.rootPath,
          pathspec,
          strategy: SNAPSHOT_STRATEGIES.GIT,
          git: seg.git,
          files: seg.files,
        });
      } else {
        const seg = await this.captureSegment(
          rootAbs,
          SNAPSHOT_STRATEGIES.FILESYSTEM,
          ""
        );
        segments.push({
          prefix: root.name,
          root: rootAbs,
          pathspec: "",
          strategy: SNAPSHOT_STRATEGIES.FILESYSTEM,
          git: undefined,
          files: seg.files,
        });
      }
    }

    return segments;
  }

  /** The segment corresponding to the primary root (for back-compat top-level fields). */
  private primarySegment(
    segments: RawWorkspaceSegment[],
    workspacePath: string
  ): RawWorkspaceSegment | undefined {
    const resolved = path.resolve(workspacePath);
    return (
      segments.find((s) => path.resolve(s.root) === resolved) ??
      segments.find((s) => isPathWithinDirectory(resolved, s.root)) ??
      segments[0]
    );
  }

  /** Folder-name-prefixed viewer path for a segment-relative (git-reported) path. */
  private segmentViewerPath(
    segment: RawWorkspaceSegment,
    segmentRelPath: string
  ): string {
    // git reports paths relative to the repo toplevel; strip the root's own
    // sub-path within that toplevel (`pathspec`), then re-prefix with the
    // root's folder name to reach the viewer-path form.
    const rootRel = stripViewerPrefix(segmentRelPath, segment.pathspec);
    return joinViewerPath(segment.prefix, rootRel);
  }

  /** Per-repo metadata for a WorkspaceSnapshot; undefined in single-root. */
  snapshotRepoInfos(state: RawWorkspaceState): SnapshotRepoInfo[] | undefined {
    if (state.segments.length <= 1) {
      return undefined;
    }
    return state.segments.map((segment) => ({
      prefix: segment.prefix,
      root: segment.root,
      rootRelative: segment.pathspec,
      strategy: segment.strategy,
      git: segment.git,
    }));
  }

  async computeSnapshotChanges(
    before: RawWorkspaceState,
    after: RawWorkspaceState,
    _workspacePath: string
  ): Promise<SnapshotFileChange[]> {
    const changes: SnapshotFileChange[] = [];
    for (const afterSeg of after.segments) {
      const beforeSeg =
        before.segments.find(
          (s) =>
            s.prefix === afterSeg.prefix &&
            path.resolve(s.root) === path.resolve(afterSeg.root)
        ) ??
        ({
          prefix: afterSeg.prefix,
          root: afterSeg.root,
          pathspec: afterSeg.pathspec,
          strategy: afterSeg.strategy,
          git: undefined,
          files: new Map<string, RawFileState>(),
        } satisfies RawWorkspaceSegment);
      changes.push(...(await this.computeSegmentChanges(beforeSeg, afterSeg)));
    }
    return changes;
  }

  private async computeSegmentChanges(
    beforeSeg: RawWorkspaceSegment,
    afterSeg: RawWorkspaceSegment
  ): Promise<SnapshotFileChange[]> {
    const changes: SnapshotFileChange[] = [];
    const strategy = afterSeg.strategy;
    const workspacePath = afterSeg.root;
    const repo = afterSeg.prefix || undefined;
    const before = beforeSeg;
    const after = afterSeg;
    // Git-relative keys already surfaced, so the commit-range pass can skip them.
    const seenSegmentPaths = new Set<string>();

    // Files in after: created or modified
    for (const [filePath, afterState] of after.files) {
      seenSegmentPaths.add(filePath);
      const beforeState = before.files.get(filePath);
      if (!beforeState) {
        // File not in before snapshot. Under git strategy, the before snapshot only
        // captures dirty files (git status --porcelain), so absence means the file was
        // clean/at HEAD before the prompt ran. Use isAtHead on the after state to
        // distinguish: tracked file modified from HEAD (isAtHead=true) vs truly new
        // file (isAtHead=false, shown as ?? or A in git status).
        const wasCleanAtHead =
          strategy === SNAPSHOT_STRATEGIES.GIT && afterState.isAtHead;
        if (wasCleanAtHead) {
          // Fetch the HEAD content so we can compute a structured patch for reverse-patch undo.
          const change: SnapshotFileChange = {
            path: this.segmentViewerPath(afterSeg, filePath),
            repo,
            changeType: "modified" as PromptChangeType,
            baseSource: SNAPSHOT_BASE_SOURCES.GIT_HEAD,
            afterHash: afterState.contentHash,
          };
          try {
            const { stdout: headContent } = await execFileAsync(
              "git",
              ["show", `HEAD:${filePath}`],
              { cwd: workspacePath }
            );
            if (Buffer.byteLength(headContent, "utf8") <= MAX_CONTENT_SIZE) {
              change.beforeContent = headContent;
            }
            if (afterState.content !== undefined) {
              const patchResult = Diff.structuredPatch(
                "",
                "",
                normalizeLf(headContent),
                normalizeLf(afterState.content)
              );
              if (patchResult.hunks.length > 0) {
                change.structuredPatch = patchResult.hunks as UnifiedDiffHunk[];
              }
              // headContent (from git) is always LF; detect CRLF from the after-content.
              // If the AI kept CRLF we know the original was CRLF. If the AI normalized
              // it we cannot tell from the snapshot alone, but core.autocrlf=true users
              // won't see git-modified in that case anyway.
              if (afterState.content.includes("\r\n")) {
                change.lineEnding = "crlf";
              }
            } else {
              change.contentCaptureSkipped = true;
            }
          } catch {
            change.contentCaptureSkipped = true;
          }
          changes.push(change);
        } else {
          // Truly new file (untracked or newly staged)
          changes.push({
            path: this.segmentViewerPath(afterSeg, filePath),
            repo,
            changeType: "created" as PromptChangeType,
            afterHash: afterState.contentHash,
          });
        }
      } else if (afterState.contentHash !== beforeState.contentHash) {
        // Modified during prompt — before-content was captured (file was dirty before prompt)
        const change: SnapshotFileChange = {
          path: this.segmentViewerPath(afterSeg, filePath),
          repo,
          changeType: "modified" as PromptChangeType,
          baseSource: SNAPSHOT_BASE_SOURCES.CAPTURED_BEFORE,
          afterHash: afterState.contentHash,
        };
        if (
          beforeState.content !== undefined &&
          afterState.content !== undefined
        ) {
          change.beforeContent = beforeState.content;
          const patchResult = Diff.structuredPatch(
            "",
            "",
            normalizeLf(beforeState.content),
            normalizeLf(afterState.content)
          );
          if (patchResult.hunks.length > 0) {
            change.structuredPatch = patchResult.hunks as UnifiedDiffHunk[];
          }
          // Detect CRLF from the in-memory before-content — no extra reads needed.
          if (beforeState.content.includes("\r\n")) {
            change.lineEnding = "crlf";
          }
        } else {
          change.contentCaptureSkipped = true;
        }
        changes.push(change);
      }
      // same hash → skip
    }

    // Files in before but not in after: deleted during prompt
    for (const [filePath, beforeState] of before.files) {
      if (!after.files.has(filePath)) {
        if (strategy === SNAPSHOT_STRATEGIES.GIT) {
          const currentFile = await getSnapshotFileData(
            path.join(workspacePath, filePath)
          );

          if (currentFile.exists) {
            // In git mode, the after snapshot only contains dirty files. A path
            // missing from `after.files` may simply mean the prompt left it
            // clean (for example by committing it), not that it was deleted.
            if (
              currentFile.hash !== undefined &&
              currentFile.hash === beforeState.contentHash
            ) {
              continue;
            }
            // Represented here already — keep the commit-range pass from
            // recording the same committed change twice.
            seenSegmentPaths.add(filePath);
            changes.push(
              this.buildModifiedChange(
                this.segmentViewerPath(afterSeg, filePath),
                repo,
                beforeState,
                currentFile
              )
            );
            continue;
          }
        }

        seenSegmentPaths.add(filePath);
        const change: SnapshotFileChange = {
          path: this.segmentViewerPath(afterSeg, filePath),
          repo,
          changeType: "deleted" as PromptChangeType,
        };
        if (beforeState.content !== undefined) {
          change.contentToRestore = beforeState.content;
        } else {
          change.contentCaptureSkipped = true;
        }
        changes.push(change);
      }
    }

    // The dirty-worktree comparison above only sees files that were uncommitted
    // at the start or end of the prompt. If the prompt committed its own work
    // (e.g. via a commit skill), the tree can be clean on both sides while the
    // commit history still moved — diff the commit range to catch those changes.
    if (
      strategy === SNAPSHOT_STRATEGIES.GIT &&
      before.git?.headCommit &&
      after.git?.headCommit &&
      before.git.headCommit !== after.git.headCommit
    ) {
      const commitRangeChanges = await this.getCommitRangeChanges(
        afterSeg,
        before,
        after.git.headCommit,
        seenSegmentPaths
      );
      changes.push(...commitRangeChanges);
    }

    return changes;
  }

  async undoFiles(
    files: UndoFileInstruction[],
    workspacePath: string,
    namedRoots?: readonly ResolverWorkspaceFolder[]
  ): Promise<UndoResult> {
    const restoredFiles: string[] = [];
    const failedFiles: Array<{ path: string; error: string }> = [];
    const redoInstructions: UndoFileInstruction[] = [];

    // Trusted roots for the path-traversal guard: the primary workspace path
    // plus every named root (multi-root). Windows/macOS are case-insensitive, so
    // compare case-insensitively there (drive-letter/folder casing may differ);
    // Linux stays case-sensitive to avoid aliasing distinct paths.
    const roots = namedRoots ?? [];
    const isWindows = process.platform === "win32";
    const normalize = (p: string) => (isWindows ? p.toLowerCase() : p);
    const trustedRoots = [
      path.resolve(workspacePath),
      ...roots.map((root) => path.resolve(root.fsPath)),
    ].map(normalize);

    for (const instruction of files) {
      // Folder-name-prefixed paths (multi-root) resolve against the matching
      // root; unprefixed paths resolve against the primary workspace path.
      const absPath = resolveNamedRelativePath(
        instruction.path,
        workspacePath,
        roots
      );

      // Security: prevent path traversal — the resolved path must sit inside one
      // of the trusted roots.
      const normalizedAbs = normalize(absPath);
      const withinTrusted = trustedRoots.some(
        (root) =>
          normalizedAbs === root || normalizedAbs.startsWith(root + path.sep)
      );
      if (!withinTrusted) {
        failedFiles.push({
          path: instruction.path,
          error: "Path traversal detected — skipping",
        });
        continue;
      }

      try {
        // Capture current content before overwriting (for redo)
        let currentContent: string | undefined;
        try {
          currentContent = await fs.promises.readFile(absPath, "utf8");
        } catch {
          // File may not exist (e.g. was deleted by AI); redo will delete it again
        }

        if (instruction.action === UNDO_FILE_ACTIONS.DELETE) {
          try {
            await fs.promises.unlink(absPath);
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
              throw err;
            }
            // Missing file is a no-op success
          }
          restoredFiles.push(instruction.path);
          if (currentContent !== undefined) {
            redoInstructions.push({
              path: instruction.path,
              action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
              contentToRestore: currentContent,
            });
          }
        } else if (instruction.action === UNDO_FILE_ACTIONS.RESTORE_CONTENT) {
          const content = instruction.contentToRestore ?? "";
          await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
          await fs.promises.writeFile(absPath, content, "utf8");
          restoredFiles.push(instruction.path);
          if (currentContent !== undefined) {
            // Compute forward patch (pre-AI → AI-modified) for diff display in redo dialog
            const fwdPatch = Diff.structuredPatch(
              "",
              "",
              normalizeLf(instruction.contentToRestore ?? ""),
              normalizeLf(currentContent)
            );
            const structuredPatch =
              fwdPatch.hunks.length > 0
                ? (fwdPatch.hunks as UnifiedDiffHunk[])
                : undefined;
            redoInstructions.push({
              path: instruction.path,
              action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
              contentToRestore: currentContent,
              structuredPatch,
            });
          } else {
            // File didn't exist before the AI created it — redo should delete it
            redoInstructions.push({
              path: instruction.path,
              action: UNDO_FILE_ACTIONS.DELETE,
            });
          }
        } else if (instruction.action === UNDO_FILE_ACTIONS.REVERSE_PATCH) {
          if (
            !instruction.structuredPatch ||
            instruction.structuredPatch.length === 0
          ) {
            failedFiles.push({
              path: instruction.path,
              error: "No patch data for reverse-patch",
            });
            continue;
          }
          if (currentContent === undefined) {
            failedFiles.push({
              path: instruction.path,
              error: "File not found",
            });
            continue;
          }
          const reversePatchStr = buildReversePatchString(
            instruction.structuredPatch
          );
          // Normalize to LF before applying — the patch was computed from LF-normalized
          // content, so context lines are LF. Normalizing ensures applyPatch matches
          // even if the file currently has CRLF endings.
          const patched = Diff.applyPatch(
            normalizeLf(currentContent),
            reversePatchStr
          );
          if (patched === false) {
            failedFiles.push({
              path: instruction.path,
              error:
                "Patch did not apply cleanly — the file may have changed since this edit was made",
            });
            continue;
          }
          // Re-apply the original line endings if the file was CRLF before the prompt ran.
          const restoredContent =
            instruction.lineEnding === "crlf"
              ? patched.replace(/\r?\n/g, "\r\n")
              : patched;
          await fs.promises.writeFile(absPath, restoredContent, "utf8");
          restoredFiles.push(instruction.path);
          // Redo: restore the pre-undo state (what was in the file before we reversed the patch).
          // The forward structuredPatch (before→after AI change) is the original instruction patch.
          redoInstructions.push({
            path: instruction.path,
            action: UNDO_FILE_ACTIONS.RESTORE_CONTENT,
            contentToRestore: currentContent,
            structuredPatch: instruction.structuredPatch,
          });
        }
      } catch (err) {
        failedFiles.push({
          path: instruction.path,
          error: String(err),
        });
      }
    }

    return { restoredFiles, failedFiles, redoInstructions };
  }

  async hashCurrentFile(
    workspacePath: string,
    relativePath: string
  ): Promise<string | undefined> {
    const absPath = path.join(workspacePath, relativePath);
    const result = await readFileForSnapshot(absPath);
    if (!result) {
      return undefined;
    }
    return result.hash;
  }

  /**
   * Hydrate `beforeContent` for modified gitHead entries that are missing it.
   *
   * When a file was clean at HEAD but large (>512 KB) at capture time, the
   * snapshot stores `baseSource: "gitHead"` without `beforeContent`. This
   * method fetches the blob from the stored HEAD commit so the DiffView can
   * expand lines outside the visible hunks.
   *
   * Only touches entries where ALL conditions hold:
   * - `change.changeType === "modified"`
   * - `change.baseSource === SNAPSHOT_BASE_SOURCES.GIT_HEAD`
   * - `change.beforeContent` is absent
   * - `change.contentCaptureSkipped` is not set
   *
   * Never touches `capturedBefore` entries — their diff base is the dirty
   * worktree at prompt start, not git HEAD.
   */
  async enrichSnapshotBeforeContent(
    snapshot: WorkspaceSnapshot,
    workspaceFolderPath: string
  ): Promise<WorkspaceSnapshot> {
    // Multi-root: enrich each change against ITS repo's HEAD/root.
    if (snapshot.repos && snapshot.repos.length > 0) {
      return this.enrichMultiRepoBeforeContent(snapshot);
    }

    if (
      snapshot.strategy !== SNAPSHOT_STRATEGIES.GIT ||
      !snapshot.git?.headCommit
    ) {
      return snapshot;
    }

    const { headCommit } = snapshot.git;
    let anyChanged = false;

    const enrichedFiles = await Promise.all(
      snapshot.changedFiles.map(async (change): Promise<SnapshotFileChange> => {
        if (
          change.changeType !== "modified" ||
          change.baseSource !== SNAPSHOT_BASE_SOURCES.GIT_HEAD ||
          change.beforeContent !== undefined ||
          change.contentCaptureSkipped
        ) {
          return change;
        }
        try {
          const { stdout: content } = await execFileAsync(
            "git",
            ["show", `${headCommit}:${change.path}`],
            { cwd: workspaceFolderPath }
          );
          anyChanged = true;
          return { ...change, beforeContent: content };
        } catch {
          return change;
        }
      })
    );

    if (!anyChanged) {
      return snapshot;
    }
    return { ...snapshot, changedFiles: enrichedFiles };
  }

  /** Reconstruct a repo-toplevel-relative git path from a change's viewer path. */
  private gitRelFromChange(
    repoInfo: SnapshotRepoInfo,
    viewerPath: string
  ): string {
    // Inverse of `segmentViewerPath`: drop the root's folder-name prefix, then
    // re-scope under the root's sub-path within the toplevel (`rootRelative`).
    const rootRel = stripViewerPrefix(viewerPath, repoInfo.prefix);
    return joinViewerPath(repoInfo.rootRelative, rootRel);
  }

  /** Multi-root variant of {@link enrichSnapshotBeforeContent}, per repo. */
  private async enrichMultiRepoBeforeContent(
    snapshot: WorkspaceSnapshot
  ): Promise<WorkspaceSnapshot> {
    const byPrefix = new Map(
      (snapshot.repos ?? []).map((repo) => [repo.prefix, repo])
    );
    let anyChanged = false;

    const enrichedFiles = await Promise.all(
      snapshot.changedFiles.map(async (change): Promise<SnapshotFileChange> => {
        if (
          change.changeType !== "modified" ||
          change.baseSource !== SNAPSHOT_BASE_SOURCES.GIT_HEAD ||
          change.beforeContent !== undefined ||
          change.contentCaptureSkipped
        ) {
          return change;
        }
        const info = byPrefix.get(change.repo ?? "");
        if (
          !info ||
          info.strategy !== SNAPSHOT_STRATEGIES.GIT ||
          !info.git?.headCommit
        ) {
          return change;
        }
        const gitRel = this.gitRelFromChange(info, change.path);
        try {
          const { stdout: content } = await execFileAsync(
            "git",
            ["show", `${info.git.headCommit}:${gitRel}`],
            { cwd: info.root }
          );
          anyChanged = true;
          return { ...change, beforeContent: content };
        } catch {
          return change;
        }
      })
    );

    if (!anyChanged) {
      return snapshot;
    }
    return { ...snapshot, changedFiles: enrichedFiles };
  }
}
