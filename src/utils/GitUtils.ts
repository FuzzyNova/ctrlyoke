import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";
import type { ExecFileOptions } from "child_process";
import { GIT_CHANGE_KINDS } from "../types/DashboardConstants";
import { foldPathForCompare } from "./PathCasing";

export const GIT_DIFF_NO_EXT_DIFF_OPTION = "--no-ext-diff";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MUTATION_TIMEOUT_MS = 5 * 60_000;
const GIT_MAX_BUFFER = 50 * 1024 * 1024;
const execFilePromisified = promisify(execFile);

interface GitTimeoutOverrides {
  shortTimeoutMs?: number;
  mutationTimeoutMs?: number;
}

let gitTimeoutOverrides: GitTimeoutOverrides = {};

/** Override Git command timeouts for isolated tests. */
export function setGitTimeoutOverridesForTests(
  overrides: GitTimeoutOverrides
): () => void {
  const previousOverrides = gitTimeoutOverrides;
  gitTimeoutOverrides = overrides;
  return () => {
    gitTimeoutOverrides = previousOverrides;
  };
}

function getGitTimeoutMs(mutation = false): number {
  return mutation
    ? (gitTimeoutOverrides.mutationTimeoutMs ?? GIT_MUTATION_TIMEOUT_MS)
    : (gitTimeoutOverrides.shortTimeoutMs ?? GIT_TIMEOUT_MS);
}

/** Return the shared timeout for Git commands that mutate a repository. */
export function getGitMutationTimeoutMs(): number {
  return getGitTimeoutMs(true);
}

function gitCommandName(args: readonly string[]): string {
  const commandStart = args[0] === "-C" ? 2 : 0;
  const command = args[commandStart] ?? "";
  const operation = args[commandStart + 1];
  const includeOperation =
    (command === "merge" && operation === "--abort") ||
    (command === "worktree" &&
      (operation === "add" || operation === "remove")) ||
    (command === "add" && operation === "--all");
  return `git ${[command, ...(includeOperation && operation ? [operation] : [])].join(" ")}`;
}

function isTimeoutError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const execError = error as NodeJS.ErrnoException;
  return execError.code === "ETIMEDOUT";
}

function exceededTimeout(startedAt: number, timeoutMs: number): boolean {
  return Date.now() - startedAt >= timeoutMs;
}

function timeoutError(args: readonly string[], timeoutMs: number): Error {
  const timeoutSeconds = timeoutMs / 1000;
  const timeoutDescription = Number.isInteger(timeoutSeconds)
    ? `${timeoutSeconds} seconds`
    : `${timeoutSeconds.toFixed(1)} seconds`;
  return new Error(
    `${gitCommandName(args)} timed out after ${timeoutDescription}; a slow Git hook or large checkout may be responsible.`
  );
}

export interface GitPorcelainV1Entry {
  x: string;
  y: string;
  path: string;
  originalPath?: string;
}

/** Split NUL-terminated git path output, dropping only its trailing empty record. */
export function parseGitNulSeparatedPaths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/** Parse `git status --porcelain=v1 -z` records without decoding raw paths. */
export function parseGitPorcelainV1Z(output: string): GitPorcelainV1Entry[] {
  const nulDelimited = output.includes("\0");
  const records = nulDelimited
    ? parseGitNulSeparatedPaths(output)
    : output.split(/\r?\n/).filter(Boolean);
  const entries: GitPorcelainV1Entry[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index] ?? "";
    if (record.length < 4) continue;
    const x = record[0] ?? " ";
    const y = record[1] ?? " ";
    let filePath = record.slice(3);
    let originalPath: string | undefined;
    if (x === "R" || y === "R" || x === "C" || y === "C") {
      if (nulDelimited) {
        originalPath = records[++index];
      } else {
        const separatorIndex = filePath.indexOf(" -> ");
        if (separatorIndex >= 0) {
          originalPath = filePath.slice(0, separatorIndex);
          filePath = filePath.slice(separatorIndex + 4);
        }
      }
    }
    entries.push({ x, y, path: filePath, originalPath });
  }
  return entries;
}

