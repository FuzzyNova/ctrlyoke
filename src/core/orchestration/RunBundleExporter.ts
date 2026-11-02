import * as crypto from "crypto";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  PromptFile,
  RunRef,
  WorkflowKey,
  WorkingFile,
  WorkflowStep,
} from "../../types/CtrlYokeTypes";
import { redactPreviewText } from "../../types/PreviewRedactor";
import {
  RUN_BUNDLE_FILES,
  RUN_BUNDLE_KIND,
  RUN_BUNDLE_REDACTION_POLICY,
  RUN_BUNDLE_SCHEMA_VERSION,
  RUN_BUNDLE_CONTINUATION_KINDS,
  RUN_BUNDLE_WORKTREE_MODES,
  RUN_IMPORT_SOURCE_KINDS,
  type RunBundleEvent,
  type RunBundleManifest,
  type RunBundleRunManifest,
  type RunBundleContinuation,
  type RunBundleStepProvenance,
} from "../../types/RunBundleTypes";
import {
  TIMELINE_EVENT_TYPES,
  type WorkflowTimelineEvent,
  type WorkflowTimelineEventType,
} from "../../types/WorkflowTimelineTypes";
import { renameWithTransientRetry } from "../../utils/AtomicFileUtils";
import {
  createPortablePathRewriter,
  isExternalAbsolutePath,
  mapJsonStrings,
} from "../../utils/RunBundlePaths";
import { RunSecretRedactor } from "../../utils/SecretRedactionService";
import {
  getDeclaredSecretGrants,
  MissingSecretError,
  resolveSecretValues,
  type SecretResolutionContext,
} from "../../utils/SecretResolver";
import {
  isActiveLock,
  readWorkflowLockInspection,
} from "../../utils/WorkflowLockInspector";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { buildAuthoredWorkflow } from "../WorkflowStepSanitizer";
import { TimelineRecorder } from "./TimelineRecorder";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import { analyzeWorkflowBundle } from "../../utils/WorkflowBundleAnalyzer";
import { writeWorkflowBundle } from "../../utils/WorkflowBundleWriter";
import {
  EXECUTION_STATES,
  FINAL_STEP_PHASES,
  WORKTREE_MODES,
} from "../../types/DashboardConstants";
import { execGit } from "../../utils/GitUtils";
import { assertRunHasWorkToContinue } from "./RunContinuationService";
import { getCliEntryKey } from "./OutputHistoryTimelineAdapter";

/**
 * Exports one settled run as a portable, redacted run bundle
 * (dev/backlog/RUN_EXPORT_PLAN.md §4). vscode-free, so the CLI and the
 * extension share it.
 *
 * Referenced generated attachments and prompt bodies are planned and copied
 * by the same analyzer/writer used by Save As.
 */

/** Events that carry workspace file contents; exported only on request (§9 Q4). */
const SNAPSHOT_EVENT_TYPES: ReadonlySet<WorkflowTimelineEventType> = new Set([
  TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_CAPTURED,
  TIMELINE_EVENT_TYPES.WORKSPACE_SNAPSHOT_UPDATED,
  TIMELINE_EVENT_TYPES.UNDO_APPLIED,
  TIMELINE_EVENT_TYPES.REDO_APPLIED,
  TIMELINE_EVENT_TYPES.UNDO_RECORD_UPDATED,
]);

/** Properties whose string values are file paths, for `externalPaths`. */
const PATH_VALUED_KEYS: ReadonlySet<string> = new Set([
  "path",
  "filePath",
  "file",
  "files",
  "workingDirectory",
  "cwd",
]);

