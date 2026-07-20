import * as fs from "fs";
import * as path from "path";
import { PATH_CONSTANTS } from "./ConfigurationUtils";
import { isPathWithinDirectory } from "./PathSecurity";
import { TIMELINE_STORAGE_FILES } from "../types/WorkflowTimelineTypes";
import type { RunRef, WorkflowKey } from "../types/CtrlYokeTypes";

/**
 * Canonical, VS Code-free authority for the `.ctrlyoke/.runs/<workflowKey>/...` layout.
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
export const DESCRIPTOR_FILE_NAME = "workflow.json";
export const RUNNER_LOCK_FILE_NAME = "runner.json";
export const DRAFT_DIR_NAME = "draft";
const CREATING_PREFIX = ".creating-";

const RUN_REF_PREFIX = "run-";
/** Matches `run-<ISO timestamp with `:`/`.` replaced by `-`>`, e.g. `run-2026-07-20T10-30-00-000Z`. */
const RUN_REF_PATTERN = /^run-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;

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

export class WorkflowPathError extends Error {
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

/** Case-insensitive on Windows, case-sensitive elsewhere — matches filesystem semantics. */
function pathsEqualForPlatform(a: string, b: string): boolean {
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function isContainedForPlatform(candidate: string, directory: string): boolean {
  if (process.platform !== "win32") {
    return isPathWithinDirectory(candidate, directory);
  }
  return isPathWithinDirectory(
    candidate.toLowerCase(),
    directory.toLowerCase()
  );
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

export function isValidRunRef(value: string): value is RunRef {
  try {
    assertValidRunRef(value);
    return true;
  } catch {
    return false;
  }
}

export function isValidWorkflowKey(value: string): value is WorkflowKey {
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
  const base = path.basename(nameHint, path.extname(nameHint));
  const sanitized = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "workflow";
}

// ---- Root/lineage/run path construction ----

export function runsRoot(workspaceRoot: string): string {
  return path.join(
    workspaceRoot,
    PATH_CONSTANTS.CTRLYOKE_DIR,
    PATH_CONSTANTS.RUNS_DIR
  );
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

function assertContained(workspaceRoot: string, candidate: string): void {
  const root = path.resolve(runsRoot(workspaceRoot));
  const resolved = path.resolve(candidate);
  if (!isContainedForPlatform(resolved, root)) {
    throw new WorkflowPathError(
      `Path escapes .runs root: "${candidate}" (root "${root}")`
    );
  }
}

// ---- Directory-entry classification (for scans) ----

/** True for direct children of `.runs/` that are real, addressable lineage directories. */
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
 * Parses `.../.runs/<workflowKey>/<runRef>/workflow.ctrlyoke.json` back into its address.
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
  if (!isContainedForPlatform(resolved, root)) {
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
      .substring(0, 19);
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

export { pathsEqualForPlatform };
