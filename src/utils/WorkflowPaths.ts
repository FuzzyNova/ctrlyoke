import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import { PATH_CONSTANTS } from "./ConfigurationUtils";
import { isPathWithinDirectory } from "./PathSecurity";
import { getFrozenRunHistoryLocation } from "./RunHistoryStoragePolicy";
import { projectStateRoot } from "./ProjectStatePaths";
import { TIMELINE_STORAGE_FILES } from "../types/WorkflowTimelineTypes";
import type { RunRef, WorkflowKey } from "../types/CtrlYokeTypes";

/**
 * Canonical, VS Code-free authority for the run-storage `.runs/<workflowKey>/...` layout.
 *
 * This is the *only* module allowed to construct a `.runs` path from raw parts, mint or
 * validate a `WorkflowKey`/`RunRef`, or decide whether a path is safely contained within
 * the runs root. Everything else — `WorkingFileManager`, `TimelineRecorder`,
 * `WorkflowLineageRepository`, `WorkflowLockManager`, `mcp-server.ts`, the CLI — goes
 * through here rather than joining path segments itself.
 *
 * Deliberately has no `vscode` or other extension-only dependency: `mcp-server.ts` (plain
 * Node/CJS) imports this module directly, mirroring the existing `FileLockUtils.ts` convention.
 */

export const WORKING_FILE_NAME = "workflow.ctrlyoke.json";
const DESCRIPTOR_FILE_NAME = "workflow.json";
const RUNNER_LOCK_FILE_NAME = "runner.json";
const STOP_REQUEST_FILE_PREFIX = "stop-request-";
const DRAFT_DIR_NAME = "draft";
const CREATING_PREFIX = ".creating-";

const RUN_REF_PREFIX = "run-";
/** Matches `run-<ISO timestamp with `:`/`.` replaced by `-`>`, e.g. `run-2026-07-20T10-30-00-000Z`. */
const RUN_REF_PATTERN = /^run-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;
const WORKFLOW_KEY_TIMESTAMP_SUFFIX =
  /-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-\d{3})?Z?$/;

// Windows reserved device names (case-insensitive), rejected as any path segment.
const WINDOWS_RESERVED_NAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

class WorkflowPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowPathError";
  }
}

function isSafeSegment(segment: string): boolean {
  if (!segment || segment === "." || segment === "..") {
    return false;
  }
  if (segment.includes("/") || segment.includes("\\")) {
    return false;
  }
  const withoutExtensions = segment.split(".")[0];
  if (WINDOWS_RESERVED_NAMES.has(withoutExtensions.toLowerCase())) {
    return false;
  }
  return true;
}

/** Throws `WorkflowPathError` unless `value` is a syntactically valid `WorkflowKey`. */
export function assertValidWorkflowKey(
  value: string
): asserts value is WorkflowKey {
  if (!isSafeSegment(value)) {
    throw new WorkflowPathError(`Invalid workflowKey: "${value}"`);
  }
}

/** Throws `WorkflowPathError` unless `value` is a syntactically valid `RunRef`. */
export function assertValidRunRef(value: string): asserts value is RunRef {
  if (!isSafeSegment(value) || !RUN_REF_PATTERN.test(value)) {
    throw new WorkflowPathError(`Invalid runRef: "${value}"`);
  }
}

function isValidRunRef(value: string): value is RunRef {
  try {
    assertValidRunRef(value);
    return true;
  } catch {
    return false;
  }
}

function isValidWorkflowKey(value: string): value is WorkflowKey {
  try {
    assertValidWorkflowKey(value);
    return true;
  } catch {
    return false;
  }
}

/** `run-<UTC-ms-timestamp>` — the sortable grammar the whole layout relies on for "newest". */
export function formatRunRef(timestampMs: number): RunRef {
  const timestamp = new Date(timestampMs).toISOString().replace(/[:.]/g, "-");
  const runRef = `${RUN_REF_PREFIX}${timestamp}`;
  assertValidRunRef(runRef);
  return runRef;
}

