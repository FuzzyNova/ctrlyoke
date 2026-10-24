import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type {
  RunRef,
  WorkflowKey,
  WorkingFile,
  WorkflowStep,
} from "../types/CtrlYokeTypes";
import {
  RUN_DEFINITION_CHANGE_SCOPES,
  RUN_DEFINITION_INTEGRITY,
  type RunDefinitionChange,
} from "../types/DashboardConstants";
import { writeFileAtomic } from "./AtomicFileUtils";
import {
  assertWritableSchema,
  CURRENT_SCHEMA_VERSIONS,
  hasNewerSchema,
  PERSISTED_STORES,
} from "./PersistedSchemaGuard";
import { describeRunDefinitionChanges } from "./RunDefinitionChanges";
import { runStateWriteOptions } from "./RunStateWrites";

export { describeRunDefinitionChanges };
import { stableStringify } from "./StableJson";
import * as WorkflowPaths from "./WorkflowPaths";
import { definitionAnchorPath } from "./WorkflowPaths";

/**
 * Run definition anchors: proof, kept where no harness sandbox can write, of
 * the definition ctrlyoke itself last wrote to a run or draft working file.
 *
 * The runner treats the working file as the source of truth for pending
 * steps, and the dashboard, `ctrlyoke step`, and the MCP tools all talk to it
 * through that file. In workspace storage mode the file sits inside every
 * harness's writable workspace, so an agent could otherwise give a later step
 * a raw condition script, wider tool permissions, or a new script step by
 * editing JSON. Nothing stops a process running as the same user from writing
 * the file; what this module stops is ctrlyoke *honoring* a definition none of
 * its own writers produced.
 *
 * Every write of a working file goes through {@link writeAnchoredRunDefinition}
 * (both serialization chokepoints call it), which records the definition's hash
 * and a copy of it under the user state home before the file is replaced. A
 * reader compares the file with that anchor. The copy is what makes a rejected
 * change recoverable: the live queue keeps step topology and runtime in
 * memory, but workflow-level settings (`harness`, `hooks`, `toolPermissions`,
 * `finalStep`, ...) exist only in the file, so a hash alone could detect a
 * changed setting but never put the trusted one back.
 *
 * Only the definition is anchored. `_runtime` blocks are written constantly by
 * the executor and are not authored, so they are excluded; the copy keeps each
 * step's `_runtime.stepId` (unhashed) so a restore can match runtime to steps.
 *
 * Node-only and `vscode`-free: imported by the extension, CLI and MCP bundles.
 */

/** The authored part of a working file, as anchored and hashed. */
export type RunDefinition = Record<string, unknown>;

export interface RunDefinitionAnchor {
  schemaVersion: number;
  /** `definitionRevision` of the anchored definition, for diagnostics. */
  definitionRevision: number;
  definitionHash: string;
  /**
   * The definition this anchor replaced, accepted only while the write that
   * replaces it is in flight: the anchor is recorded before the file is
   * replaced, so a reader may still see the old file.
   */
  previousDefinitionHash?: string;
  /** Hash of the snapshot a pending rewind can restore (`discardPendingRewind`). */
  rewindBaseHash?: string;
  recordedAt: number;
  /** The trusted definition itself, used to restore a rejected change. */
  definition: RunDefinition;
}

export type RunDefinitionVerdict =
  | { status: typeof RUN_DEFINITION_INTEGRITY.UNANCHORABLE }
  | { status: typeof RUN_DEFINITION_INTEGRITY.UNANCHORED }
  | {
      status: typeof RUN_DEFINITION_INTEGRITY.TRUSTED;
      anchor: RunDefinitionAnchor;
    }
  | {
      status: typeof RUN_DEFINITION_INTEGRITY.CHANGED_OUTSIDE;
      anchor: RunDefinitionAnchor;
      definitionHash: string;
      changes: RunDefinitionChange[];
    };

export type ChangedRunDefinitionVerdict = Extract<
  RunDefinitionVerdict,
  { status: typeof RUN_DEFINITION_INTEGRITY.CHANGED_OUTSIDE }
