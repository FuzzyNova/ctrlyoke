import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";
import type { ExecFileOptions } from "child_process";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MAX_BUFFER = 50 * 1024 * 1024;
const execFilePromisified = promisify(execFile);

/**
 * Run git without involving a shell. The shared limits are intentional: Git
 * output is often path-sized and must be bounded even when a repository has a
 * very large number of worktrees or files.
 */
const execFileAsync = async (
  file: string,
  args: readonly string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> => {
  const result = await execFilePromisified(file, args, {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    ...options,
  });
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
};

export const GIT_COMMAND_TIMEOUT_MS = GIT_TIMEOUT_MS;
export const GIT_COMMAND_MAX_BUFFER = GIT_MAX_BUFFER;

async function execGit(
  args: readonly string[],
  options: ExecFileOptions = {}
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", args, options);
}

export interface CommitInfo {
  hash: string; // full 40-char SHA
  shortHash: string; // 7-char abbreviated SHA
  subject: string; // first line of commit message
  author: string; // author name
  relativeDate: string; // e.g. "2 days ago"
  parentHashes: string[]; // parent SHAs (>1 means a merge commit)
  refNames: string[]; // decoration ref names, e.g. ["HEAD -> main", "origin/main", "tag: v1.0"]
}

export interface StashInfo {
  index: number; // stash@{0}, stash@{1}, …
  subject: string; // stash description
  relativeDate: string;
}

export interface CommitDetailInfo {
  hash: string; // full 40-char SHA
  shortHash: string; // 7-char abbreviated SHA
  subject: string; // first line of commit message
  body: string; // remaining lines of commit message, trimmed
  author: string; // author name
  authorEmail: string; // author email
  date: string; // author date, ISO 8601
  relativeDate: string; // e.g. "2 days ago"
}

/**
 * Returns recent commits, most recent first.
 * Uses NUL byte (%x00) as field separator to safely handle subjects/authors
 * that contain pipe or other punctuation.
 *
 * When `ref` is supplied, the log walks that ref instead of HEAD. This lets the
 * caller keep a branch's newer commits visible while in detached-HEAD state.
 */
export async function getRecentCommits(
  workspaceRoot: string,
  limit: number = 30,
  skip: number = 0,
  ref?: string
): Promise<CommitInfo[]> {
  const args = [
    "-C",
    workspaceRoot,
    "log",
    // Trailing %P (parents) and %D (decorate) enable merge detection and ref pills.
    `--format=%H%x00%h%x00%s%x00%an%x00%ar%x00%P%x00%D`,
    `-n`,
    String(limit),
  ];
  if (skip > 0) {
    args.splice(args.indexOf("log") + 1, 0, `--skip=${skip}`);
  }
  // Explicit ref must come after all options so git treats it as a revision.
  if (ref && ref.trim()) {
    args.push("--end-of-options", ref.trim());
  }
  const { stdout } = await execGit(args);

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\0");
      const [
        hash,
        shortHash,
        subject,
        author,
        relativeDate,
        parents,
        decorate,
      ] = parts;
      const parentHashes = (parents ?? "").trim()
        ? parents.trim().split(/\s+/)
        : [];
      const refNames = (decorate ?? "").trim()
        ? decorate
            .trim()
            .split(",")
            .map((r) => r.trim())
            .filter(Boolean)
        : [];
      return {
        hash,
        shortHash,
        subject,
        author,
        relativeDate,
        parentHashes,
        refNames,
      };
    });
}

/**
 * Returns full commit metadata: subject, body, author, and dates.
 * Uses NUL byte (%x00) as field separator, same convention as getRecentCommits.
 */
export async function getCommitInfo(
  workspaceRoot: string,
  hash: string
): Promise<CommitDetailInfo> {
  const { stdout } = await execGit([
    "-C",
    workspaceRoot,
    "show",
    "-s",
    `--format=%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%aI%x00%ar`,
    "--end-of-options",
    hash,
  ]);

  const parts = stdout.split("\0");
  const [
    fullHash,
    shortHash,
    subject,
    body,
    author,
    authorEmail,
    date,
    relativeDate,
  ] = parts;

  return {
    hash: fullHash,
    shortHash,
    subject,
    body: (body ?? "").trim(),
    author,
    authorEmail,
    date,
    relativeDate: (relativeDate ?? "").trim(),
  };
}