/** Returns the timestamp encoded in a `RunRef`, or `undefined` if it doesn't parse. */
export function parseRunRefTimestamp(runRef: string): number | undefined {
  const match = runRef.match(RUN_REF_PATTERN);
  if (!match) {
    return undefined;
  }
  const restored = match[1].replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    "$1$2:$3:$4.$5"
  );
  const timestampMs = new Date(restored).getTime();
  return Number.isNaN(timestampMs) ? undefined : timestampMs;
}

function sanitizeNameForKey(nameHint: string): string {
  const fileName = path.basename(nameHint);
  const base = fileName.replace(/\.ctrlyoke\.(?:json|ya?ml)$/i, "");
  const nameWithoutExtension =
    base === fileName ? path.basename(fileName, path.extname(fileName)) : base;
  const sanitized = nameWithoutExtension
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "workflow";
}

/**
 * A lineage key minus its timestamp suffix: the slug the key was minted from,
 * and the display name of last resort when a lineage has no descriptor name.
 */
export function workflowNameFromKey(workflowKey: string): string {
  return workflowKey.replace(WORKFLOW_KEY_TIMESTAMP_SUFFIX, "");
}

// ---- Root/lineage/run path construction ----

/** Resolve the `.runs` root for the project identified by `stateRoot`. */
export function runsRoot(stateRoot: string): string {
  return path.join(
    projectStateRoot(stateRoot, getFrozenRunHistoryLocation()),
    PATH_CONSTANTS.RUNS_DIR
  );
}

/** Resolve `.runs` beneath an already-selected project state root. */
export function runsRootForProjectState(projectRoot: string): string {
  return path.join(path.resolve(projectRoot), PATH_CONSTANTS.RUNS_DIR);
}

// ---- Recently deleted (`.trash`, a sibling of `.runs`) ----

const TRASH_ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;
const PENDING_TRASH_ENTRY_SUFFIX = ".pending";

/** Resolve the Recently deleted root beside `.runs` for `stateRoot`'s project. */
export function trashRoot(stateRoot: string): string {
  return path.join(
    projectStateRoot(stateRoot, getFrozenRunHistoryLocation()),
    PATH_CONSTANTS.TRASH_DIR
  );
}

export function isValidTrashEntryId(entryId: string): boolean {
  return TRASH_ENTRY_ID_PATTERN.test(entryId);
}

function trashEntryPath(stateRoot: string, name: string): string {
  const root = trashRoot(stateRoot);
  const dir = path.join(root, name);
  if (!isPathWithinDirectory(path.resolve(dir), path.resolve(root))) {
    throw new WorkflowPathError(`Path escapes .trash root: "${dir}"`);
  }
  return dir;
}

/** A committed Recently deleted entry directory. */
export function trashEntryDir(stateRoot: string, entryId: string): string {
  if (!isValidTrashEntryId(entryId)) {
    throw new WorkflowPathError(`Invalid trash entry id: "${entryId}"`);
  }
  return trashEntryPath(stateRoot, entryId);
}

/** The staging directory an entry is assembled in before it is committed. */
export function pendingTrashEntryDir(
  stateRoot: string,
  entryId: string
): string {
  if (!isValidTrashEntryId(entryId)) {
    throw new WorkflowPathError(`Invalid trash entry id: "${entryId}"`);
  }
  return trashEntryPath(stateRoot, `${entryId}${PENDING_TRASH_ENTRY_SUFFIX}`);
}

/** The entry id of a `.trash` child, and whether it is still pending; undefined otherwise. */
export function parseTrashEntryDirName(
  name: string
): { entryId: string; pending: boolean } | undefined {
  const pending = name.endsWith(PENDING_TRASH_ENTRY_SUFFIX);
  const entryId = pending
    ? name.slice(0, -PENDING_TRASH_ENTRY_SUFFIX.length)
    : name;
  return isValidTrashEntryId(entryId) ? { entryId, pending } : undefined;
}