>;

/**
 * Thrown instead of writing over (and so re-anchoring) a definition that was
 * changed outside ctrlyoke. Every writer builds its content from the file it
 * just read, so writing would launder the outside change into a trusted one.
 */
export class RunDefinitionChangedError extends Error {
  constructor(
    readonly workingFilePath: string,
    readonly changes: readonly RunDefinitionChange[]
  ) {
    super(
      `This run's definition was changed outside ctrlyoke (${describeRunDefinitionChanges(changes)}), ` +
        `so ctrlyoke will not run or edit it until you review the change. ` +
        `Accept or restore it from the dashboard, or with "ctrlyoke step accept-definition" ` +
        `or "ctrlyoke step restore-definition". (${workingFilePath})`
    );
    this.name = "RunDefinitionChangedError";
  }
}

export function isRunDefinitionChangedError(
  error: unknown
): error is RunDefinitionChangedError {
  return error instanceof RunDefinitionChangedError;
}

/** Re-reads before concluding a definition changed; see {@link verifyRunDefinitionFile}. */
const VERIFY_READ_ATTEMPTS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function definitionStep(step: unknown): unknown {
  if (!isRecord(step)) {
    return step;
  }
  const { _runtime: runtime, ...authored } = step;
  const stepId =
    isRecord(runtime) && typeof runtime.stepId === "string"
      ? runtime.stepId
      : undefined;
  return stepId === undefined
    ? authored
    : { ...authored, _runtime: { stepId } };
}

/**
 * The definition of a working file as anchored: everything except `_runtime`
 * blocks (a step keeps only its `stepId`, which is not hashed) and the format
 * stamp. Returned as a detached JSON copy, so it hashes exactly like the bytes
 * a reader parses.
 */
export function extractRunDefinition(workingFile: unknown): RunDefinition {
  const definition: RunDefinition = {};
  if (!isRecord(workingFile)) {
    return definition;
  }
  const {
    _runtime: _runtimeState,
    schemaVersion: _schemaVersion,
    steps,
    finalStep,
    ...workflowFields
  } = workingFile;
  Object.assign(definition, workflowFields);
  if (steps !== undefined) {
    definition.steps = Array.isArray(steps) ? steps.map(definitionStep) : steps;
  }
  if (finalStep !== undefined) {
    definition.finalStep = definitionStep(finalStep);
  }
  return cloneJson(definition);
}

/**
 * The definition without step identities. A step's `stepId` is kept in the
 * anchored copy so a restore can hand each step back its own runtime, but it
 * is runtime identity rather than authored content: recovery backfills
 * missing ones, and it decides nothing about what a step may run.
 */
function authoredDefinition(definition: RunDefinition): RunDefinition {
  const withoutIdentity = (step: unknown) => {
    if (!isRecord(step)) return step;
    const { _runtime: _identity, ...authored } = step;
    return authored;
  };
  const { steps, finalStep, ...workflow } = definition;
  return {
    ...workflow,
    ...(Array.isArray(steps) ? { steps: steps.map(withoutIdentity) } : {}),
    ...(finalStep !== undefined
      ? { finalStep: withoutIdentity(finalStep) }
      : {}),
  };
}

/** The step IDs a definition copy carries, so a backfill refreshes the copy. */
function stepIdentityOf(definition: RunDefinition): string {
  const idOf = (step: unknown) =>
    isRecord(step) && isRecord(step._runtime) ? step._runtime.stepId : null;
  return JSON.stringify([
    Array.isArray(definition.steps) ? definition.steps.map(idOf) : [],
    idOf(definition.finalStep),
  ]);
}

export function hashRunDefinition(definition: RunDefinition): string {
  return crypto
    .createHash("sha256")
    .update(stableStringify(authoredDefinition(definition)))
    .digest("hex");
}

