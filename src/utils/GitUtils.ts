import { execFile, spawn, type ChildProcess } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as fs from "fs/promises";
import type { ExecFileOptions } from "child_process";
import { GIT_CHANGE_KINDS } from "../types/DashboardConstants";
import { foldPathForCompare } from "./PathCasing";
import { sanitizeTerminalOutput } from "./TerminalOutputSanitizer";
import { isSubprocessTimeoutError } from "./SubprocessUtils";
import { Log } from "./Log";

export const GIT_DIFF_NO_EXT_DIFF_OPTION = "--no-ext-diff";

const GIT_TIMEOUT_MS = 10_000;
const GIT_MUTATION_TIMEOUT_MS = 5 * 60_000;
const GIT_MAX_BUFFER = 50 * 1024 * 1024;
/** Whole-repository `ls-files` listings: large monorepos can exceed 100 MB. */
const GIT_WHOLE_REPO_LISTING_MAX_BUFFER = 500 * 1024 * 1024;
const GIT_SUBMODULE_MODE = "160000";
const GIT_UNAVAILABLE_ERRNO = "ENOENT";
const execFilePromisified = promisify(execFile);

interface GitTimeoutOverrides {
  shortTimeoutMs?: number;
  mutationTimeoutMs?: number;
}

let gitTimeoutOverrides: GitTimeoutOverrides = {};
let gitCommandObserverForTests:
  ((file: string, args: readonly string[]) => void) | undefined;
let fileHistorySpawnForTests:
  ((file: string, args: readonly string[]) => ChildProcess) | undefined;

export function setFileHistorySpawnForTests(
  spawnProcess:
    ((file: string, args: readonly string[]) => ChildProcess) | undefined
): () => void {
  const previous = fileHistorySpawnForTests;
  fileHistorySpawnForTests = spawnProcess;
  return () => {
    fileHistorySpawnForTests = previous;
  };
}

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