function matchesPathspecs(
  filePath: string,
  pathspecs: readonly string[] | undefined
): boolean {
  if (!pathspecs?.length) return true;
  return pathspecs.some((pathspec) => {
    const literalPrefix = ":(literal)";
    const prefix = pathspec.startsWith(literalPrefix)
      ? pathspec.slice(literalPrefix.length)
      : pathspec;
    const normalizedPrefix = prefix.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedPath = filePath.replace(/\\/g, "/");
    return (
      normalizedPath === normalizedPrefix ||
      normalizedPath.startsWith(`${normalizedPrefix}/`)
    );
  });
}

/** Parse `git diff --name-status -z`, including both paths for renames/copies. */
export function parseGitNameStatusZ(output: string): GitPorcelainV1Entry[] {
  const records = parseGitNulSeparatedPaths(output);
  const entries: GitPorcelainV1Entry[] = [];
  for (let index = 0; index < records.length;) {
    const status = records[index++] ?? "";
    const firstPath = records[index++];
    if (!firstPath) continue;
    const isRenameOrCopy = status.startsWith("R") || status.startsWith("C");
    const secondPath = isRenameOrCopy ? records[index++] : undefined;
    entries.push({
      x: status[0] ?? " ",
      y: " ",
      path: secondPath ?? firstPath,
      originalPath: isRenameOrCopy ? firstPath : undefined,
    });
  }
  return entries;
}

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
  const timeoutMs = options.timeout ?? getGitTimeoutMs();
  const startedAt = Date.now();
  let result;
  try {
    result = await execFilePromisified(file, args, {
      timeout: timeoutMs,
      maxBuffer: GIT_MAX_BUFFER,
      ...options,
    });
  } catch (error) {
    if (
      file === "git" &&
      (isTimeoutError(error) || exceededTimeout(startedAt, timeoutMs))
    ) {
      throw timeoutError(args, timeoutMs);
    }
    throw error;
  }
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