/**
 * Returns git show output for a commit (stat + full diff).
 */
export async function getCommitDiff(
  workspaceRoot: string,
  hash: string
): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    workspaceRoot,
    "show",
    "--stat",
    "-p",
    "--end-of-options",
    hash,
  ]);
  return stdout;
}

/** Return repository-relative files changed between two commits/refs. */
export async function getDiffFilesBetweenRefs(
  workspaceRoot: string,
  baseRef: string,
  targetRef: string
): Promise<string[]> {
  const { stdout } = await execGit([
    "-C",
    workspaceRoot,
    "diff",
    "--name-only",
    "-z",
    "--no-renames",
    "--diff-filter=ACDMRTUXB",
    "--end-of-options",
    baseRef,
    targetRef,
  ]);
  return stdout.split("\0").filter(Boolean);
}

/** Return a unified diff between two commits/refs. */
export async function getDiffBetweenRefs(
  workspaceRoot: string,
  baseRef: string,
  targetRef: string
): Promise<string> {
  const { stdout } = await execGit([
    "-C",
    workspaceRoot,
    "diff",
    "--stat",
    "-p",
    "--no-ext-diff",
    "--end-of-options",
    baseRef,
    targetRef,
  ]);
  return stdout;
}

/**
 * Returns working tree diff (unstaged changes + untracked file summary).
 */
export async function getWorkingTreeDiff(
  workspaceRoot: string
): Promise<string> {
  const { stdout: diffOutput } = await execFileAsync(
    "git",
    ["-C", workspaceRoot, "diff", "--stat", "-p"],
    { timeout: GIT_TIMEOUT_MS }
  );

  // Append untracked file list from git status --short
  const { stdout: statusOutput } = await execFileAsync(
    "git",
    ["-C", workspaceRoot, "status", "--short"],
    { timeout: GIT_TIMEOUT_MS }
  );

  const untrackedLines = statusOutput
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3).trim());

  if (untrackedLines.length > 0) {
    const untrackedSection = `\nUntracked files:\n${untrackedLines.map((f) => `  ${f}`).join("\n")}`;
    return diffOutput + untrackedSection;
  }

  return diffOutput;
}

/**
 * Returns staged diff only (git diff --cached).
 */
export async function getStagedDiff(workspaceRoot: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspaceRoot, "diff", "--cached", "--stat", "-p"],
    { timeout: GIT_TIMEOUT_MS }
  );
  return stdout;
}

/**
 * Returns list of stash entries, most recent first.
 */
export async function getStashList(
  workspaceRoot: string
): Promise<StashInfo[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspaceRoot, "stash", "list", "--format=%s%x00%ar"],
    { timeout: GIT_TIMEOUT_MS }
  );

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      const nullIdx = line.indexOf("\0");
      const subject = nullIdx >= 0 ? line.slice(0, nullIdx) : line;
      const relativeDate = nullIdx >= 0 ? line.slice(nullIdx + 1) : "";
      return { index, subject, relativeDate };
    });
}

/**
 * Returns the diff for a specific stash entry.
 */
export async function getStashDiff(
  workspaceRoot: string,
  index: number
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspaceRoot, "stash", "show", "-p", `stash@{${index}}`],
    { timeout: GIT_TIMEOUT_MS }
  );
  return stdout;
}

/**
 * Returns the repo-relative paths of tracked files changed in a stash entry.
 * Used to build per-file URIs for VS Code's native multi-file diff editor.
 * Tracked changes only — parity with {@link getStashDiff} (no `-u`).
 */
export async function getStashFiles(
  workspaceRoot: string,
  index: number
): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspaceRoot, "stash", "show", "--name-only", `stash@{${index}}`],
    { timeout: GIT_TIMEOUT_MS }
  );
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Search commits on the current branch by subject/message (case-insensitive).
 * Uses --grep so it can find commits beyond the base cache limit.
 */