export interface RunBundleExportOptions {
  /** The state root whose run storage holds the run (`WorkflowPaths.runsRoot`). */
  stateRoot: string;
  /** The workspace the run executed in; paths under it become portable. */
  workspaceRoot: string;
  workflowKey: WorkflowKey;
  runRef: RunRef;
  /** The bundle directory to create. */
  bundleDir: string;
  exportedByVersion: string;
  /** Keep workspace snapshot, undo and redo events (they carry file contents). */
  includeSnapshots?: boolean;
  /** Keep streaming text deltas instead of collapsing them into sealed output. */
  includeStreamDeltas?: boolean;
  /** Omit the workspace patch while retaining the runtime continuation state. */
  includeChanges?: boolean;
  /**
   * Where the run's declared secrets resolve. Their current values are
   * removed from the bundle along with the heuristic matches (§2.1).
   */
  secrets?: SecretResolutionContext;
  /** Paths under it become `~/...`. */
  homeDir?: string;
  /** Replace an existing bundle at `bundleDir`. */
  replace?: boolean;
  now?: () => Date;
}

export interface RunBundleExportResult {
  bundleDir: string;
  manifest: RunBundleManifest;
  eventCount: number;
  warnings: string[];
  continuable: boolean;
  continuation?: RunBundleContinuation;
  changedFiles: string[];
}

export class RunBundleExportError extends Error {}

interface ContinuationInfo {
  executionRoot: string;
  baseCommit: string;
  branch: string;
  worktreeMode: (typeof RUN_BUNDLE_WORKTREE_MODES)[keyof typeof RUN_BUNDLE_WORKTREE_MODES];
}

export interface RunBundleExportPreview {
  continuable: boolean;
  changedFiles: string[];
}

function assertExportableRun(workingFile: WorkingFile): void {
  if (workingFile._runtime?.pendingRewind) {
    throw new RunBundleExportError(
      "This run has a pending rewind. Commit or discard the rewind first."
    );
  }
  const state = workingFile._runtime?.executionState;
  if (
    state === EXECUTION_STATES.PAUSING ||
    state === EXECUTION_STATES.CANCELLING
  ) {
    throw new RunBundleExportError(
      `This run is ${state} and has not settled yet. Export it once it settles.`
    );
  }
}

async function getContinuationInfo(
  workingFile: WorkingFile,
  workspaceRoot: string
): Promise<ContinuationInfo | undefined> {
  const state = workingFile._runtime?.executionState;
  if (
    state !== EXECUTION_STATES.STOPPED &&
    state !== EXECUTION_STATES.PAUSED &&
    state !== EXECUTION_STATES.ERROR
  ) {
    return undefined;
  }
  try {
    assertRunHasWorkToContinue(state, false);
  } catch {
    return undefined;
  }
  const hasPendingWork = getPendingStepCount(workingFile) > 0;
  if (!hasPendingWork) return undefined;

  const worktree = workingFile._runtime?.worktree;
  const executionRoot = worktree?.executionRoot ?? workspaceRoot;
  const baseCommit =
    worktree?.baseCommit ??
    (
      await execGit(["rev-parse", "HEAD"], { cwd: executionRoot })
    ).stdout.trim();
  const branch =
    worktree?.branchName ??
    (
      await execGit(["branch", "--show-current"], { cwd: executionRoot })
    ).stdout.trim();
  return {
    executionRoot,
    baseCommit,
    branch,
    worktreeMode:
      worktree?.mode === WORKTREE_MODES.MANAGED
        ? RUN_BUNDLE_WORKTREE_MODES.MANAGED
        : worktree?.mode === WORKTREE_MODES.NAMED
          ? RUN_BUNDLE_WORKTREE_MODES.NAMED
          : RUN_BUNDLE_WORKTREE_MODES.NONE,
  };
}

/** Cheap dashboard preflight using the same continuation derivation as export. */
export async function getRunBundleExportPreview(
  stateRoot: string,
  workspaceRoot: string,
  workflowKey: WorkflowKey,
  runRef: RunRef
): Promise<RunBundleExportPreview> {
  const manifestPath = WorkflowPaths.manifestPath(
    stateRoot,
    workflowKey,
    runRef
  );
  await assertRunSettled({ stateRoot, workflowKey, runRef }, manifestPath);
  const workingFile = JSON.parse(
    await fs.promises.readFile(
      WorkflowPaths.runFilePath(stateRoot, workflowKey, runRef),
      "utf8"
    )
  ) as WorkingFile;
  assertExportableRun(workingFile);
  const continuation = await getContinuationInfo(workingFile, workspaceRoot);
  if (!continuation) return { continuable: false, changedFiles: [] };
  return {
    continuable: true,
    changedFiles: await collectWorkspaceChanges(
      continuation.executionRoot,
      continuation.baseCommit
    ).then((changes) => changes.files),
  };
}