export function lineageDir(
  workspaceRoot: string,
  workflowKey: WorkflowKey
): string {
  assertValidWorkflowKey(workflowKey);
  const dir = path.join(runsRoot(workspaceRoot), workflowKey);
  assertContained(workspaceRoot, dir);
  return dir;
}

export function descriptorPath(
  workspaceRoot: string,
  workflowKey: WorkflowKey
): string {
  return path.join(
    lineageDir(workspaceRoot, workflowKey),
    DESCRIPTOR_FILE_NAME
  );
}

export function runnerLockPath(
  workspaceRoot: string,
  workflowKey: WorkflowKey
): string {
  return path.join(
    lineageDir(workspaceRoot, workflowKey),
    RUNNER_LOCK_FILE_NAME
  );
}

/** Resolve a runner lock when the caller already has the selected state root. */
export function runnerLockPathForProjectState(
  projectStateRootPath: string,
  workflowKey: WorkflowKey
): string {
  assertValidWorkflowKey(workflowKey);
  const lineagePath = path.join(
    runsRootForProjectState(projectStateRootPath),
    workflowKey
  );
  assertContained(
    projectStateRootPath,
    lineagePath,
    runsRootForProjectState(projectStateRootPath)
  );
  return path.join(lineagePath, RUNNER_LOCK_FILE_NAME);
}

/** Resolve the owner-token-scoped stop request sentinel for a live run. */
export function stopRequestPath(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  ownerToken: string
): string {
  if (!/^[A-Za-z0-9_-]+$/.test(ownerToken)) {
    throw new WorkflowPathError("Invalid runner owner token");
  }
  return path.join(
    lineageDir(workspaceRoot, workflowKey),
    `${STOP_REQUEST_FILE_PREFIX}${ownerToken}.json`
  );
}

export function draftDir(
  workspaceRoot: string,
  workflowKey: WorkflowKey
): string {
  return path.join(lineageDir(workspaceRoot, workflowKey), DRAFT_DIR_NAME);
}

export function draftFilePath(
  workspaceRoot: string,
  workflowKey: WorkflowKey
): string {
  return path.join(draftDir(workspaceRoot, workflowKey), WORKING_FILE_NAME);
}

export function runDir(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  runRef: RunRef
): string {
  assertValidRunRef(runRef);
  const dir = path.join(lineageDir(workspaceRoot, workflowKey), runRef);
  assertContained(workspaceRoot, dir);
  return dir;
}

export function runFilePath(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  runRef: RunRef
): string {
  return path.join(
    runDir(workspaceRoot, workflowKey, runRef),
    WORKING_FILE_NAME
  );
}

/** Recovery directory owned by a promoted run while a same-run rewind is edited. */
export function pendingRewindDir(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  runRef: RunRef
): string {
  const dir = path.join(
    runDir(workspaceRoot, workflowKey, runRef),
    "pending-rewind"
  );
  assertContained(workspaceRoot, dir);
  return dir;
}

/** Full pre-rewind recovery snapshot; never use this as an execution definition. */
export function pendingRewindBaseFilePath(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  runRef: RunRef
): string {
  const filePath = path.join(
    pendingRewindDir(workspaceRoot, workflowKey, runRef),
    "base.ctrlyoke.json"
  );
  assertContained(workspaceRoot, filePath);
  return filePath;
}

export function manifestPath(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  runRef: RunRef
): string {
  return path.join(
    runDir(workspaceRoot, workflowKey, runRef),
    TIMELINE_STORAGE_FILES.MANIFEST
  );
}

export function eventsPath(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  runRef: RunRef
): string {
  return path.join(
    runDir(workspaceRoot, workflowKey, runRef),
    TIMELINE_STORAGE_FILES.EVENTS
  );
}

