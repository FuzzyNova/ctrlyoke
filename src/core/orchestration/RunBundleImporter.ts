import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { writeFileAtomic } from "../../utils/AtomicFileUtils";
import type {
  RunRef,
  WorkflowKey,
  WorkflowLineageDescriptor,
} from "../../types/CtrlYokeTypes";
import type { WorkflowTimelineEventDraft } from "../../types/WorkflowTimelineTypes";
import {
  defaultRunChangesTarget,
  RUN_BUNDLE_FILES,
  RUN_CHANGES_TARGETS,
  RUN_IMPORT_SOURCE_KINDS,
  RUN_IMPORT_STATUSES,
  type RunBundleEvent,
  type RunBundleManifest,
} from "../../types/RunBundleTypes";
import {
  isPathWithinDirectory,
  isSafePathSegment,
} from "../../utils/PathSecurity";
import { mapJsonStrings } from "../../utils/RunBundlePaths";
import {
  readRunBundleHeader,
  streamRunBundleEvents,
  type ReadRunBundleOptions,
} from "./RunBundleReader";
import { RunMaterializer } from "./RunMaterializer";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import { EXECUTION_STATES } from "../../types/DashboardConstants";
import {
  RunChangesPlacer,
  type RunChangesTarget,
  type RunChangesPlacement,
} from "./RunChangesPlacer";
import type { WorkingFileRuntime } from "../../types/CtrlYokeTypes";

export interface RunBundleImportOptions extends ReadRunBundleOptions {
  workspaceRoot: string;
  bundleDir: string;
  again?: boolean;
  name?: string;
  changes?: RunChangesTarget;
}

export type RunBundleImportResult =
  | {
      status: typeof RUN_IMPORT_STATUSES.IMPORTED;
      workflowKey: WorkflowKey;
      runRef: RunRef;
      placement?: RunChangesPlacement;
    }
  | {
      status: typeof RUN_IMPORT_STATUSES.ALREADY_IMPORTED;
      workflowKey: WorkflowKey;
    };

/**
 * The lineage an earlier import of this same bundle created, if any (open
 * question 5): matched on the exported run's identity, `sourceRoot` and
 * `exportedAt`. Shared by the importer and `RunImportPreview`.
 */
export async function findExistingBundleImport(
  repository: Pick<
    WorkflowLineageRepository,
    "listLineageKeys" | "tryReadDescriptor"
  >,
  workspaceRoot: string,
  manifest: RunBundleManifest
): Promise<{ workflowKey: WorkflowKey; runRef?: RunRef } | undefined> {
  for (const workflowKey of await repository.listLineageKeys(workspaceRoot)) {
    const descriptor = await repository.tryReadDescriptor(
      workspaceRoot,
      workflowKey
    );
    const imported = descriptor?.importedFrom;
    if (
      imported?.kind === RUN_IMPORT_SOURCE_KINDS.RUN_BUNDLE &&
      imported.provenance.workflowKey === manifest.provenance.workflowKey &&
      imported.provenance.runRef === manifest.provenance.runRef &&
      imported.sourceRoot === manifest.sourceRoot &&
      imported.exportedAt === manifest.exportedAt
    ) {
      return {
        workflowKey,
        ...(descriptor?.latestRunRef
          ? { runRef: descriptor.latestRunRef }
          : {}),
      };
    }
  }
  return undefined;
}

export class RunBundleImporter {
  constructor(
    private readonly materializer = new RunMaterializer(),
    private readonly lineageRepository = new WorkflowLineageRepository(),
    private readonly changesPlacer = new RunChangesPlacer()
  ) {}