async function collectWorkspaceChanges(
  executionRoot: string,
  baseCommit: string
): Promise<{ patchText: string; files: string[] }> {
  const indexPath = path.join(
    os.tmpdir(),
    `ctrlyoke-export-index-${randomUUID()}`
  );
  const env = { ...process.env, GIT_INDEX_FILE: indexPath };
  try {
    await execGit(["read-tree", baseCommit], { cwd: executionRoot, env });
    await execGit(["add", "-A"], { cwd: executionRoot, env });
    const [{ stdout: patchText }, { stdout: namesText }] = await Promise.all([
      execGit(["diff", "--cached", "--binary", "--full-index", baseCommit], {
        cwd: executionRoot,
        env,
        maxBuffer: 500 * 1024 * 1024,
      }),
      execGit(["diff", "--cached", "--name-only", "-z", baseCommit], {
        cwd: executionRoot,
        env,
        maxBuffer: 50 * 1024 * 1024,
      }),
    ]);
    return { patchText, files: namesText.split("\0").filter(Boolean) };
  } finally {
    await fs.promises.rm(indexPath, { force: true });
  }
}

function getPendingStepCount(workingFile: WorkingFile): number {
  const steps = workingFile.steps ?? [];
  const currentIndex = Math.min(
    workingFile._runtime?.currentIndex ?? 0,
    steps.length
  );
  return steps.length - currentIndex + (workingFile.finalStep ? 1 : 0);
}

function getNextStep(
  workingFile: WorkingFile
): RunBundleContinuation["nextStep"] {
  const currentIndex = Math.min(
    workingFile._runtime?.currentIndex ?? 0,
    (workingFile.steps ?? []).length
  );
  const runtimeFinalStep = workingFile._runtime?.finalStep;
  if (
    currentIndex >= (workingFile.steps ?? []).length &&
    (runtimeFinalStep?.phase === FINAL_STEP_PHASES.FINAL_STEP ||
      workingFile.finalStep)
  ) {
    return {
      kind: RUN_BUNDLE_CONTINUATION_KINDS.FINAL_STEP,
      pass: Math.max(1, (runtimeFinalStep?.loopCount ?? 0) + 1),
    };
  }
  return {
    kind: RUN_BUNDLE_CONTINUATION_KINDS.QUEUE,
    stepIndex: currentIndex,
  };
}

async function writeChangesPatch(
  options: RunBundleExportOptions,
  executionRoot: string,
  baseCommit: string,
  stagingDir: string,
  transform: BundleTransform
): Promise<{
  patch?: RunBundleContinuation["workspace"]["patch"];
  files: string[];
}> {
  if (options.includeChanges === false) return { files: [] };

  const { patchText, files } = await collectWorkspaceChanges(
    executionRoot,
    baseCommit
  );
  const transformedPatch = transform.redactText(
    patchText,
    RUN_BUNDLE_FILES.CHANGES
  );
  await fs.promises.writeFile(
    path.join(stagingDir, RUN_BUNDLE_FILES.CHANGES),
    transformedPatch,
    "utf8"
  );
  const binary = (
    transformedPatch.match(/^(?:GIT binary patch|Binary files .* differ)$/gm) ??
    []
  ).length;
  return {
    patch: {
      file: RUN_BUNDLE_FILES.CHANGES,
      sha256: crypto
        .createHash("sha256")
        .update(transformedPatch)
        .digest("hex"),
      files: files.length,
      binary,
    },
    files,
  };
}