function execGitCheckIgnore(
  repoRoot: string,
  absolutePaths: readonly string[]
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = getGitTimeoutMs();
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-C", repoRoot, "check-ignore", "-z", "--stdin"],
      {
        timeout: timeoutMs,
        maxBuffer: GIT_MAX_BUFFER,
      },
      (error, stdout, stderr) => {
        if (error) {
          const execError = error as NodeJS.ErrnoException & {
            stdout: string;
            stderr: string;
          };
          execError.stdout = stdout;
          execError.stderr = stderr;
          if (
            isTimeoutError(execError) ||
            exceededTimeout(startedAt, timeoutMs)
          ) {
            reject(timeoutError(["-C", repoRoot, "check-ignore"], timeoutMs));
            return;
          }
          reject(execError);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
    if (child.stdin === null) {
      child.kill();
      reject(new Error("git check-ignore stdin is unavailable"));
      return;
    }
    child.stdin.end(`${absolutePaths.join("\0")}\0`);
  });
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
  limit: number | undefined,
  skip: number = 0,
  ref?: string,
  fullRefNames: boolean = false
): Promise<CommitInfo[]> {
  const args = [
    "-C",
    workspaceRoot,
    "log",
    // Trailing %P (parents) and %D (decorate) enable merge detection and ref pills.
    `--format=%H%x00%h%x00%s%x00%an%x00%ar%x00%P%x00%D`,
  ];
  if (fullRefNames) args.push("--decorate=full");
  if (limit !== undefined) {
    args.push("-n", String(limit));
  }
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

export interface FileHistoryCommitInfo extends CommitInfo {
  /** Repository-relative path on the commit side of this change. */
  path: string;
  /** Repository-relative path on the parent side of this change. */
  oldPath: string;
}

/**
 * Returns the commits that touched one path, newest first, following renames.
 *
 * This deliberately has its own parser rather than extending
 * getRecentCommits(): --name-status -z interleaves each commit's metadata
 * with one or two path tokens, which is what lets callers render both sides
 * of a rename.
 */
export async function getFileHistoryCommits(
  workspaceRoot: string,
  gitPath: string,
  limit: number | undefined = 30,
  skip: number = 0,
  ref?: string,
  fullRefNames: boolean = false
): Promise<FileHistoryCommitInfo[]> {
  const args = [
    "-C",
    workspaceRoot,
    "log",
    "--follow",
    "-z",
    "--name-status",
    "--format=%x00%H%x00%h%x00%s%x00%an%x00%ar%x00%P%x00%D%x00",
  ];
  if (fullRefNames) args.push("--decorate=full");
  if (skip > 0) args.push(`--skip=${skip}`);
  if (limit !== undefined) {
    args.push("-n", String(limit));
  }
  if (ref && ref.trim()) {
    args.push("--end-of-options", ref.trim());
  }
  args.push("--", gitPath);

  const { stdout } = await execFileAsync("git", args);
  const tokens = stdout.split("\0");
  const commits: FileHistoryCommitInfo[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const hash = tokens[index] ?? "";
    if (!/^[0-9a-f]{40}$/i.test(hash)) continue;

    const shortHash = tokens[index + 1] ?? "";
    const subject = tokens[index + 2] ?? "";
    const author = tokens[index + 3] ?? "";
    const relativeDate = tokens[index + 4] ?? "";
    const parents = tokens[index + 5] ?? "";
    const decorate = tokens[index + 6] ?? "";
    const parentHashes = parents.trim() ? parents.trim().split(/\s+/) : [];
    const refNames = decorate.trim()
      ? decorate
          .trim()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [];

    let statusIndex = index + 7;
    while (statusIndex < tokens.length && tokens[statusIndex] === "") {
      statusIndex++;
    }
    const status = (tokens[statusIndex] ?? "").replace(/^\r?\n/, "");
    const isRename = status.startsWith("R") || status.startsWith("C");
    const firstPath = tokens[statusIndex + 1];
    const secondPath = isRename ? tokens[statusIndex + 2] : undefined;
    const commitPath = secondPath ?? firstPath;
    if (!commitPath) continue;

    commits.push({
      hash,
      shortHash,
      subject,
      author,
      relativeDate,
      parentHashes,
      refNames,
      path: commitPath,
      oldPath: secondPath ? (firstPath ?? commitPath) : commitPath,
    });

    // Avoid mistaking a path that happens to look like a hash for the next
    // commit header; the next real header is the following empty token.
    index = statusIndex + (isRename ? 2 : 1);
  }

  return commits;
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
  hash: string,
  pathspecs?: readonly string[]
): Promise<string> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    workspaceRoot,
    "show",
    "--stat",
    "-p",
    "--end-of-options",
    hash,
    ...(pathspecs?.length ? ["--", ...pathspecs] : []),
  ]);
  return stdout;
}

/**
 * Read a blob without decoding it as UTF-8. Missing paths are represented by
 * null so callers can build added/deleted file payloads without treating a
 * normal absent side as a Git error.
 */