/** Hidden staging directory for a run being created, promoted via atomic rename. */
export function stagingRunDir(
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  stagingId: string
): string {
  if (
    !stagingId ||
    stagingId.includes("/") ||
    stagingId.includes("\\") ||
    stagingId.includes("..")
  ) {
    throw new WorkflowPathError(`Invalid staging id: "${stagingId}"`);
  }
  const dir = path.join(
    lineageDir(workspaceRoot, workflowKey),
    `${CREATING_PREFIX}${stagingId}`
  );
  assertContained(workspaceRoot, dir);
  return dir;
}

function assertContained(
  workspaceRoot: string,
  candidate: string,
  selectedRunsRoot?: string
): void {
  const root = path.resolve(selectedRunsRoot ?? runsRoot(workspaceRoot));
  const resolved = path.resolve(candidate);
  if (!isPathWithinDirectory(resolved, root)) {
    throw new WorkflowPathError(
      `Path escapes .runs root: "${candidate}" (root "${root}")`
    );
  }
}

// ---- Directory-entry classification (for scans) ----

/** True for direct children of the run-storage `.runs/` root that are real lineage directories. */
export function isLineageDirEntry(entry: fs.Dirent): boolean {
  return (
    entry.isDirectory() &&
    isSafeSegment(entry.name) &&
    !entry.name.startsWith(".")
  );
}

/** True for direct children of a lineage dir that are promoted run directories. */
export function isRunDirEntry(entry: fs.Dirent): boolean {
  return (
    entry.isDirectory() &&
    entry.name !== DRAFT_DIR_NAME &&
    isValidRunRef(entry.name)
  );
}

/** Whether a lineage child directory is the mutable draft working-file directory. */
export function isDraftDirEntry(entry: fs.Dirent): boolean {
  return entry.isDirectory() && entry.name === DRAFT_DIR_NAME;
}

/** True for direct children of a lineage dir that are stale/interrupted staging leftovers. */
export function isStagingDirEntry(entry: fs.Dirent): boolean {
  return entry.isDirectory() && entry.name.startsWith(CREATING_PREFIX);
}

// ---- Parsing ----

export interface ParsedRunFilePath {
  workflowKey: WorkflowKey;
  runRef: RunRef;
}

/**
 * Parses a run-storage `.runs/<workflowKey>/<runRef>/workflow.ctrlyoke.json` path back into its address.
 * Returns `undefined` for anything that isn't exactly that shape (draft files, other
 * artifacts, and paths outside the runs root all return `undefined` — use
 * `parseRunArtifactPath` for the more permissive form).
 */
export function parseRunFilePath(
  workspaceRoot: string,
  filePath: string
): ParsedRunFilePath | undefined {
  const parsed = parseRunArtifactPath(workspaceRoot, filePath);
  if (!parsed || path.basename(filePath) !== WORKING_FILE_NAME) {
    return undefined;
  }
  return { workflowKey: parsed.workflowKey, runRef: parsed.runRef };
}

export interface ParsedRunArtifactPath {
  workflowKey: WorkflowKey;
  runRef: RunRef;
  fileName: string;
}

/** Parses any file directly inside a promoted run directory (manifest, events, definition, ...). */
export function parseRunArtifactPath(
  workspaceRoot: string,
  filePath: string
): ParsedRunArtifactPath | undefined {
  const root = path.resolve(runsRoot(workspaceRoot));
  const resolved = path.resolve(filePath);
  if (!isPathWithinDirectory(resolved, root)) {
    return undefined;
  }
  const relative = path.relative(root, resolved);
  const segments = relative.split(path.sep);
  if (segments.length !== 3) {
    return undefined;
  }
  const [workflowKeySegment, runRefSegment, fileName] = segments;
  if (
    !isValidWorkflowKey(workflowKeySegment) ||
    !isValidRunRef(runRefSegment)
  ) {
    return undefined;
  }
  return {
    workflowKey: workflowKeySegment,
    runRef: runRefSegment,
    fileName,
  };
}