  async importRun(
    options: RunBundleImportOptions
  ): Promise<RunBundleImportResult> {
    const header = await readRunBundleHeader(
      options.bundleDir,
      options.workspaceRoot,
      options
    );
    const provenance: NonNullable<WorkflowLineageDescriptor["importedFrom"]> = {
      kind: RUN_IMPORT_SOURCE_KINDS.RUN_BUNDLE,
      provenance: header.manifest.provenance,
      sourceRoot: header.manifest.sourceRoot,
      exportedAt: header.manifest.exportedAt,
      exportedByVersion: header.manifest.exportedByVersion,
      bundleName: path.basename(path.resolve(options.bundleDir)),
    };
    if (!options.again) {
      const existing = await findExistingBundleImport(
        this.lineageRepository,
        options.workspaceRoot,
        header.manifest
      );
      if (existing) {
        return {
          status: RUN_IMPORT_STATUSES.ALREADY_IMPORTED,
          workflowKey: existing.workflowKey,
        };
      }
    }

    // Complete a validation pass before copying assets or allocating a lineage.
    for await (const _event of streamRunBundleEvents(header, options)) {
      /* validate */
    }
    const definition = await this.copyAssetsAndRewriteDefinition(
      header.bundleDir,
      options.workspaceRoot,
      header.manifest.assets ?? [],
      header.definition
    );
    let executionRoot = options.workspaceRoot;
    let placement: RunChangesPlacement | undefined;
    async function* drafts() {
      for await (const event of streamRunBundleEvents(header, options)) {
        const { sequence: _sequence, ...draft } = event as RunBundleEvent & {
          sequence?: number;
        };
        const rewriteWorkingDirectories = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(rewriteWorkingDirectories);
          if (!value || typeof value !== "object") return value;
          return Object.fromEntries(
            Object.entries(value).map(([key, child]) => [
              key,
              key === "workingDirectory"
                ? executionRoot
                : rewriteWorkingDirectories(child),
            ])
          );
        };
        yield rewriteWorkingDirectories(draft) as WorkflowTimelineEventDraft;
      }
    }
    const materialized = await this.materializer.materialize({
      workspaceRoot: options.workspaceRoot,
      workflowName:
        options.name?.trim() || header.manifest.lineage.workflowName,
      definition,
      events: drafts(),
      executionState: header.manifest.continuation
        ? EXECUTION_STATES.STOPPED
        : header.runManifest.executionState,
      currentIndex: (definition.steps as unknown[] | undefined)?.length ?? 0,
      startedAt: header.runManifest.startedAt,
      provenance,
      ...(header.manifest.continuation
        ? {
            beforeEvents: async ({ workflowKey, runRef }) => {
              const continuation = header.manifest.continuation!;
              const target =
                options.changes ??
                defaultRunChangesTarget(continuation.worktreeMode);
              const patchPath = continuation.workspace.patch
                ? path.join(header.bundleDir, RUN_BUNDLE_FILES.CHANGES)
                : undefined;
              placement = await this.changesPlacer.place({
                workspaceRoot: options.workspaceRoot,
                patchPath,
                baseCommit: continuation.workspace.baseCommit,
                target,
                worktreeMode: continuation.worktreeMode,
                workflowKey,
                runRef,
                workflowName:
                  options.name?.trim() || header.manifest.lineage.workflowName,
              });
              if (placement.worktreeRuntime) {
                // Imported outputs record the new worktree as their
                // working directory, never the bundle's or the checkout (§5.5).
                executionRoot = placement.worktreePath ?? executionRoot;
                const normalized = normalizeImportedRuntime(
                  header.runtime,
                  header.manifest,
                  header.runManifest
                );
                return {
                  runtimeState: {
                    ...normalized,
                    worktree: placement.worktreeRuntime,
                  },
                };
              }
              if (
                placement.canContinue === false ||
                (!placement.applied && target !== RUN_CHANGES_TARGETS.SKIP)
              )
                return { runtimeState: undefined };
              executionRoot = placement.worktreePath ?? options.workspaceRoot;
              return {
                runtimeState: normalizeImportedRuntime(
                  header.runtime,
                  header.manifest,
                  header.runManifest
                ),
              };
            },
          }
        : {}),
    });
    return {
      status: RUN_IMPORT_STATUSES.IMPORTED,
      workflowKey: materialized.workflowKey,
      runRef: materialized.runRef,
      ...(placement ? { placement } : {}),
    };
  }

  private async copyAssetsAndRewriteDefinition(
    bundleDir: string,
    workspaceRoot: string,
    assets: NonNullable<
      import("../../types/RunBundleTypes").RunBundleManifest["assets"]
    >,
    definition: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const replacements = new Map<string, string>();
    const realWorkspace = await fs.promises.realpath(workspaceRoot);
    for (const asset of assets) {
      const segments = asset.path.split("/");
      if (segments.some((segment) => !isSafePathSegment(segment))) {
        throw new Error(`Invalid bundled asset path: ${asset.path}`);
      }
      const bundleSegments =
        segments[0] === RUN_BUNDLE_FILES.ASSETS_DIR
          ? segments.slice(1)
          : segments;
      const isPrompt = bundleSegments[0] === "prompts";
      const relative = isPrompt
        ? bundleSegments.slice(1)
        : bundleSegments[0] === "attachments"
          ? bundleSegments.slice(1)
          : bundleSegments;
      if (!relative.length)
        throw new Error(`Invalid bundled asset path: ${asset.path}`);
      const store = path.join(
        realWorkspace,
        ".ctrlyoke",
        isPrompt ? "prompts" : "attachments"
      );
      await fs.promises.mkdir(store, { recursive: true });
      const realStore = await fs.promises.realpath(store);
      if (!isPathWithinDirectory(realStore, realWorkspace))
        throw new Error("Asset store escapes the importing workspace.");
      let destination = path.resolve(realStore, ...relative);
      if (!isPathWithinDirectory(destination, realStore))
        throw new Error(`Asset path escapes its store: ${asset.path}`);
      await fs.promises.mkdir(path.dirname(destination), { recursive: true });
      const realParent = await fs.promises.realpath(path.dirname(destination));
      if (!isPathWithinDirectory(realParent, realStore))
        throw new Error(`Asset destination escapes its store: ${asset.path}`);
      const source = path.resolve(bundleDir, ...segments);
      const realBundle = await fs.promises.realpath(bundleDir);
      const realSource = await fs.promises.realpath(source);
      if (!isPathWithinDirectory(realSource, realBundle))
        throw new Error(`Bundled asset escapes its bundle: ${asset.path}`);
      const content = await fs.promises.readFile(realSource);
      try {
        const existingStat = await fs.promises.lstat(destination);
        if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
          throw new Error(
            `Asset destination is not a regular file: ${destination}`
          );
        }
        const existing = await fs.promises.readFile(destination);
        if (!existing.equals(content)) {
          const extension = path.extname(destination);
          const stem = path.basename(destination, extension);
          destination = path.join(
            path.dirname(destination),
            `${stem}-${crypto.createHash("sha256").update(content).digest("hex").slice(0, 12)}${extension}`
          );
          if (!isPathWithinDirectory(destination, realStore))
            throw new Error(`Asset path escapes its store: ${asset.path}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await writeFileAtomic(destination, content);
      replacements.set(
        `${RUN_BUNDLE_FILES.ASSETS_DIR}/${asset.path}`,
        destination
      );
      replacements.set(asset.path, destination);
    }
    const workspaceDefinition = mapJsonStrings(definition, (value) => {
      let rewritten = value;
      for (const [from, to] of replacements)
        rewritten = rewritten.split(from).join(to);
      return rewritten;
    });
    return workspaceDefinition;
  }
}

function normalizeImportedRuntime(
  runtime: Record<string, unknown> | undefined,
  manifest: import("../../types/RunBundleTypes").RunBundleManifest,
  runManifest: import("../../types/RunBundleTypes").RunBundleRunManifest
): Partial<WorkingFileRuntime> {
  const normalized: Record<string, unknown> = { ...(runtime ?? {}) };
  delete normalized.worktree;
  delete normalized.stopReason;
  delete normalized.worktreeNotice;
  delete normalized.pendingRewind;
  normalized.executionState = EXECUTION_STATES.STOPPED;
  normalized.currentIndex =
    typeof normalized.currentIndex === "number"
      ? normalized.currentIndex
      : Array.isArray(normalized.steps)
        ? normalized.steps.length
        : runManifest.stepCount;
  normalized.importedFrom = {
    provenance: manifest.provenance,
    exportedAt: manifest.exportedAt,
    exportedByVersion: manifest.exportedByVersion,
    sourceRoot: manifest.sourceRoot,
    ...(manifest.importedFrom ? { previous: manifest.importedFrom } : {}),
  };
  return normalized as Partial<WorkingFileRuntime>;
}