export async function getBlobBytes(
  repoRoot: string,
  ref: string,
  gitRelPath: string,
  maxBytes = GIT_MAX_BUFFER
): Promise<Buffer | null> {
  const objectSpec = ref === ":" ? `:${gitRelPath}` : `${ref}:${gitRelPath}`;
  let sizeResult: { stdout: string; stderr: string };
  try {
    sizeResult = await execFileAsync(
      "git",
      ["-C", repoRoot, "cat-file", "-s", objectSpec],
      { encoding: "buffer" }
    );
  } catch (error) {
    const stderr =
      error instanceof Error && "stderr" in error
        ? String((error as NodeJS.ErrnoException & { stderr?: unknown }).stderr)
        : "";
    const missingPath =
      stderr.includes("does not exist in") ||
      stderr.includes("exists on disk, but not in");
    const missingRootCommitParent =
      ref.endsWith("^") && stderr.includes("invalid object name");
    if (missingPath || missingRootCommitParent) return null;
    throw error;
  }

  const size = Number(sizeResult.stdout.trim());
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Git returned an invalid blob size for ${objectSpec}`);
  }
  if (size > maxBytes) throw new GitBlobTooLargeError(size, maxBytes);

  const result = await execFilePromisified(
    "git",
    ["-C", repoRoot, "show", objectSpec],
    {
      timeout: getGitTimeoutMs(),
      maxBuffer: Math.min(GIT_MAX_BUFFER, maxBytes + 1),
      encoding: "buffer",
    }
  );
  return Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout);
}

export class GitBlobTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number
  ) {
    super(
      `Git blob is ${size} bytes; the maximum diff side size is ${maxBytes}`
    );
    this.name = "GitBlobTooLargeError";
  }
}

export interface GitChangedFile {
  path: string;
  oldPath?: string;
  isBinary: boolean;
  status: string;
}

interface ParsedNumstatRecord {
  path: string;
  oldPath?: string;
  isBinary: boolean;
}

const NUMSTAT_RECORD_PATTERN = /^(\d+|-)\t(\d+|-)\t/;

/**
 * Return changed paths, Git status, and binary classification from one Git
 * diff/show invocation. The raw records provide change type and rename paths;
 * numstat provides the binary marker (`-\t-`).
 */
export async function getChangedFilesWithBinaryStatus(
  repoRoot: string,
  gitArgs: readonly string[]
): Promise<GitChangedFile[]> {
  const outputOptions = ["--raw", "--numstat", "-z", "--find-renames"];
  const boundaryIndex = gitArgs.indexOf("--end-of-options");
  const stashRevisionIndex = gitArgs.findIndex((arg) =>
    arg.startsWith("stash@{")
  );
  const insertionIndex =
    boundaryIndex >= 0
      ? boundaryIndex
      : stashRevisionIndex >= 0
        ? stashRevisionIndex
        : gitArgs.length;
  const args =
    insertionIndex >= 0
      ? [
          ...gitArgs.slice(0, insertionIndex),
          ...outputOptions,
          ...gitArgs.slice(insertionIndex),
        ]
      : [...gitArgs, ...outputOptions];
  const { stdout } = await execGit(["-C", repoRoot, ...args]);
  const tokens = stdout.split("\0");
  const statusByPath = new Map<string, { status: string; oldPath?: string }>();
  const numstatRecords: ParsedNumstatRecord[] = [];

  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? "";
    if (token.startsWith(":")) {
      const statusParts = token.trim().split(/\s+/);
      const status = statusParts[statusParts.length - 1] ?? "M";
      const oldPath = tokens[index + 1];
      const isRenameOrCopy = status.startsWith("R") || status.startsWith("C");
      if (!oldPath) continue;
      if (isRenameOrCopy) {
        const newPath = tokens[index + 2];
        if (!newPath) continue;
        statusByPath.set(newPath, { status, oldPath });
        index += 2;
      } else {
        statusByPath.set(oldPath, { status });
        index += 1;
      }
      continue;
    }

    const match = NUMSTAT_RECORD_PATTERN.exec(token);
    if (!match) continue;
    const additions = match[1];
    const deletions = match[2];
    const inlinePath = token.slice(match[0].length);
    let pathTokenIndex = index + 1;
    const firstPath = inlinePath || tokens[pathTokenIndex++];
    if (!firstPath) continue;
    const nextToken = tokens[pathTokenIndex] ?? "";
    const hasRenamePath =
      nextToken.length > 0 &&
      !nextToken.startsWith(":") &&
      !NUMSTAT_RECORD_PATTERN.test(nextToken);
    const secondPath = hasRenamePath ? nextToken : undefined;
    numstatRecords.push({
      path: secondPath ?? firstPath,
      oldPath: secondPath ? firstPath : undefined,
      isBinary: additions === "-" && deletions === "-",
    });
    index = secondPath ? pathTokenIndex : pathTokenIndex - 1;
    if (secondPath) index += 1;
  }

  return numstatRecords.map((record) => {
    const statusRecord =
      statusByPath.get(record.path) ??
      (record.oldPath ? statusByPath.get(record.oldPath) : undefined);
    return {
      ...record,
      status: statusRecord?.status ?? "M",
      oldPath: statusRecord?.oldPath ?? record.oldPath,
    };
  });
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
  return parseGitNulSeparatedPaths(stdout);
}

/** Return a unified diff between two commits/refs. */
export async function getDiffBetweenRefs(
  workspaceRoot: string,
  baseRef: string,
  targetRef: string,
  pathspecs?: readonly string[]
): Promise<string> {
  const { stdout } = await execGit([
    "-C",
    workspaceRoot,
    "diff",
    "--stat",
    "-p",
    GIT_DIFF_NO_EXT_DIFF_OPTION,
    "--end-of-options",
    baseRef,
    targetRef,
    ...(pathspecs?.length ? ["--", ...pathspecs] : []),
  ]);
  return stdout;
}

/**
 * Returns working tree diff (unstaged changes + untracked file summary).
 */
export async function getWorkingTreeDiff(
  workspaceRoot: string,
  pathspecs?: readonly string[]
): Promise<string> {
  const { stdout: diffOutput } = await execFileAsync(
    "git",
    [
      "-C",
      workspaceRoot,
      "diff",
      "--stat",
      "-p",
      GIT_DIFF_NO_EXT_DIFF_OPTION,
      ...(pathspecs?.length ? ["--", ...pathspecs] : []),
    ],
    { timeout: GIT_TIMEOUT_MS }
  );

  // Append untracked file list from git status --short
  const { stdout: statusOutput } = await execFileAsync(
    "git",
    [
      "-C",
      workspaceRoot,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "-z",
      ...(pathspecs?.length ? ["--", ...pathspecs] : []),
    ],
    { timeout: GIT_TIMEOUT_MS }
  );

  const untrackedLines = parseGitPorcelainV1Z(statusOutput)
    .filter(
      ({ x, y, path: filePath }) =>
        x === "?" && y === "?" && matchesPathspecs(filePath, pathspecs)
    )
    .map(({ path: filePath }) => filePath);

  if (untrackedLines.length > 0) {
    const untrackedSection = `\nUntracked files:\n${untrackedLines.map((f) => `  ${f}`).join("\n")}`;
    return diffOutput + untrackedSection;
  }

  return diffOutput;
}

/**
 * Returns staged diff only (git diff --cached).
 */
export async function getStagedDiff(
  workspaceRoot: string,
  pathspecs?: readonly string[]
): Promise<string> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      workspaceRoot,
      "diff",
      "--cached",
      "--stat",
      "-p",
      GIT_DIFF_NO_EXT_DIFF_OPTION,
      ...(pathspecs?.length ? ["--", ...pathspecs] : []),
    ],
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
  index: number,
  pathspecs?: readonly string[]
): Promise<string> {
  const stashRef = `stash@{${index}}`;
  const args = pathspecs?.length
    ? [
        "-C",
        workspaceRoot,
        "diff",
        "--stat",
        "-p",
        GIT_DIFF_NO_EXT_DIFF_OPTION,
        "--end-of-options",
        `${stashRef}^1`,
        stashRef,
        "--",
        ...pathspecs,
      ]
    : ["-C", workspaceRoot, "stash", "show", "-p", stashRef];
  const { stdout } = await execFileAsync("git", args, {
    timeout: GIT_TIMEOUT_MS,
  });
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
    [
      "-C",
      workspaceRoot,
      "stash",
      "show",
      "--name-only",
      "-z",
      `stash@{${index}}`,
    ],
    { timeout: GIT_TIMEOUT_MS }
  );
  return parseGitNulSeparatedPaths(stdout);
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
      "--fixed-strings",
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
 * Resolve a hexadecimal commit prefix and return its completion metadata.
 * `--end-of-options` keeps user-entered prefixes from being treated as flags.
 */
export async function getCommitByHash(
  workspaceRoot: string,
  hashPrefix: string
): Promise<CommitInfo | null> {
  if (!/^[0-9a-f]{4,40}$/i.test(hashPrefix)) return null;

  let hash: string;
  try {
    const resolved = await execFileAsync(
      "git",
      [
        "-C",
        workspaceRoot,
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${hashPrefix}^{commit}`,
      ],
      { timeout: GIT_TIMEOUT_MS }
    );
    hash = resolved.stdout.trim();
  } catch {
    return null;
  }

  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      workspaceRoot,
      "show",
      "-s",
      "--format=%H%x00%h%x00%s%x00%an%x00%ar",
      hash,
    ],
    { timeout: GIT_TIMEOUT_MS }
  );
  const [resolvedHash, shortHash, subject, author, relativeDate] = stdout
    .trim()
    .split("\0");
  if (!resolvedHash || !shortHash || !subject || !author || !relativeDate) {
    return null;
  }
  return {
    hash: resolvedHash,
    shortHash,
    subject,
    author,
    relativeDate,
    parentHashes: [],
    refNames: [],
  };
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
    if (gitRef === GIT_CHANGE_KINDS.DIFF) {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", workspaceRoot, "status", "--short"],
        { timeout: GIT_TIMEOUT_MS }
      );
      return stdout.trim()
        ? { exists: true }
        : { exists: false, message: "git diff not found" };
    }

    if (gitRef === GIT_CHANGE_KINDS.STAGED) {
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
  return parseGitNulSeparatedPaths(stdout);
}

