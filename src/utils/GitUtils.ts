import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

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
    args.push(ref.trim());
  }
  const { stdout } = await execFileAsync("git", args, {
    timeout: GIT_TIMEOUT_MS,
  });

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
  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      workspaceRoot,
      "show",
      "-s",
      `--format=%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%aI%x00%ar`,
      hash,
    ],
    { timeout: GIT_TIMEOUT_MS }
  );

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
  const { stdout } = await execFileAsync(
    "git",
    ["-C", workspaceRoot, "show", "--stat", "-p", hash],
    { timeout: GIT_TIMEOUT_MS }
  );
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