function changedFields(trusted: unknown, current: unknown): string[] {
  const trustedRecord = isRecord(trusted) ? trusted : {};
  const currentRecord = isRecord(current) ? current : {};
  const keys = new Set([
    ...Object.keys(trustedRecord),
    ...Object.keys(currentRecord),
  ]);
  return [...keys]
    .filter(
      (key) =>
        stableStringify(trustedRecord[key]) !==
        stableStringify(currentRecord[key])
    )
    .sort();
}

/** What an outside change touched, for warnings: workflow fields, then steps, then the final step. */
export function diffRunDefinitions(
  trusted: RunDefinition,
  current: RunDefinition
): RunDefinitionChange[] {
  const changes: RunDefinitionChange[] = [];
  const {
    steps: trustedSteps,
    finalStep: trustedFinal,
    ...trustedWorkflow
  } = authoredDefinition(trusted);
  const {
    steps: currentSteps,
    finalStep: currentFinal,
    ...currentWorkflow
  } = authoredDefinition(current);

  const workflowFields = changedFields(trustedWorkflow, currentWorkflow);
  if (workflowFields.length > 0) {
    changes.push({
      scope: RUN_DEFINITION_CHANGE_SCOPES.WORKFLOW,
      fields: workflowFields,
    });
  }

  const trustedList = Array.isArray(trustedSteps) ? trustedSteps : [];
  const currentList = Array.isArray(currentSteps) ? currentSteps : [];
  for (
    let index = 0;
    index < Math.max(trustedList.length, currentList.length);
    index++
  ) {
    const stepNumber = index + 1;
    if (index >= trustedList.length) {
      changes.push({
        scope: RUN_DEFINITION_CHANGE_SCOPES.STEP,
        stepNumber,
        fields: ["added"],
      });
    } else if (index >= currentList.length) {
      changes.push({
        scope: RUN_DEFINITION_CHANGE_SCOPES.STEP,
        stepNumber,
        fields: ["removed"],
      });
    } else {
      const fields = changedFields(trustedList[index], currentList[index]);
      if (fields.length > 0) {
        changes.push({
          scope: RUN_DEFINITION_CHANGE_SCOPES.STEP,
          stepNumber,
          fields,
        });
      }
    }
  }

  const finalFields = changedFields(trustedFinal, currentFinal);
  if (finalFields.length > 0) {
    changes.push({
      scope: RUN_DEFINITION_CHANGE_SCOPES.FINAL_STEP,
      fields: finalFields,
    });
  }
  return changes;
}

function parseAnchor(raw: string): RunDefinitionAnchor | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.definitionHash !== "string" ||
    !isRecord(parsed.definition)
  ) {
    return undefined;
  }
  return parsed as unknown as RunDefinitionAnchor;
}

async function readAnchorAt(
  anchorPath: string
): Promise<RunDefinitionAnchor | undefined> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(anchorPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  // Anchors are replaced atomically, so an unparseable one was damaged by
  // something outside ctrlyoke. It proves nothing either way; the next write
  // replaces it.
  return parseAnchor(raw);
}

/** The anchor recorded for a working file, if it has one. */
export async function readRunDefinitionAnchor(
  workingFilePath: string
): Promise<RunDefinitionAnchor | undefined> {
  const anchorPath = definitionAnchorPath(workingFilePath);
  return anchorPath ? readAnchorAt(anchorPath) : undefined;
}

async function writeAnchorAt(
  anchorPath: string,
  anchor: RunDefinitionAnchor
): Promise<void> {
  await fs.promises.mkdir(path.dirname(anchorPath), { recursive: true });
  await writeFileAtomic(
    anchorPath,
    JSON.stringify(anchor),
    runStateWriteOptions(anchorPath, "RunDefinitionAnchor")
  );
}

/**
 * Remove the anchors of runs that were deleted for good: retention pruning, or
 * a purge of Recently deleted. A run in Recently deleted keeps its anchor so a
 * restore stays trusted, and a run whose directory exists again (restored, or
 * a live run under the same reference) keeps its own. With `includeDraft`,
 * the lineage's draft anchor goes too, and the lineage's anchor directory once
 * the lineage itself is gone.
 */