/** Return tracked and non-ignored untracked paths, preserving Git's NUL-safe output. */
export async function getGitTrackedAndUntrackedFiles(
  repoRoot: string
): Promise<string[]> {
  const { stdout } = await execGit(
    [
      "-C",
      repoRoot,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { maxBuffer: GIT_MAX_BUFFER }
  );
  return parseGitNulSeparatedPaths(stdout);
}

/** Return non-ignored untracked paths, preserving Git's NUL-safe output. */
export async function getGitUntrackedFiles(
  repoRoot: string
): Promise<string[]> {
  const { stdout } = await execGit(
    ["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z"],
    { maxBuffer: GIT_MAX_BUFFER }
  );
  return parseGitNulSeparatedPaths(stdout);
}

/** Return ignored untracked paths recursively, preserving Git's NUL-safe output. */
export async function getGitIgnoredFiles(repoRoot: string): Promise<string[]> {
  const { stdout } = await execGit(
    [
      "-C",
      repoRoot,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
    ],
    { maxBuffer: GIT_MAX_BUFFER }
  );
  return parseGitNulSeparatedPaths(stdout);
}

/**
 * Return the absolute paths Git reports as ignored in one batched query.
 *
 * The default check-ignore mode intentionally remains in use: tracked files
 * must not qualify as source-only runtime artifacts, even when their paths
 * match an ignore rule.
 */
export async function getGitIgnoredPaths(
  repoRoot: string,
  absolutePaths: readonly string[]
): Promise<Set<string>> {
  const normalizedPaths = Array.from(
    new Set(absolutePaths.map((absolutePath) => path.resolve(absolutePath)))
  );
  if (normalizedPaths.length === 0) {
    return new Set<string>();
  }

  try {
    const { stdout } = await execGitCheckIgnore(repoRoot, normalizedPaths);
    return new Set(
      parseGitNulSeparatedPaths(stdout).map((value) => path.resolve(value))
    );
  } catch (error) {
    const gitError = error as NodeJS.ErrnoException & {
      stdout?: string | Buffer;
    };
    if (Number(gitError.code) !== 1) {
      throw error;
    }

    return new Set<string>();
  }
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
    return new Set(parseGitNulSeparatedPaths(stdout));
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
    const resolved = path.isAbsolute(result)
      ? result
      : path.resolve(dir, result);
    try {
      return path.normalize(await fs.realpath(resolved));
    } catch {
      return path.normalize(resolved);
    }
  } catch {
    return null;
  }
}