/** Observe subprocess arguments in isolated tests. */
export function setGitCommandObserverForTests(
  observer: ((file: string, args: readonly string[]) => void) | undefined
): () => void {
  const previousObserver = gitCommandObserverForTests;
  gitCommandObserverForTests = observer;
  return () => {
    gitCommandObserverForTests = previousObserver;
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

/**
 * Timeout for read-only commands whose cost grows with the whole checkout,
 * such as `git status` over every file. They share the mutation ceiling: it
 * guards against a hung process, not a budget a large repository can outrun
 * (the short default does, on a cold Windows checkout).
 */
export function getGitWholeRepoTimeoutMs(): number {
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
  return isSubprocessTimeoutError(error);
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

/** One area's change counts in posh-git's `+added ~modified -deleted` shape. */
export interface GitChangeCounts {
  added: number;
  modified: number;
  deleted: number;
}

/** Uncommitted-change counts for one checkout, split the way posh-git shows them. */
export interface GitWorkingTreeCounts {
  /** Changes recorded in the index (porcelain column X). */
  staged: GitChangeCounts;
  /** Working-tree changes (column Y); untracked files count as added. */
  unstaged: GitChangeCounts;
  /** Paths with unresolved merge conflicts, counted in neither area. */
  conflicted: number;
}

/** Porcelain XY pairs that mark an unmerged path (`git status` "Unmerged paths"). */
const UNMERGED_STATUS_PAIRS = new Set([
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
]);

function countChange(counts: GitChangeCounts, code: string): void {
  switch (code) {
    case "A":
    case "?":
      counts.added++;
      return;
    case "D":
      counts.deleted++;
      return;
    case "M":
    case "R":
    case "C":
    case "T":
      counts.modified++;
      return;
  }
}

/** Fold porcelain v1 entries into posh-git style staged/unstaged/conflict counts. */
export function countGitWorkingTreeChanges(
  entries: readonly GitPorcelainV1Entry[]
): GitWorkingTreeCounts {
  const counts: GitWorkingTreeCounts = {
    staged: { added: 0, modified: 0, deleted: 0 },
    unstaged: { added: 0, modified: 0, deleted: 0 },
    conflicted: 0,
  };
  for (const { x, y } of entries) {
    if (UNMERGED_STATUS_PAIRS.has(`${x}${y}`)) {
      counts.conflicted++;
      continue;
    }
    // "??" is a single untracked file, not one staged and one unstaged add.
    if (x !== "?") countChange(counts.staged, x);
    countChange(counts.unstaged, y);
  }
  return counts;
}

function matchesPathspecs(
  filePath: string,
  pathspecs: readonly string[] | undefined
): boolean {
  if (!pathspecs?.length) return true;
  const excludes = pathspecs.filter(isExcludePathspec);
  const includes = pathspecs.filter((pathspec) => !isExcludePathspec(pathspec));
  return (
    (includes.length === 0 || includes.some((pathspec) => matchesPathspec(filePath, pathspec))) &&
    !excludes.some((pathspec) => matchesPathspec(filePath, pathspec))
  );
}

function isExcludePathspec(pathspec: string): boolean {
  return pathspec.startsWith(":(exclude") || pathspec.startsWith(":!");
}

function matchesPathspec(filePath: string, pathspec: string): boolean {
  let prefix = pathspec;
  if (prefix.startsWith(":!")) {
    prefix = prefix.slice(2);
  } else if (prefix.startsWith(":(")) {
    const magicEnd = prefix.indexOf(")");
    if (magicEnd >= 0) prefix = prefix.slice(magicEnd + 1);
  }
  if (prefix.startsWith("literal:")) prefix = prefix.slice("literal:".length);
  const normalizedPrefix = prefix.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = filePath.replace(/\\/g, "/");
  return (
    normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(`${normalizedPrefix}/`)
  );
}

/**
 * Return untracked paths for a working-tree diff. Status can span the entire
 * repository, so use Git's shared large-output buffer and whole-repo timeout.
 */
export async function getWorkingTreeUntrackedFiles(
  workspaceRoot: string,
  pathspecs?: readonly string[]
): Promise<string[]> {
  const { stdout } = await execGit(
    buildWorkingTreeStatusArgs(workspaceRoot, pathspecs),
    { timeout: getGitWholeRepoTimeoutMs() }
  );
  return parseUntrackedFiles(stdout, pathspecs);
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
  gitCommandObserverForTests?.(file, args);
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

/**
 * Longest git failure message `describeGitFailure` returns. Hook output (a
 * pre-push hook running a test suite) can run to thousands of lines; git's own
 * verdict and the hook's summary are at the end, so the tail is kept.
 */
export const GIT_FAILURE_MESSAGE_MAX_CHARS = 16_000;

/**
 * Git's own explanation of a failed command, for showing to a user: stderr
 * (where git and its hooks report), else stdout (`nothing to commit`), else
 * the error message (a timeout from `execGit`, or git failing to spawn).
 * Unlike `error.message` it does not lead with the command line, which names
 * the repository's absolute path.
 */
export function describeGitFailure(error: unknown): string {
  const output =
    error && typeof error === "object"
      ? (error as { stdout?: unknown; stderr?: unknown })
      : {};
  const outputText = (value: unknown): string =>
    value === undefined || value === null
      ? ""
      : sanitizeTerminalOutput(String(value)).trim();
  const message =
    outputText(output.stderr) ||
    outputText(output.stdout) ||
    (error instanceof Error ? error.message : String(error));
  return message.length > GIT_FAILURE_MESSAGE_MAX_CHARS
    ? `…${message.slice(-GIT_FAILURE_MESSAGE_MAX_CHARS)}`
    : message;
}

/** Return true only when Git explicitly reports that the cwd is not a repo. */
export function isNotGitRepositoryError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const gitError = error as { message?: unknown; stderr?: unknown };
  return [gitError.stderr, gitError.message].some((value) => {
    if (value === undefined || value === null) return false;
    return /fatal:\s*not a git repository\b/i.test(String(value));
  });
}

/** Git cannot provide a repository listing, so filesystem discovery should take over. */
export function isGitUnavailableError(error: unknown): boolean {
  if (isNotGitRepositoryError(error)) return true;
  if (!error || typeof error !== "object") return false;
  const gitError = error as {
    code?: unknown;
    message?: unknown;
    stderr?: unknown;
  };
  if (gitError.code === GIT_UNAVAILABLE_ERRNO) return true;
  return [gitError.stderr, gitError.message].some((value) =>
    /detected dubious ownership/i.test(String(value ?? ""))
  );
}

/**
 * Run git with the shared timeout and output limits. Prefer this to a bare
 * `promisify(execFile)`, whose 1 MiB default `maxBuffer` kills git once its
 * output is path-sized (about 15k `git status` entries).
 */
export async function execGit(
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
  args.splice(args.indexOf("log") + 1, 0, `--skip=${skip}`);
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
  args.push(`--skip=${skip}`);
  if (limit !== undefined) {
    args.push("-n", String(limit));
  }
  if (ref && ref.trim()) {
    args.push("--end-of-options", ref.trim());
  }
  args.push("--", gitPath);

  const { stdout } = await execFileAsync("git", args);
  return parseFileHistoryCommitOutput(stdout);
}

export interface BoundedFileHistoryResult {
  commits: FileHistoryCommitInfo[];
  timedOut: boolean;
  complete: boolean;
}

/** Stream a bounded --follow walk, preserving complete rows received at deadline. */
export async function getFileHistoryCommitsBounded(
  workspaceRoot: string,
  gitPath: string,
  limit: number,
  skip: number,
  ref: string,
  fullRefNames: boolean,
  timeoutMs: number
): Promise<BoundedFileHistoryResult> {
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
  args.push("-n", String(limit));
  if (ref.trim()) args.push("--end-of-options", ref.trim());
  args.push("--", gitPath);
  gitCommandObserverForTests?.("git", args);

  const chunks: Buffer[] = [];
  const child = (
    fileHistorySpawnForTests ??
    ((file, spawnArgs) =>
      spawn(file, [...spawnArgs], { stdio: ["ignore", "pipe", "pipe"] }))
  )("git", args);
  let timedOut = false;
  return new Promise<BoundedFileHistoryResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString("utf8");
      const commits = parseFileHistoryCommitOutput(stdout);
      if (!timedOut && code !== 0) {
        reject(
          new Error(
            stderr.trim() || `git log --follow exited with code ${code}`
          )
        );
        return;
      }
      resolve({ commits, timedOut, complete: !timedOut });
    });
  });
}