export async function exportRunBundle(
  options: RunBundleExportOptions
): Promise<RunBundleExportResult> {
  const { stateRoot, workflowKey, runRef } = options;
  const manifestPath = WorkflowPaths.manifestPath(
    stateRoot,
    workflowKey,
    runRef
  );
  await assertRunSettled(options, manifestPath);

  const recorder = new TimelineRecorder();
  const runManifest = await recorder.readManifest(manifestPath);
  const workingFile = JSON.parse(
    await fs.promises.readFile(
      WorkflowPaths.runFilePath(stateRoot, workflowKey, runRef),
      "utf8"
    )
  ) as WorkingFile;
  assertExportableRun(workingFile);
  const descriptor = await new WorkflowLineageRepository().readDescriptor(
    stateRoot,
    workflowKey
  );

  const exactSecrets = options.secrets
    ? await resolveRunBundleSecrets(workingFile, options.secrets)
    : [];
  const worktree = workingFile._runtime?.worktree;
  const workspaceRoots = [
    options.workspaceRoot,
    worktree?.executionRoot,
    worktree?.executionCheckoutRoot,
    worktree?.worktreePath,
    worktree?.sourceCheckoutRoot,
    ...(worktree?.namedWorkspaceRoots.map((root) => root.fsPath) ?? []),
  ].filter((root): root is string => !!root);
  const transform = createBundleTransform(
    options,
    exactSecrets,
    workspaceRoots
  );
  const continuationInfo = await getContinuationInfo(
    workingFile,
    options.workspaceRoot
  );
  const bundleDir = path.resolve(options.bundleDir);
  const stagingDir = path.join(
    path.dirname(bundleDir),
    `.${path.basename(bundleDir)}.staging-${randomUUID()}`
  );
  await fs.promises.mkdir(stagingDir, { recursive: true });
  try {
    const collapsedDeltas =
      options.includeStreamDeltas === true
        ? new Set<number>()
        : await findSupersededChunkSequences(
            recorder.streamEvents(manifestPath)
          );
    const eventCount = await writeEvents(
      recorder.streamEvents(manifestPath),
      path.join(stagingDir, RUN_BUNDLE_FILES.EVENTS),
      transform,
      options.includeSnapshots === true,
      collapsedDeltas,
      options.includeStreamDeltas === true
    );
    const { workflowId: _workflowId, runId, ...portableManifest } = runManifest;
    portableManifest.eventCount = eventCount;
    await writeJson(
      path.join(stagingDir, RUN_BUNDLE_FILES.MANIFEST),
      transform.apply<RunBundleRunManifest>(
        portableManifest,
        RUN_BUNDLE_FILES.MANIFEST
      )
    );
    const authoredWorkflow = buildAuthoredWorkflow(
      workingFile,
      descriptor.workflowName
    ) as Record<string, unknown>;
    const definitionPath = path.join(stagingDir, RUN_BUNDLE_FILES.DEFINITION);
    const analysis = await analyzeWorkflowBundle(authoredWorkflow, {
      workspaceRoot: options.workspaceRoot,
      trustedRoots: [
        ...new Set([options.workspaceRoot, options.stateRoot, stagingDir]),
      ],
      ...(descriptor.originalFile && path.isAbsolute(descriptor.originalFile)
        ? { sourceDefinitionPath: descriptor.originalFile }
        : {}),
      destinationPath: definitionPath,
      assetsDirectory: path.join(stagingDir, RUN_BUNDLE_FILES.ASSETS_DIR),
      missingGeneratedReferencesAreWarnings: true,
    });
    const writeResult = await writeWorkflowBundle({
      workflowPath: definitionPath,
      serializedWorkflow: `${JSON.stringify(
        transform.apply(analysis.workflow, RUN_BUNDLE_FILES.DEFINITION),
        null,
        2
      )}\n`,
      plan: { ...analysis.plan, blockers: [] },
      stagingDirectory: stagingDir,
      publishManifest: false,
      transformCopy: (content, copy) =>
        redactAssetContent(
          content,
          transform,
          copy.relativePath.replace(/^\.\//, "").replace(/\\/g, "/")
        ),
    });
    let continuation: RunBundleContinuation | undefined;
    let changedFiles: string[] = [];
    if (continuationInfo) {
      await writeJson(
        path.join(stagingDir, RUN_BUNDLE_FILES.RUNTIME),
        transform.apply(workingFile, RUN_BUNDLE_FILES.RUNTIME)
      );
      const patchResult = await writeChangesPatch(
        options,
        continuationInfo.executionRoot,
        continuationInfo.baseCommit,
        stagingDir,
        transform
      );
      changedFiles = patchResult.files;
      continuation = {
        executionState: workingFile._runtime!.executionState,
        nextStep: getNextStep(workingFile),
        pendingStepCount: getPendingStepCount(workingFile),
        worktreeMode: continuationInfo.worktreeMode,
        workspace: {
          baseCommit: continuationInfo.baseCommit,
          branch: continuationInfo.branch,
          ...(patchResult.patch ? { patch: patchResult.patch } : {}),
        },
      };
    }
    const warnings = [
      ...analysis.plan.blockers.map((blocker) => blocker.message),
      ...analysis.plan.warnings.map((warning) => warning.message),
      ...writeResult.warnings,
    ];
    const importedFrom =
      workingFile._runtime?.importedFrom ??
      (descriptor.importedFrom?.kind === RUN_IMPORT_SOURCE_KINDS.RUN_BUNDLE
        ? {
            provenance: descriptor.importedFrom.provenance,
            sourceRoot: descriptor.importedFrom.sourceRoot,
            exportedAt: descriptor.importedFrom.exportedAt,
            exportedByVersion: descriptor.importedFrom.exportedByVersion,
          }
        : undefined);
    const bundleManifest: RunBundleManifest = {
      schemaVersion: RUN_BUNDLE_SCHEMA_VERSION,
      kind: RUN_BUNDLE_KIND,
      exportedAt: (options.now?.() ?? new Date()).toISOString(),
      exportedByVersion: options.exportedByVersion,
      // Only the home rewrite: the reader should see which checkout this was.
      sourceRoot: createPortablePathRewriter({ homeDir: options.homeDir })(
        options.workspaceRoot
      ),
      lineage: transform.apply(
        {
          workflowName: descriptor.workflowName,
          ...(descriptor.originalFile
            ? { originalFile: descriptor.originalFile }
            : {}),
        },
        RUN_BUNDLE_FILES.BUNDLE
      ),
      provenance: {
        workflowKey,
        runRef,
        runId,
        steps: collectStepProvenance(workingFile),
      },
      ...(importedFrom ? { importedFrom } : {}),
      includesSnapshots: options.includeSnapshots === true,
      includesStreamDeltas: options.includeStreamDeltas === true,
      redaction: {
        policy: RUN_BUNDLE_REDACTION_POLICY,
        removedCount: transform.removedCount(),
        byRule: transform.removedByRule(),
        byFile: transform.removedByFile(),
      },
      externalPaths: transform.externalPaths(),
      ...(writeResult.files.length > 0 ? { assets: writeResult.files } : {}),
      ...(continuation ? { continuation } : {}),
    };
    await writeJson(
      path.join(stagingDir, RUN_BUNDLE_FILES.BUNDLE),
      bundleManifest
    );
    await publishStagedBundle(stagingDir, bundleDir, options.replace === true);
    return {
      bundleDir,
      manifest: bundleManifest,
      eventCount,
      warnings,
      continuable: continuation !== undefined,
      ...(continuation ? { continuation } : {}),
      changedFiles,
    };
  } catch (error) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

/** Redact UTF-8 text assets; binary attachment bytes remain byte-for-byte. */
function redactAssetContent(
  content: Buffer,
  transform: BundleTransform,
  fileName: string
): Buffer {
  if (content.includes(0)) return content;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    return Buffer.from(transform.redactText(text, fileName), "utf8");
  } catch {
    return content;
  }
}

/** A run still being written has no stable `eventCount` (§4 step 1). */
async function assertRunSettled(
  options: Pick<RunBundleExportOptions, "stateRoot" | "workflowKey" | "runRef">,
  manifestPath: string
): Promise<void> {
  if (!fs.existsSync(manifestPath)) {
    throw new RunBundleExportError(
      `Run ${options.runRef} of ${options.workflowKey} has no timeline to export.`
    );
  }
  const lock = await readWorkflowLockInspection(
    options.stateRoot,
    options.workflowKey
  );
  if (isActiveLock(lock) && lock.lock.runRef === options.runRef) {
    throw new RunBundleExportError(
      `Run ${options.runRef} of ${options.workflowKey} is still executing. Export it once it finishes.`
    );
  }
}

interface BundleTransform {
  apply<T>(value: T, fileName: string): T;
  redactText(text: string, fileName: string): string;
  removedCount(): number;
  removedByRule(): Record<string, number>;
  removedByFile(): Record<string, number>;
  externalPaths(): string[];
}

/** Path rewrite, then redaction (§4 steps 4-5), over every string in a value. */
function createBundleTransform(
  options: RunBundleExportOptions,
  exactSecrets: readonly string[],
  workspaceRoots: readonly string[]
): BundleTransform {
  const rewrite = createPortablePathRewriter({
    workspaceRoots,
    homeDir: options.homeDir,
  });
  const byRule: Record<string, number> = {};
  const byFile: Record<string, number> = {};
  const external = new Set<string>();

  let activeFileName: string | undefined;
  const redact = (text: string): string => {
    const redacted = redactPreviewText(text, [], exactSecrets);
    for (const span of redacted.spans) {
      byRule[span.ruleId] = (byRule[span.ruleId] ?? 0) + 1;
      if (activeFileName) {
        byFile[activeFileName] = (byFile[activeFileName] ?? 0) + 1;
      }
    }
    return redacted.text;
  };
  const transformString = (text: string, key: string | undefined): string => {
    const redacted = redact(rewrite(text));
    if (
      key !== undefined &&
      PATH_VALUED_KEYS.has(key) &&
      isExternalAbsolutePath(redacted)
    ) {
      external.add(redacted);
    }
    return redacted;
  };

  return {
    apply: (value, fileName) => {
      activeFileName = fileName;
      try {
        return mapJsonStrings(value, transformString);
      } finally {
        activeFileName = undefined;
      }
    },
    redactText: (text, fileName) => {
      activeFileName = fileName;
      try {
        return redact(rewrite(text));
      } finally {
        activeFileName = undefined;
      }
    },
    removedCount: () =>
      Object.values(byRule).reduce((sum, count) => sum + count, 0),
    removedByRule: () => ({ ...byRule }),
    removedByFile: () => ({ ...byFile }),
    externalPaths: () => [...external].sort(),
  };
}

async function writeEvents(
  events: AsyncIterable<WorkflowTimelineEvent>,
  eventsPath: string,
  transform: BundleTransform,
  includeSnapshots: boolean,
  collapsedDeltas: ReadonlySet<number>,
  includeStreamDeltas: boolean
): Promise<number> {
  const handle = await fs.promises.open(eventsPath, "w");
  let count = 0;
  let pendingChunk:
    | Extract<
        WorkflowTimelineEvent,
        { eventType: typeof TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED }
      >
    | undefined;
  try {
    const flushChunk = async (): Promise<void> => {
      if (!pendingChunk) return;
      const {
        workflowId: _workflowId,
        runId: _runId,
        ...portable
      } = pendingChunk;
      const bundleEvent = transform.apply(
        portable as RunBundleEvent,
        RUN_BUNDLE_FILES.EVENTS
      );
      await handle.write(`${JSON.stringify(bundleEvent)}\n`);
      count += 1;
      pendingChunk = undefined;
    };
    for await (const event of events) {
      if (!includeSnapshots && SNAPSHOT_EVENT_TYPES.has(event.eventType)) {
        await flushChunk();
        continue;
      }
      if (event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED) {
        if (collapsedDeltas.has(event.sequence)) {
          await flushChunk();
          continue;
        }
        const key = getCliEntryKey(
          event.target,
          event.runIndex ?? 0,
          event.attemptIndex,
          event.phase
        );
        if (
          !includeStreamDeltas &&
          pendingChunk &&
          getCliEntryKey(
            pendingChunk.target,
            pendingChunk.runIndex ?? 0,
            pendingChunk.attemptIndex,
            pendingChunk.phase
          ) === key
        ) {
          pendingChunk = {
            ...pendingChunk,
            payload: {
              chunk: pendingChunk.payload.chunk + event.payload.chunk,
            },
          };
        } else {
          await flushChunk();
          pendingChunk = event;
        }
        continue;
      }
      await flushChunk();
      const { workflowId: _workflowId, runId: _runId, ...portable } = event;
      const bundleEvent = transform.apply(
        portable as RunBundleEvent,
        RUN_BUNDLE_FILES.EVENTS
      );
      await handle.write(`${JSON.stringify(bundleEvent)}\n`);
      count += 1;
    }
    await flushChunk();
    await handle.sync();
  } finally {
    await handle.close();
  }
  return count;
}

/**
 * Find chunks in streaming intervals that a later sealed aggregate replaces.
 * Only stores sequence numbers, so both passes remain bounded by event count
 * metadata rather than event payload size.
 */
async function findSupersededChunkSequences(
  events: AsyncIterable<WorkflowTimelineEvent>
): Promise<Set<number>> {
  const openChunks = new Map<string, number[]>();
  const superseded = new Set<number>();
  for await (const event of events) {
    if (event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED) {
      const key = getCliEntryKey(
        event.target,
        event.runIndex ?? 0,
        event.attemptIndex,
        event.phase
      );
      if (event.payload.cliOutput.isStreaming) {
        if (!openChunks.has(key)) openChunks.set(key, []);
      } else {
        for (const sequence of openChunks.get(key) ?? [])
          superseded.add(sequence);
        openChunks.delete(key);
      }
    } else if (
      event.eventType === TIMELINE_EVENT_TYPES.CLI_OUTPUT_CHUNK_APPENDED
    ) {
      const key = getCliEntryKey(
        event.target,
        event.runIndex ?? 0,
        event.attemptIndex,
        event.phase
      );
      openChunks.get(key)?.push(event.sequence);
    }
  }
  return superseded;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const handle = await fs.promises.open(filePath, "w");
  try {
    await handle.write(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Moves the finished staging directory into place (§4 step 6). */
async function publishStagedBundle(
  stagingDir: string,
  bundleDir: string,
  replace: boolean
): Promise<void> {
  if (!fs.existsSync(bundleDir)) {
    await renameWithTransientRetry(stagingDir, bundleDir);
    return;
  }
  if (!replace) {
    throw new RunBundleExportError(
      `${bundleDir} already exists. Pass --force to replace it.`
    );
  }
  const retired = `${stagingDir}.replaced`;
  await renameWithTransientRetry(bundleDir, retired);
  await renameWithTransientRetry(stagingDir, bundleDir);
  await fs.promises.rm(retired, { recursive: true, force: true });
}

function collectStepProvenance(
  workingFile: WorkingFile
): RunBundleStepProvenance[] {
  return (workingFile.steps ?? []).flatMap((step, stepIndex) => {
    const runtime = (
      step as WorkflowStep & {
        _runtime?: { harness?: string; model?: string; sessionId?: string };
      }
    )._runtime;
    if (!runtime?.harness && !runtime?.sessionId) return [];
    return [
      {
        stepIndex,
        ...(runtime.harness ? { harness: runtime.harness } : {}),
        ...(runtime.model ? { model: runtime.model } : {}),
        ...(runtime.sessionId ? { sessionId: runtime.sessionId } : {}),
      },
    ];
  });
}

/**
 * Re-resolves every secret the run's definition grants, so the export can
 * remove values the harness printed (§2.1). A run's own redactor is gone once
 * it finishes. A grant with no value on this machine is skipped: there is
 * nothing to match.
 */
export async function resolveRunBundleSecrets(
  definition: PromptFile,
  context: SecretResolutionContext
): Promise<string[]> {
  const steps = [
    ...(definition.steps ?? []),
    ...(definition.finalStep ? [definition.finalStep] : []),
  ];
  const names = new Set(
    steps.flatMap((step) => getDeclaredSecretGrants(step, definition))
  );
  const redactor = new RunSecretRedactor();
  for (const name of names) {
    try {
      const resolved = await resolveSecretValues([name], context);
      redactor.addResolvedValues({ [name]: resolved[name].value });
    } catch (error) {
      if (!(error instanceof MissingSecretError)) throw error;
    }
  }
  return [...redactor.getExactSecrets()];
}