/** Where a directory's repository lives, as answered by `git rev-parse`. */
export interface GitLocationLookup {
  repoToplevel(dir: string): Promise<string | null>;
  gitCommonDir(dir: string): Promise<string | null>;
}

/** Asks Git every time. */
export const liveGitLocations: GitLocationLookup = {
  repoToplevel,
  gitCommonDir,
};

/**
 * Remembers repository locations for the length of one operation. Each
 * answer costs a `git` spawn (20–50ms on Windows), and one worktree operation
 * used to ask the same question about the same directory up to five times.
 *
 * Create one per operation and let it go out of scope when the operation ends;
 * never hold one for the life of a service. Only successful answers are kept,
 * because a directory that is not a repository yet (a worktree about to be
 * added) must be asked again once it is. `--absolute-git-dir` is deliberately
 * not memoized: a worktree removed and re-added at the same path can get a
 * different administrative directory within one operation.
 */
export class GitLocationMemo implements GitLocationLookup {
  private readonly toplevels = new Map<string, Promise<string | null>>();
  private readonly commonDirs = new Map<string, Promise<string | null>>();

  public constructor(
    private readonly source: GitLocationLookup = liveGitLocations
  ) {}

  public repoToplevel(dir: string): Promise<string | null> {
    return this.remember(this.toplevels, dir, (d) =>
      this.source.repoToplevel(d)
    );
  }