function parseFileHistoryCommitOutput(stdout: string): FileHistoryCommitInfo[] {
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
    const pathTerminatorIndex = statusIndex + (isRename ? 3 : 2);
    if (!commitPath || tokens[pathTerminatorIndex] === undefined) continue;

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
  const { stdout } = await execFileAsync(
    "git",
    buildCommitDiffArgs(workspaceRoot, hash, pathspecs)
  );
  return stdout;
}

export function buildCommitDiffArgs(
  workspaceRoot: string,
  hash: string,
  pathspecs?: readonly string[]
): string[] {
  return [
    "-C",
    workspaceRoot,
    "show",
    "--stat",
    "-p",
    "--end-of-options",
    hash,
    ...(pathspecs?.length ? ["--", ...pathspecs] : []),
  ];
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
    buildWorkingTreeDiffArgs(workspaceRoot, pathspecs),
    { timeout: GIT_TIMEOUT_MS }
  );

  return (
    diffOutput +
    formatUntrackedFilesSection(
      await getWorkingTreeUntrackedFiles(workspaceRoot, pathspecs)
    )
  );
}

export function buildWorkingTreeDiffArgs(
  workspaceRoot: string,
  pathspecs?: readonly string[]
): string[] {
  return [
    "-C",
    workspaceRoot,
    "diff",
    "--stat",
    "-p",
    GIT_DIFF_NO_EXT_DIFF_OPTION,
    ...(pathspecs?.length ? ["--", ...pathspecs] : []),
  ];
}

export function buildWorkingTreeStatusArgs(
  workspaceRoot: string,
  pathspecs?: readonly string[]
): string[] {
  return [
    "-C",
    workspaceRoot,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
    ...(pathspecs?.length ? ["--", ...pathspecs] : []),
  ];
}

export function parseUntrackedFiles(
  statusOutput: string,
  pathspecs?: readonly string[]
): string[] {
  return parseGitPorcelainV1Z(statusOutput)
    .filter(
      ({ x, y, path: filePath }) =>
        x === "?" && y === "?" && matchesPathspecs(filePath, pathspecs)
    )
    .map(({ path: filePath }) => filePath);
}

export function formatUntrackedFilesSection(files: readonly string[]): string {
  return files.length > 0
    ? `\nUntracked files:\n${files.map((file) => `  ${file}`).join("\n")}`
    : "";
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
    buildStagedDiffArgs(workspaceRoot, pathspecs),
    { timeout: GIT_TIMEOUT_MS }
  );
  return stdout;
}

export function buildStagedDiffArgs(
  workspaceRoot: string,
  pathspecs?: readonly string[]
): string[] {
  return [
    "-C",
    workspaceRoot,
    "diff",
    "--cached",
    "--stat",
    "-p",
    GIT_DIFF_NO_EXT_DIFF_OPTION,
    ...(pathspecs?.length ? ["--", ...pathspecs] : []),
  ];
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
  const { stdout } = await execFileAsync(
    "git",
    buildStashDiffArgs(workspaceRoot, index, pathspecs),
    {
      timeout: GIT_TIMEOUT_MS,
    }
  );
  return stdout;
}

export function buildStashDiffArgs(
  workspaceRoot: string,
  index: number,
  pathspecs?: readonly string[]
): string[] {
  const stashRef = `stash@{${index}}`;
  return pathspecs?.length
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
      timeout: getGitWholeRepoTimeoutMs(),
      maxBuffer: GIT_WHOLE_REPO_LISTING_MAX_BUFFER,
    }
  );
  return parseGitNulSeparatedPaths(stdout);
}

/**
 * Yield Git-visible files from a repository and any nested repositories or
 * initialized submodules. Git reports those children as one directory or
 * gitlink entry in the parent listing, so each child's listing is expanded
 * when reached. Directory entries themselves are never yielded.
 */