export async function searchCommitsBySubject(
  workspaceRoot: string,
  query: string,
  limit: number = 200
): Promise<CommitInfo[]> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      workspaceRoot,
      "log",
      `--format=%H%x00%h%x00%s%x00%an%x00%ar`,
      `--grep=${query}`,
      "--regexp-ignore-case",
      `-n`,
      String(limit),
    ],
    { timeout: GIT_TIMEOUT_MS }
  );

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\0");
      const [hash, shortHash, subject, author, relativeDate] = parts;
      // Search results don't carry graph decorations; the consumers that need
      // parents/refs use getRecentCommits / getCommitLog instead.
      return {
        hash,
        shortHash,
        subject,
        author,
        relativeDate,
        parentHashes: [],
        refNames: [],
      };
    });
}

/**
 * Reports whether a git context reference resolves to something that exists in
 * the repo at `workspaceRoot`.
 *
 * Understands the two pseudo-refs used by `@git:` context references — `"diff"`
 * (any working-tree change) and `"staged"` (anything in the index) — plus
 * abbreviated or full commit hashes. Stash references are not handled here;
 * callers resolve those through {@link getStashList}.
 *
 * Unlike the rest of this module this never throws: an unrecognized ref, a
 * non-repo root, or an unavailable git all resolve to `{ exists: false }` with
 * a caller-displayable `message`, because the only consumer drives an editor
 * lint marker where a rejection is indistinguishable from "not found".
 */
export async function gitRefExists(
  workspaceRoot: string,
  gitRef: string
): Promise<{ exists: boolean; message?: string }> {
  try {
    if (gitRef === "diff") {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", workspaceRoot, "status", "--short"],
        { timeout: GIT_TIMEOUT_MS }
      );
      return stdout.trim()
        ? { exists: true }
        : { exists: false, message: "git diff not found" };
    }

    if (gitRef === "staged") {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", workspaceRoot, "diff", "--cached", "--name-only"],
        { timeout: GIT_TIMEOUT_MS }
      );
      return stdout.trim()
        ? { exists: true }
        : { exists: false, message: "staged changes not found" };
    }

    if (/^[0-9a-f]{7,40}$/i.test(gitRef)) {
      await execFileAsync("git", [
        "-C",
        workspaceRoot,
        "cat-file",
        "-e",
        "--end-of-options",
        `${gitRef}^{commit}`,
      ]);
      return { exists: true };
    }
  } catch {
    return { exists: false, message: "git context not found" };
  }

  return { exists: false, message: "git context not found" };
}

/**
 * Returns all non-gitignored file paths (relative to repoRoot) using
 * `git ls-files --cached --others --exclude-standard -z`.
 *
 * --cached  : tracked (committed or staged) files
 * --others  : untracked files
 * --exclude-standard : apply .gitignore, .git/info/exclude, and global gitignore
 * -z        : NUL-separated output, safe for paths containing spaces or newlines
 *
 * This is the canonical way to ask git which files are not ignored.
 * It handles nested .gitignore files, global gitignore, and git attributes
 * automatically — no need to batch-check individual files.
 */
export async function getGitTrackedFiles(repoRoot: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: repoRoot,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 500 * 1024 * 1024, // 500 MB — large monorepos can exceed 100 MB
    }
  );
  return stdout.split("\0").filter(Boolean);
}