  public gitCommonDir(dir: string): Promise<string | null> {
    return this.remember(this.commonDirs, dir, (d) =>
      this.source.gitCommonDir(d)
    );
  }

  private remember(
    answers: Map<string, Promise<string | null>>,
    dir: string,
    ask: (dir: string) => Promise<string | null>
  ): Promise<string | null> {
    const key = foldPathForCompare(path.resolve(dir));
    const known = answers.get(key);
    if (known) return known;
    const pending = ask(dir).then(
      (answer) => {
        if (answer === null) answers.delete(key);
        return answer;
      },
      (error: unknown) => {
        answers.delete(key);
        throw error;
      }
    );
    answers.set(key, pending);
    return pending;
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
  await execGit(args, { timeout: getGitTimeoutMs(true) });
}

export async function removeWorktree(
  repoRoot: string,
  worktreePath: string,
  force = false
): Promise<void> {
  const args = ["-C", repoRoot, "worktree", "remove"];
  if (force) args.push("--force");
  args.push("--", worktreePath);
  await execGit(args, { timeout: getGitTimeoutMs(true) });
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

/** Return local branch names, sorted by most recent commit. */
export async function listLocalBranches(repoRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execGit([
      "-C",
      repoRoot,
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
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
  const args = ["-C", dir, "merge", "--ff-only", "--", ref];
  await execGit(args, { timeout: getGitTimeoutMs(true) });
}

/** Merge a ref non-interactively, creating a merge commit when necessary. */
export async function mergeNoFastForward(
  dir: string,
  ref: string
): Promise<void> {
  const args = ["-C", dir, "merge", "--no-ff", "--no-edit", "--", ref];
  await execGit(args, { timeout: getGitTimeoutMs(true) });
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
  return parseGitNulSeparatedPaths(stdout);
}

/** Abort an in-progress merge without invoking a shell or editor. */
export async function abortMerge(dir: string): Promise<void> {
  const args = ["-C", dir, "merge", "--abort"];
  await execGit(args, { timeout: getGitTimeoutMs(true) });
}

/** Stage and commit all changes. Returns false when there is nothing to commit. */
export async function commitAll(
  dir: string,
  message: string
): Promise<boolean> {
  if (!(await hasUncommittedChanges(dir))) return false;
  const addArgs = ["-C", dir, "add", "--all", "--", "."];
  await execGit(addArgs, { timeout: getGitTimeoutMs(true) });
  const commitArgs = ["-C", dir, "commit", `--message=${message}`, "--"];
  await execGit(commitArgs, {
    timeout: getGitTimeoutMs(true),
    env: {
      ...process.env,
      GIT_EDITOR: "true",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
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