export interface ParsedWorkingFileAddress {
  workflowKey: WorkflowKey;
  /** Undefined means this is the lineage's draft, not a promoted run. */
  runRef?: RunRef;
}

/**
 * Reconstructs `{workflowKey, runRef?}` from a `workflow.ctrlyoke.json` path by its
 * directory shape alone (`.../<workflowKey>/draft/workflow.ctrlyoke.json` or
 * `.../<workflowKey>/<runRef>/workflow.ctrlyoke.json`) — no `workspaceRoot` or containment
 * check required, since this is meant for reconstructing identity from a path ctrlyoke
 * itself already persisted (e.g. into `QueueState.workingFilePath`), not for validating
 * untrusted input. Use `parseRunFilePath`/`parseRunArtifactPath` when a `workspaceRoot`
 * is available and containment matters.
 */
export function parseWorkingFileAddressFromPath(
  filePath: string
): ParsedWorkingFileAddress | undefined {
  if (path.basename(filePath) !== WORKING_FILE_NAME) {
    return undefined;
  }
  const parentDir = path.basename(path.dirname(filePath));
  const grandparentDir = path.basename(path.dirname(path.dirname(filePath)));
  if (!isValidWorkflowKey(grandparentDir)) {
    return undefined;
  }
  if (parentDir === DRAFT_DIR_NAME) {
    return { workflowKey: grandparentDir };
  }
  if (isValidRunRef(parentDir)) {
    return { workflowKey: grandparentDir, runRef: parentDir };
  }
  return undefined;
}

/**
 * The run (or draft) directory containing a working file. Every working-file
 * path is built as `path.join(runDir|draftDir, WORKING_FILE_NAME)`, so the
 * parent is the directory by construction — this exists so callers do not
 * encode that layout fact themselves.
 */
export function runDirectoryForWorkingFile(workingFilePath: string): string {
  return path.dirname(path.resolve(workingFilePath));
}

/**
 * Stable, filesystem-safe identity for temporary artifacts owned by a working file.
 * Run and draft files share the same basename, so include their lineage/run address.
 * Nonstandard working-file paths use a short hash of their normalized absolute path.
 */
export function runArtifactStem(workingFilePath: string): string {
  const address = parseWorkingFileAddressFromPath(workingFilePath);
  if (address) {
    return `${address.workflowKey}-${address.runRef ?? DRAFT_DIR_NAME}`;
  }

  const normalizedPath = path.normalize(path.resolve(workingFilePath));
  return crypto
    .createHash("sha256")
    .update(normalizedPath)
    .digest("hex")
    .slice(0, 16);
}

// ---- WorkflowKey allocation ----

/**
 * Exclusively creates a new lineage directory and returns its `WorkflowKey`. Sanitizes
 * `nameHint` into a slug, appends a creation timestamp, and retries with an advancing
 * suffix on collision — mirrors the pre-refactor working-file naming grammar, but the
 * directory create is now the exclusivity primitive instead of a bare path string.
 */
export async function allocateWorkflowKey(
  workspaceRoot: string,
  nameHint: string,
  now: () => number = Date.now
): Promise<WorkflowKey> {
  const slug = sanitizeNameForKey(nameHint);
  const root = runsRoot(workspaceRoot);
  await fs.promises.mkdir(root, { recursive: true });

  const maxAttempts = 25;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const timestamp = new Date(now() + attempt)
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace(/Z$/, "");
    const candidate = `${slug}-${timestamp}`;
    assertValidWorkflowKey(candidate);
    const dir = path.join(root, candidate);
    try {
      await fs.promises.mkdir(dir);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // Collision — retry with an advanced timestamp.
    }
  }
  throw new WorkflowPathError(
    `Failed to allocate a unique workflowKey for "${nameHint}" after ${maxAttempts} attempts`
  );
}