/** Return tracked and non-ignored untracked paths, preserving Git's NUL-safe output. */
export async function getGitTrackedAndUntrackedFiles(
  repoRoot: string
): Promise<string[]> {
  const { stdout } = await execGit(
    ["-C", repoRoot, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { maxBuffer: GIT_MAX_BUFFER }
  );
  return stdout.split("\0").filter(Boolean);
}

/** Return non-ignored untracked paths, preserving Git's NUL-safe output. */
export async function getGitUntrackedFiles(
  repoRoot: string
): Promise<string[]> {
  const { stdout } = await execGit(
    ["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z"],
    { maxBuffer: GIT_MAX_BUFFER }
  );
  return stdout.split("\0").filter(Boolean);
}

/** Return true when Git reports an in-progress operation in this checkout. */
export async function hasGitOperationInProgress(dir: string): Promise<boolean> {
  const gitDir = await absoluteGitDir(dir);
  if (!gitDir) return false;
  const markers = [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-apply",
    "rebase-merge",
    "sequencer",
  ];
  for (const marker of markers) {
    try {
      await fs.access(path.join(gitDir, marker));
      return true;
    } catch {
      // The marker is absent; continue checking the other Git operations.
    }
  }
  return false;
}

/**
 * Returns the names of entries directly inside `relDir` (relative to repoRoot)
 * that are ignored by .gitignore, or `null` if repoRoot is not a git repository
 * (or git is unavailable).
 *
 * Uses `git ls-files --others --ignored --exclude-standard --directory`, run
 * with `relDir` as the working directory so results are scoped to that single
 * directory level. Whole directories that are entirely ignored are returned
 * with a trailing "/" (e.g. "node_modules/"); individually ignored files are
 * returned without one (e.g. ".env").
 */
export async function getIgnoredEntryNames(
  repoRoot: string,
  relDir: string
): Promise<Set<string> | null> {
  try {
    const cwd = relDir ? path.join(repoRoot, relDir) : repoRoot;
    const { stdout } = await execFileAsync(
      "git",
      [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--directory",
        "-z",
        ".",
      ],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 50 * 1024 * 1024,
      }
    );
    return new Set(stdout.split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

export interface GitWorktreeEntry {
  worktreePath: string;
  headCommit: string;
  branchName?: string;
  detached: boolean;
  bare: boolean;
  lockedReason?: string;
  prunableReason?: string;
}

/** Return Git's repository toplevel, or null when dir is not in a repository. */
export async function repoToplevel(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execGit([
      "-C",
      dir,
      "rev-parse",
      "--show-toplevel",
    ]);
    const result = stdout.trim();
    return result ? path.normalize(result) : null;
  } catch {
    return null;
  }
}

/** Return the absolute administrative Git directory for the checkout. */
export async function absoluteGitDir(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execGit([
      "-C",
      dir,
      "rev-parse",
      "--absolute-git-dir",
    ]);
    const result = stdout.trim();
    return result ? path.normalize(result) : null;
  } catch {
    return null;
  }
}

/**
 * Return the shared Git administrative directory. Git may print this as a
 * path relative to the command cwd, so resolve it before normalization.
 */
export async function gitCommonDir(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execGit([
      "-C",
      dir,
      "rev-parse",
      "--git-common-dir",
    ]);
    const result = stdout.trim();
    if (!result) return null;
    const resolved = path.isAbsolute(result) ? result : path.resolve(dir, result);
    try {
      return path.normalize(await fs.realpath(resolved));
    } catch {
      return path.normalize(resolved);
    }
  } catch {
    return null;
  }
}

/** Resolve a path in Git's administrative directory without using a shell. */
export async function gitPath(
  dir: string,
  relativePath: string
): Promise<string | null> {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.startsWith("-") ||
    relativePath.includes("\0")
  ) {
    return null;
  }
  try {
    const { stdout } = await execGit([
      "-C",
      dir,
      "rev-parse",
      "--git-path",
      relativePath,
    ]);
    const result = stdout.trim();
    if (!result) return null;
    return path.normalize(
      path.isAbsolute(result) ? result : path.resolve(dir, result)
    );
  } catch {
    return null;
  }
}

/**
 * Parse `git worktree list --porcelain -z`. Each field is NUL-delimited and
 * records end in an empty NUL field; no line-oriented parsing is involved.
 */
export function parseGitWorktreePorcelain(output: string): GitWorktreeEntry[] {
  const entries: GitWorktreeEntry[] = [];
  let fields: string[] = [];

  const consume = (record: readonly string[]): void => {
    if (record.length === 0) return;
    let worktreePath: string | undefined;
    let headCommit = "";
    let branchName: string | undefined;
    let detached = false;
    let bare = false;
    let lockedReason: string | undefined;
    let prunableReason: string | undefined;

    for (const field of record) {
      if (field.startsWith("worktree ")) {
        worktreePath = field.slice("worktree ".length);
      } else if (field.startsWith("HEAD ")) {
        headCommit = field.slice("HEAD ".length);
      } else if (field.startsWith("branch ")) {
        const ref = field.slice("branch ".length);
        branchName = ref.startsWith("refs/heads/")
          ? ref.slice("refs/heads/".length)
          : ref;
      } else if (field === "detached") {
        detached = true;
      } else if (field === "bare") {
        bare = true;
      } else if (field === "locked" || field.startsWith("locked ")) {
        lockedReason = field.slice("locked".length).trim() || undefined;
      } else if (field === "prunable" || field.startsWith("prunable ")) {
        prunableReason = field.slice("prunable".length).trim() || undefined;
      }
    }

    if (worktreePath && headCommit) {
      entries.push({
        worktreePath: path.normalize(worktreePath),
        headCommit,
        branchName,
        detached,
        bare,
        lockedReason,
        prunableReason,
      });
    }
  };

  for (const field of output.split("\0")) {
    if (field === "") {
      consume(fields);
      fields = [];
    } else {
      fields.push(field);
    }
  }
  consume(fields);
  return entries;
}

