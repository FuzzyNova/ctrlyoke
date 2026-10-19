import { randomUUID } from "crypto";
import * as fs from "fs";
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
  type RunBundleEvent,
  type RunBundleManifest,
  type RunBundleRunManifest,
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

/**
 * Exports one finished run as a portable, redacted run bundle
 * (dev/backlog/RUN_EXPORT_PLAN.md §4). vscode-free, so the CLI and the
 * extension share it.
 *
 * Not yet covered from §4: bundling referenced attachments and prompt bodies
 * (step 3), which the Save As machinery will provide.
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
}

export class RunBundleExportError extends Error {}

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
  const descriptor = await new WorkflowLineageRepository().readDescriptor(
    stateRoot,
    workflowKey
  );

  const exactSecrets = options.secrets
    ? await resolveRunBundleSecrets(workingFile, options.secrets)
    : [];
  const transform = createBundleTransform(options, exactSecrets);
  const bundleDir = path.resolve(options.bundleDir);
  const stagingDir = path.join(
    path.dirname(bundleDir),
    `.${path.basename(bundleDir)}.staging-${randomUUID()}`
  );
  await fs.promises.mkdir(stagingDir, { recursive: true });
  try {
    const eventCount = await writeEvents(
      recorder.streamEvents(manifestPath),
      path.join(stagingDir, RUN_BUNDLE_FILES.EVENTS),
      transform,
      options.includeSnapshots === true
    );
    const { workflowId: _workflowId, runId, ...portableManifest } = runManifest;
    await writeJson(
      path.join(stagingDir, RUN_BUNDLE_FILES.MANIFEST),
      transform.apply<RunBundleRunManifest>(portableManifest)
    );
    await writeJson(
      path.join(stagingDir, RUN_BUNDLE_FILES.DEFINITION),
      transform.apply(buildAuthoredWorkflow(workingFile))
    );
    const bundleManifest: RunBundleManifest = {
      schemaVersion: RUN_BUNDLE_SCHEMA_VERSION,
      kind: RUN_BUNDLE_KIND,
      exportedAt: (options.now?.() ?? new Date()).toISOString(),
      exportedByVersion: options.exportedByVersion,
      // Only the home rewrite: the reader should see which checkout this was.
      sourceRoot: createPortablePathRewriter({ homeDir: options.homeDir })(
        options.workspaceRoot
      ),
      lineage: transform.apply({
        workflowName: descriptor.workflowName,
        ...(descriptor.originalFile
          ? { originalFile: descriptor.originalFile }
          : {}),
      }),
      provenance: {
        workflowKey,
        runRef,
        runId,
        steps: collectStepProvenance(workingFile),
      },
      includesSnapshots: options.includeSnapshots === true,
      redaction: {
        policy: RUN_BUNDLE_REDACTION_POLICY,
        removedCount: transform.removedCount(),
        byRule: transform.removedByRule(),
      },
      externalPaths: transform.externalPaths(),
    };
    await writeJson(
      path.join(stagingDir, RUN_BUNDLE_FILES.BUNDLE),
      bundleManifest
    );
    await publishStagedBundle(stagingDir, bundleDir, options.replace === true);
    return { bundleDir, manifest: bundleManifest, eventCount };
  } catch (error) {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

/** A run still being written has no stable `eventCount` (§4 step 1). */
async function assertRunSettled(
  options: RunBundleExportOptions,
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
  apply<T>(value: T): T;
  removedCount(): number;
  removedByRule(): Record<string, number>;
  externalPaths(): string[];
}

/** Path rewrite, then redaction (§4 steps 4-5), over every string in a value. */
function createBundleTransform(
  options: RunBundleExportOptions,
  exactSecrets: readonly string[]
): BundleTransform {
  const rewrite = createPortablePathRewriter({
    workspaceRoot: options.workspaceRoot,
    homeDir: options.homeDir,
  });
  const byRule: Record<string, number> = {};
  const external = new Set<string>();

  const transformString = (text: string, key: string | undefined): string => {
    const rewritten = rewrite(text);
    const redacted = redactPreviewText(rewritten, [], exactSecrets);
    for (const span of redacted.spans) {
      byRule[span.ruleId] = (byRule[span.ruleId] ?? 0) + 1;
    }
    if (
      key !== undefined &&
      PATH_VALUED_KEYS.has(key) &&
      isExternalAbsolutePath(redacted.text)
    ) {
      external.add(redacted.text);
    }
    return redacted.text;
  };

  return {
    apply: (value) => mapJsonStrings(value, transformString),
    removedCount: () =>
      Object.values(byRule).reduce((sum, count) => sum + count, 0),
    removedByRule: () => ({ ...byRule }),
    externalPaths: () => [...external].sort(),
  };
}

async function writeEvents(
  events: AsyncIterable<WorkflowTimelineEvent>,
  eventsPath: string,
  transform: BundleTransform,
  includeSnapshots: boolean
): Promise<number> {
  const handle = await fs.promises.open(eventsPath, "w");
  let count = 0;
  try {
    for await (const event of events) {
      if (!includeSnapshots && SNAPSHOT_EVENT_TYPES.has(event.eventType))
        continue;
      const { workflowId: _workflowId, runId: _runId, ...portable } = event;
      const bundleEvent = transform.apply(portable as RunBundleEvent);
      await handle.write(`${JSON.stringify(bundleEvent)}\n`);
      count += 1;
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  return count;
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