export async function removeRunDefinitionAnchors(
  stateRoot: string,
  workflowKey: WorkflowKey,
  runRefs: readonly RunRef[],
  options: { includeDraft?: boolean } = {}
): Promise<void> {
  const workingFiles = runRefs.map((runRef) => ({
    workingFilePath: WorkflowPaths.runFilePath(stateRoot, workflowKey, runRef),
    ownerDir: WorkflowPaths.runDir(stateRoot, workflowKey, runRef),
  }));
  if (options.includeDraft) {
    workingFiles.push({
      workingFilePath: WorkflowPaths.draftFilePath(stateRoot, workflowKey),
      ownerDir: WorkflowPaths.draftDir(stateRoot, workflowKey),
    });
  }
  let lineageAnchorDir: string | undefined;
  for (const { workingFilePath, ownerDir } of workingFiles) {
    const anchorPath = definitionAnchorPath(workingFilePath);
    if (!anchorPath) {
      continue;
    }
    lineageAnchorDir = path.dirname(anchorPath);
    if (fs.existsSync(ownerDir)) {
      continue;
    }
    await fs.promises.rm(anchorPath, { force: true });
  }
  if (
    options.includeDraft &&
    lineageAnchorDir &&
    !fs.existsSync(WorkflowPaths.lineageDir(stateRoot, workflowKey))
  ) {
    // Only an empty directory goes; anything left belongs to a live run.
    await fs.promises.rmdir(lineageAnchorDir).catch(() => undefined);
  }
}

function judge(
  anchor: RunDefinitionAnchor | undefined,
  workingFile: unknown
): RunDefinitionVerdict {
  if (!anchor) {
    return { status: RUN_DEFINITION_INTEGRITY.UNANCHORED };
  }
  // A newer ctrlyoke may anchor a different shape; this build cannot judge
  // it, and every write it would make is refused by the schema guard anyway.
  if (hasNewerSchema(PERSISTED_STORES.RUN_DEFINITION_ANCHOR, anchor)) {
    return { status: RUN_DEFINITION_INTEGRITY.TRUSTED, anchor };
  }
  const definition = extractRunDefinition(workingFile);
  const definitionHash = hashRunDefinition(definition);
  if (
    definitionHash === anchor.definitionHash ||
    definitionHash === anchor.previousDefinitionHash
  ) {
    return { status: RUN_DEFINITION_INTEGRITY.TRUSTED, anchor };
  }
  return {
    status: RUN_DEFINITION_INTEGRITY.CHANGED_OUTSIDE,
    anchor,
    definitionHash,
    changes: diffRunDefinitions(anchor.definition, definition),
  };
}

/** Compare an already-parsed working file with its anchor. */
export async function verifyRunDefinition(
  workingFilePath: string,
  workingFile: unknown
): Promise<RunDefinitionVerdict> {
  const anchorPath = definitionAnchorPath(workingFilePath);
  if (!anchorPath) {
    return { status: RUN_DEFINITION_INTEGRITY.UNANCHORABLE };
  }
  return judge(await readAnchorAt(anchorPath), workingFile);
}

/**
 * Read a working file and compare it with its anchor, without a lock.
 *
 * Writers record the anchor before replacing the file, so reading the file
 * first and the anchor second is consistent for one write in flight (the old
 * file still matches `previousDefinitionHash`). Two writes landing between the
 * two reads can still produce a false mismatch, so a mismatch is only believed
 * once it repeats on fresh reads; a real outside change always repeats.
 * Returns `undefined` when the file does not exist.
 */
export async function verifyRunDefinitionFile(
  workingFilePath: string
): Promise<
  { verdict: RunDefinitionVerdict; workingFile: WorkingFile } | undefined