export async function listWorktrees(
  repoRoot: string
): Promise<GitWorktreeEntry[]> {
  const { stdout } = await execGit([
    "-C",
    repoRoot,
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  return parseGitWorktreePorcelain(stdout);
}

export class GitWorktreeBranchCheckoutError extends Error {
  public readonly branchName: string;
  public readonly existingWorktreePath: string;

  public constructor(branchName: string, existingWorktreePath: string) {
    super(
      `Branch "${branchName}" is already checked out at "${existingWorktreePath}".`
    );
    this.name = "GitWorktreeBranchCheckoutError";
    this.branchName = branchName;
    this.existingWorktreePath = existingWorktreePath;
  }
}

export interface AddWorktreeOptions {
  branchName?: string;
  baseRef?: string;
  createBranch?: boolean;
  detached?: boolean;
}

function normalizeBranchName(branchName: string): string {
  return branchName.startsWith("refs/heads/")
    ? branchName.slice("refs/heads/".length)
    : branchName;
}

/** Validate a local branch name using Git's own ref rules. */
export async function validateBranchName(branchName: string): Promise<void> {
  if (
    !branchName ||
    branchName.startsWith("-") ||
    branchName.includes("\0") ||
    branchName.includes("\\")
  ) {
    throw new Error(`Invalid branch name: ${branchName}`);
  }
  try {
    await execGit(["check-ref-format", "--branch", branchName]);
  } catch {
    throw new Error(`Invalid branch name: ${branchName}`);
  }
}

/** Add a worktree, surfacing an existing branch checkout before Git can emit a raw error. */
export async function addWorktree(
  repoRoot: string,
  worktreePath: string,
  options: AddWorktreeOptions = {}
): Promise<void> {
  const branchName = options.branchName
    ? normalizeBranchName(options.branchName)
    : undefined;
  if (branchName) {
    await validateBranchName(branchName);
    const existing = (await listWorktrees(repoRoot)).find(
      (entry) => entry.branchName === branchName
    );
    if (existing) {
      throw new GitWorktreeBranchCheckoutError(
        branchName,
        existing.worktreePath
      );
    }
  }

  const args = ["-C", repoRoot, "worktree", "add"];
  if (options.createBranch) {
    if (!branchName) throw new Error("A branch is required when creating one.");
    args.push("-b", branchName);
  }
  if (options.detached) args.push("--detach");
  args.push("--", worktreePath);
  if (options.baseRef) {
    args.push(await resolveCommit(repoRoot, options.baseRef));
  } else if (branchName && !options.createBranch) {
    args.push(branchName);
  }
  await execGit(args);
}

export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  force = false
): Promise<void> {
  const args = ["-C", repoRoot, "worktree", "remove"];
  if (force) args.push("--force");
  args.push("--", worktreePath);
  await execGit(args);
}

export async function pruneWorktrees(repoRoot: string): Promise<void> {
  await execGit(["-C", repoRoot, "worktree", "prune"]);
}

/** Repair one explicitly requested worktree admin entry. */
export async function repairWorktree(
  repoRoot: string,
  worktreePath: string
): Promise<void> {
  await execGit(["-C", repoRoot, "worktree", "repair", "--", worktreePath]);
}

export async function currentBranch(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execGit([
      "-C",
      dir,
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const branch = stdout.trim();
    return branch || null;
  } catch {
    return null;
  }
}

export async function resolveCommit(dir: string, ref: string): Promise<string> {
  if (!ref || ref.includes("\0")) throw new Error("Invalid Git ref.");
  const { stdout } = await execGit([
    "-C",
    dir,
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${ref}^{commit}`,
  ]);
  const commit = stdout.trim();
  if (!commit) throw new Error(`Git ref does not resolve to a commit: ${ref}`);
  return commit;
}

/** Return whether a local branch ref exists. */
export async function localBranchExists(
  repoRoot: string,
  branchName: string
): Promise<boolean> {
  try {
    await resolveCommit(repoRoot, `refs/heads/${branchName}`);
    return true;
  } catch {
    return false;
  }
}

/** Return the configured upstream for a local branch, if one is configured. */
export async function getBranchUpstream(
  repoRoot: string,
  branchName: string
): Promise<string | undefined> {
  try {
    const { stdout } = await execGit([
      "-C",
      repoRoot,
      "for-each-ref",
      "--format=%(upstream:short)",
      `refs/heads/${branchName}`,
    ]);
    const upstream = stdout.trim();
    return upstream || undefined;
  } catch {
    return undefined;
  }
}

/** Return ancestry-based ahead/behind counts for two commit-ish values. */
export async function getAheadBehind(
  repoRoot: string,
  baseRef: string,
  branchRef: string
): Promise<{ ahead: number; behind: number }> {
  const { stdout } = await execGit([
    "-C",
    repoRoot,
    "rev-list",
    "--left-right",
    "--count",
    "--end-of-options",
    `${baseRef}...${branchRef}`,
  ]);
  const [behindText, aheadText] = stdout.trim().split(/\s+/);
  const behind = Number.parseInt(behindText ?? "", 10);
  const ahead = Number.parseInt(aheadText ?? "", 10);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    throw new Error("Git returned an invalid ahead/behind count.");
  }
  return { ahead, behind };
}

/** Return true only when the first commit is an ancestor of the second. */
export async function isCommitAncestor(
  repoRoot: string,
  ancestorRef: string,
  descendantRef: string
): Promise<boolean> {
  try {
    await execGit([
      "-C",
      repoRoot,
      "merge-base",
      "--is-ancestor",
      "--end-of-options",
      ancestorRef,
      descendantRef,
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function hasUncommittedChanges(dir: string): Promise<boolean> {
  const { stdout } = await execGit([
    "-C",
    dir,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
  ]);
  return stdout.length > 0;
}

/** Merge a ref into the current branch only when Git can fast-forward it. */
export async function mergeFastForward(
  dir: string,
  ref: string
): Promise<void> {
  await execGit(["-C", dir, "merge", "--ff-only", "--", ref]);
}

/** Merge a ref non-interactively, creating a merge commit when necessary. */
export async function mergeNoFastForward(
  dir: string,
  ref: string
): Promise<void> {
  await execGit(["-C", dir, "merge", "--no-ff", "--no-edit", "--", ref]);
}

/** Return all unmerged paths using Git's NUL-delimited name output. */
export async function getUnmergedPaths(dir: string): Promise<string[]> {
  const { stdout } = await execGit([
    "-C",
    dir,
    "diff",
    "--name-only",
    "--diff-filter=U",
    "-z",
  ]);
  return stdout.split("\0").filter(Boolean);
}

/** Abort an in-progress merge without invoking a shell or editor. */
export async function abortMerge(dir: string): Promise<void> {
  await execGit(["-C", dir, "merge", "--abort"]);
}

/** Stage and commit all changes. Returns false when there is nothing to commit. */
export async function commitAll(
  dir: string,
  message: string
): Promise<boolean> {
  if (!(await hasUncommittedChanges(dir))) return false;
  await execGit(["-C", dir, "add", "--all", "--", "."]);
  await execGit(
    ["-C", dir, "commit", `--message=${message}`, "--"],
    {
      env: {
        ...process.env,
        GIT_EDITOR: "true",
        GIT_TERMINAL_PROMPT: "0",
      },
    }
  );
  return true;
}

/** Delete a local branch without forcing deletion of commits. */
export async function deleteLocalBranch(
  repoRoot: string,
  branchName: string,
  force = false
): Promise<void> {
  await execGit([
    "-C",
    repoRoot,
    "branch",
    force ? "-D" : "-d",
    "--",
    branchName,
  ]);
}