export async function* getGitFilesIncludingNestedRepos(
  repoRoot: string,
  chunkSize = 256,
  probeDependencies: GitNestedRepoProbeDependencies = DEFAULT_NESTED_REPO_PROBE_DEPENDENCIES
): AsyncGenerator<string[]> {
  const entries = await getGitTrackedFiles(repoRoot);
  const gitlinks = await getGitlinkPaths(repoRoot);
  let chunk: string[] = [];
  const flush = (): string[] => {
    const result = chunk;
    chunk = [];
    return result;
  };

  for (const entry of entries) {
    const relative = entry.replace(/\\/g, "/");
    const absolute = path.resolve(repoRoot, relative);
    // A gitlink only marks an entry worth probing: an unpopulated submodule is
    // an empty directory, and listing inside it falls back to the parent repo
    // (which reports the submodule as `./`), so recursing without the marker
    // check never terminates.
    const isGitlink = gitlinks.has(relative);
    let nestedRepository = false;
    if (isGitlink || entry.endsWith("/")) {
      const gitMarker = path.join(absolute, ".git");
      try {
        const entryStat = await probeDependencies.lstat(absolute);
        if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
          await probeDependencies.access(gitMarker);
          nestedRepository = true;
        }
      } catch {
        // Missing entries and uninitialized nested repositories have nothing to expand.
      }
    }

    if (entry.endsWith("/") || isGitlink) {
      if (chunk.length > 0) yield flush();
      if (!nestedRepository) continue;
      try {
        for await (const nestedChunk of getGitFilesIncludingNestedRepos(
          absolute,
          chunkSize,
          probeDependencies
        )) {
          const prefix = relative.endsWith("/") ? relative : `${relative}/`;
          yield nestedChunk.map((file) => `${prefix}${file}`);
        }
      } catch (error) {
        Log.warn(
          `[GitUtils] Could not list nested repository ${absolute}; skipping it: ${String(error)}`
        );
      }
      continue;
    }

    chunk.push(relative);
    if (chunk.length >= chunkSize) yield flush();
  }

  if (chunk.length > 0) yield chunk;
}

export interface GitNestedRepoProbeDependencies {
  lstat(absolutePath: string): Promise<{
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>;
  access(absolutePath: string): Promise<void>;
}

const DEFAULT_NESTED_REPO_PROBE_DEPENDENCIES: GitNestedRepoProbeDependencies = {
  lstat: (absolutePath) => fs.lstat(absolutePath),
  access: (absolutePath) => fs.access(absolutePath),
};

async function getGitlinkPaths(repoRoot: string): Promise<Set<string>> {
  const { stdout } = await execGit(["-C", repoRoot, "ls-files", "-s", "-z"], {
    timeout: getGitWholeRepoTimeoutMs(),
    maxBuffer: GIT_WHOLE_REPO_LISTING_MAX_BUFFER,
  });
  const paths = new Set<string>();
  for (const record of parseGitNulSeparatedPaths(stdout)) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode] = record.slice(0, tab).split(" ");
    if (mode === GIT_SUBMODULE_MODE) {
      paths.add(record.slice(tab + 1).replace(/\\/g, "/"));
    }
  }
  return paths;
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
    { timeout: getGitWholeRepoTimeoutMs(), maxBuffer: GIT_MAX_BUFFER }
  );
  return parseGitNulSeparatedPaths(stdout);
}

/** Return non-ignored untracked paths, preserving Git's NUL-safe output. */
export async function getGitUntrackedFiles(
  repoRoot: string
): Promise<string[]> {
  const { stdout } = await execGit(
    ["-C", repoRoot, "ls-files", "--others", "--exclude-standard", "-z"],
    { timeout: getGitWholeRepoTimeoutMs(), maxBuffer: GIT_MAX_BUFFER }
  );
  return parseGitNulSeparatedPaths(stdout);
}

/**
 * Return ignored untracked paths, preserving Git's NUL-safe output. A wholly
 * ignored directory is collapsed to one entry with a trailing "/" (e.g.
 * "node_modules/") instead of being expanded: the recursive listing is every
 * file under `node_modules/`, `dist/` and the like, which on a real checkout
 * is six figures of paths and takes seconds to produce and parse. Callers
 * that need the files walk those directories themselves, as far as they need.
 */
export async function getGitIgnoredEntries(
  repoRoot: string
): Promise<string[]> {
  const { stdout } = await execGit(
    [
      "-C",
      repoRoot,
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ],
    { timeout: getGitWholeRepoTimeoutMs(), maxBuffer: GIT_MAX_BUFFER }
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

/** Count a checkout's staged, unstaged, untracked and conflicted paths. */
export async function getWorkingTreeCounts(
  dir: string
): Promise<GitWorkingTreeCounts> {
  const { stdout } = await execGit([
    "-C",
    dir,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "-z",
  ]);
  return countGitWorkingTreeChanges(parseGitPorcelainV1Z(stdout));
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