> {
  const anchorPath = definitionAnchorPath(workingFilePath);
  let result:
    { verdict: RunDefinitionVerdict; workingFile: WorkingFile } | undefined;
  for (let attempt = 0; attempt < VERIFY_READ_ATTEMPTS; attempt++) {
    let raw: string;
    try {
      raw = await fs.promises.readFile(workingFilePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    const workingFile = JSON.parse(raw) as WorkingFile;
    const verdict: RunDefinitionVerdict = anchorPath
      ? judge(await readAnchorAt(anchorPath), workingFile)
      : { status: RUN_DEFINITION_INTEGRITY.UNANCHORABLE };
    result = { verdict, workingFile };
    if (verdict.status !== RUN_DEFINITION_INTEGRITY.CHANGED_OUTSIDE) {
      return result;
    }
  }
  return result;
}

/**
 * The trusted definition from `anchor`, carrying `current`'s runtime: the
 * workflow `_runtime` as is, and each step's `_runtime` by `stepId`. Fields an
 * outside writer added are dropped and fields it changed or removed come back.
 */
export function restoreTrustedRunDefinition(
  current: WorkingFile,
  anchor: RunDefinitionAnchor
): WorkingFile {
  const trusted = cloneJson(anchor.definition) as unknown as WorkingFile;
  const runtimeByStepId = new Map<string, WorkflowStep["_runtime"]>();
  for (const step of current.steps ?? []) {
    const stepId = step._runtime?.stepId;
    if (stepId !== undefined) {
      runtimeByStepId.set(stepId, step._runtime);
    }
  }
  const steps = (trusted.steps ?? []).map((step) => {
    const stepId = step._runtime?.stepId;
    const runtime =
      stepId === undefined ? undefined : runtimeByStepId.get(stepId);
    return runtime ? { ...step, _runtime: runtime } : step;
  });
  const finalStep =
    trusted.finalStep && current.finalStep?._runtime
      ? {
          ...trusted.finalStep,
          _runtime: {
            ...current.finalStep._runtime,
            ...trusted.finalStep._runtime,
          },
        }
      : trusted.finalStep;
  return {
    ...trusted,
    ...(trusted.steps ? { steps } : {}),
    ...(finalStep ? { finalStep } : {}),
    ...(current._runtime ? { _runtime: current._runtime } : {}),
  };
}

export interface AnchoredWriteOptions {
  /**
   * Replace the file even when its current definition was changed outside
   * ctrlyoke. Only for writers whose content does not derive from that
   * change: a restore, a user's accept, or the live queue (which reads through
   * the restoring reader).
   */
  overwriteChangedDefinition?: boolean;
  /** Set (string) or clear (`null`) the pending-rewind base; omitted keeps it. */
  rewindBaseHash?: string | null;
}

/**
 * Record the anchor for `workingFile` and then run `write`, which replaces the
 * working file with exactly that content. Callers hold the working-file lock.
 *
 * Refuses (with {@link RunDefinitionChangedError}) to replace a file whose
 * current definition changed outside ctrlyoke, unless the caller says its
 * content does not derive from that change. A file with no anchor yet (older
 * history) is trusted, so the write anchors it. If `write` fails, the previous
 * anchor is put back; otherwise the in-flight `previousDefinitionHash` is
 * dropped so a reverted outside edit can never pass as the old definition.
 */
export async function writeAnchoredRunDefinition(
  workingFilePath: string,
  workingFile: WorkingFile,
  write: () => Promise<void>,
  options: AnchoredWriteOptions = {}
): Promise<void> {
  const anchorPath = definitionAnchorPath(workingFilePath);
  if (!anchorPath) {
    await write();
    return;
  }

  const existing = await readAnchorAt(anchorPath);
  assertWritableSchema(
    PERSISTED_STORES.RUN_DEFINITION_ANCHOR,
    existing,
    anchorPath
  );
  if (existing && !options.overwriteChangedDefinition) {
    const current = await readJsonIfPresent(workingFilePath);
    if (current !== undefined) {
      const verdict = judge(existing, current);
      if (verdict.status === RUN_DEFINITION_INTEGRITY.CHANGED_OUTSIDE) {
        throw new RunDefinitionChangedError(workingFilePath, verdict.changes);
      }
    }
  }

  const definition = extractRunDefinition(workingFile);
  const definitionHash = hashRunDefinition(definition);
  const rewindBaseHash =
    options.rewindBaseHash === undefined
      ? existing?.rewindBaseHash
      : (options.rewindBaseHash ?? undefined);
  if (
    existing &&
    existing.definitionHash === definitionHash &&
    existing.rewindBaseHash === rewindBaseHash &&
    existing.previousDefinitionHash === undefined &&
    stepIdentityOf(existing.definition) === stepIdentityOf(definition)
  ) {
    // Runtime-only writes (most of them) leave the anchor alone.
    await write();
    return;
  }

  const anchor: RunDefinitionAnchor = {
    schemaVersion:
      CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.RUN_DEFINITION_ANCHOR],
    definitionRevision: workingFile.definitionRevision ?? 1,
    definitionHash,
    ...(existing && existing.definitionHash !== definitionHash
      ? { previousDefinitionHash: existing.definitionHash }
      : {}),
    ...(rewindBaseHash !== undefined ? { rewindBaseHash } : {}),
    recordedAt: Date.now(),
    definition,
  };
  await writeAnchorAt(anchorPath, anchor);
  try {
    await write();
  } catch (error) {
    await (
      existing
        ? writeAnchorAt(anchorPath, existing)
        : fs.promises.rm(anchorPath, { force: true })
    ).catch(() => undefined);
    throw error;
  }
  if (anchor.previousDefinitionHash !== undefined) {
    const { previousDefinitionHash: _settled, ...settled } = anchor;
    await writeAnchorAt(anchorPath, settled);
  }
}

/**
 * Anchor the definition currently on disk as trusted without rewriting the
 * file: a user accepting an outside change, or the first load of history that
 * predates anchors. Callers hold the working-file lock.
 */
export async function anchorRunDefinitionOnDisk(
  workingFilePath: string
): Promise<void> {
  const anchorPath = definitionAnchorPath(workingFilePath);
  if (!anchorPath) {
    return;
  }
  const current = await readJsonIfPresent(workingFilePath);
  if (current === undefined) {
    return;
  }
  const existing = await readAnchorAt(anchorPath);
  assertWritableSchema(
    PERSISTED_STORES.RUN_DEFINITION_ANCHOR,
    existing,
    anchorPath
  );
  const definition = extractRunDefinition(current);
  await writeAnchorAt(anchorPath, {
    schemaVersion:
      CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.RUN_DEFINITION_ANCHOR],
    definitionRevision: (current as WorkingFile).definitionRevision ?? 1,
    definitionHash: hashRunDefinition(definition),
    ...(existing?.rewindBaseHash !== undefined
      ? { rewindBaseHash: existing.rewindBaseHash }
      : {}),
    recordedAt: Date.now(),
    definition,
  });
}

/**
 * Throw unless `snapshot` is the pending-rewind base this run's anchor
 * recorded when the rewind began. The snapshot sits beside the run file, so
 * restoring it unchecked would trust whatever was written there. A rewind
 * begun before anchors existed has no recorded base and is accepted.
 */
export async function assertTrustedRewindBase(
  workingFilePath: string,
  snapshot: WorkingFile
): Promise<void> {
  const anchor = await readRunDefinitionAnchor(workingFilePath);
  if (!anchor?.rewindBaseHash) {
    return;
  }
  const definition = extractRunDefinition(snapshot);
  if (hashRunDefinition(definition) !== anchor.rewindBaseHash) {
    throw new RunDefinitionChangedError(
      workingFilePath,
      diffRunDefinitions(anchor.definition, definition)
    );
  }
}

/** Hash of the definition `workingFile` carries, as anchors record it. */
export function runDefinitionHashOf(workingFile: WorkingFile): string {
  return hashRunDefinition(extractRunDefinition(workingFile));
}

async function readJsonIfPresent(filePath: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // An unparseable file has no definition to launder; the write replaces it.
    return undefined;
  }
}
