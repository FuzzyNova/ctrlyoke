import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;

export interface CommitInfo {
  hash: string;         // full 40-char SHA
  shortHash: string;    // 7-char abbreviated SHA
  subject: string;      // first line of commit message
  author: string;       // author name
  relativeDate: string; // e.g. "2 days ago"
}

export interface StashInfo {
  index: number;        // stash@{0}, stash@{1}, …
  subject: string;      // stash description
  relativeDate: string;
}

/**
 * Returns recent commits, most recent first.
 * Uses NUL byte (%x00) as field separator to safely handle subjects/authors
 * that contain pipe or other punctuation.
 */
export async function getRecentCommits(
  workspaceRoot: string,
  limit: number = 30
): Promise<CommitInfo[]> {
  const { stdout } = await execFileAsync("git", [
    "-C", workspaceRoot,
    "log",
    `--format=%H%x00%h%x00%s%x00%an%x00%ar`,
    `-n`, String(limit),
  ], { timeout: GIT_TIMEOUT_MS });

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\0");
      const [hash, shortHash, subject, author, relativeDate] = parts;
      return { hash, shortHash, subject, author, relativeDate };
    });
}

/**
 * Returns git show output for a commit (stat + full diff).
 */
export async function getCommitDiff(
  workspaceRoot: string,
  hash: string
): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-C", workspaceRoot,
    "show",
    "--stat",
    "-p",
    hash,
  ], { timeout: GIT_TIMEOUT_MS });
  return stdout;
}

/**
 * Returns working tree diff (unstaged changes + untracked file summary).
 */
export async function getWorkingTreeDiff(workspaceRoot: string): Promise<string> {
  const { stdout: diffOutput } = await execFileAsync("git", [
    "-C", workspaceRoot,
    "diff",
    "--stat",
    "-p",
  ], { timeout: GIT_TIMEOUT_MS });

  // Append untracked file list from git status --short
  const { stdout: statusOutput } = await execFileAsync("git", [
    "-C", workspaceRoot,
    "status",
    "--short",
  ], { timeout: GIT_TIMEOUT_MS });

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
  const { stdout } = await execFileAsync("git", [
    "-C", workspaceRoot,
    "diff",
    "--cached",
    "--stat",
    "-p",
  ], { timeout: GIT_TIMEOUT_MS });
  return stdout;
}

/**
 * Returns list of stash entries, most recent first.
 */
export async function getStashList(workspaceRoot: string): Promise<StashInfo[]> {
  const { stdout } = await execFileAsync("git", [
    "-C", workspaceRoot,
    "stash",
    "list",
    "--format=%s%x00%ar",
  ], { timeout: GIT_TIMEOUT_MS });

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
  const { stdout } = await execFileAsync("git", [
    "-C", workspaceRoot,
    "stash",
    "show",
    "-p",
    `stash@{${index}}`,
  ], { timeout: GIT_TIMEOUT_MS });
  return stdout;
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
  const { stdout } = await execFileAsync("git", [
    "-C", workspaceRoot,
    "log",
    `--format=%H%x00%h%x00%s%x00%an%x00%ar`,
    `--grep=${query}`,
    "--regexp-ignore-case",
    `-n`, String(limit),
  ], { timeout: GIT_TIMEOUT_MS });

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\0");
      const [hash, shortHash, subject, author, relativeDate] = parts;
      return { hash, shortHash, subject, author, relativeDate };
    });
}

/**
 * Returns true if hash looks like a valid git SHA (7-40 hex chars).
 */
export function isValidCommitHash(hash: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(hash);
}
