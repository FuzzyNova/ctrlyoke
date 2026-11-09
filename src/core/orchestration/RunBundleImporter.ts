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
  parseAllFileReferences,
  type FileReference,
} from "../../utils/FileReferenceParser";
import {
  buildFileReference,
  buildSelectionReference,
  buildSymbolReference,
} from "../../completions/ContextReferenceBuilder";
import {
  readRunBundleHeader,
  streamRunBundleEvents,
  type ReadRunBundleOptions,
} from "./RunBundleReader";
import { RunMaterializer } from "./RunMaterializer";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import {
  EXECUTION_STATES,
  NODE_ERROR_CODES,
} from "../../types/DashboardConstants";
import {
  RunChangesPlacer,
  type RunChangesTarget,
  type RunChangesPlacement,
} from "./RunChangesPlacer";
import type {
  WorkingFile,
  WorkingFileRuntime,
} from "../../types/CtrlYokeTypes";
import { hasErrnoCode } from "../../utils/ErrorUtils";

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
    const { rewrite: rewriteAssets, cleanup: cleanupAssets } =
      await this.createAssetReferenceRewriter(
        header.bundleDir,
        options.workspaceRoot,
        header.manifest.assets ?? []
      );
    let definition: Record<string, unknown>;
    let runFile: WorkingFile | undefined;
    let executionRoot = options.workspaceRoot;
    let placement: RunChangesPlacement | undefined;
    let placementRollback: (() => Promise<void>) | undefined;
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
    try {
      definition = rewriteAssets(header.definition) as Record<string, unknown>;
      runFile = header.runtime
        ? (rewriteAssets(header.runtime) as WorkingFile)
        : undefined;
      const materialized = await this.materializer.materialize({
        workspaceRoot: options.workspaceRoot,
        workflowName:
          options.name?.trim() || header.manifest.lineage.workflowName,
        definition,
        ...(runFile ? { workingFile: runFile } : {}),
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
                    options.name?.trim() ||
                    header.manifest.lineage.workflowName,
                });
                placementRollback = placement.rollback;
                const placementRollbackHandle = placementRollback;
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
                    rollback: placementRollbackHandle,
                  };
                }
                if (
                  placement.canContinue === false ||
                  (!placement.applied && target !== RUN_CHANGES_TARGETS.SKIP)
                ) {
                  const reason =
                    placement.warning ??
                    "workspace changes could not be placed";
                  return {
                    runtimeState: normalizeImportedRuntime(
                      header.runtime,
                      header.manifest,
                      header.runManifest,
                      { reason }
                    ),
                    rollback: placementRollbackHandle,
                  };
                }
                executionRoot = placement.worktreePath ?? options.workspaceRoot;
                return {
                  runtimeState: normalizeImportedRuntime(
                    header.runtime,
                    header.manifest,
                    header.runManifest
                  ),
                  rollback: placementRollbackHandle,
                };
              },
            }
          : {
              runtimeState: {
                ...normalizeImportedRuntime(
                  header.runtime,
                  header.manifest,
                  header.runManifest,
                  { reason: "this bundle contains history only" }
                ),
                executionState: header.runManifest.executionState,
              },
            }),
      });
      return {
        status: RUN_IMPORT_STATUSES.IMPORTED,
        workflowKey: materialized.workflowKey,
        runRef: materialized.runRef,
        ...(placement
          ? {
              placement: (({ rollback: _rollback, ...publicPlacement }) =>
                publicPlacement)(placement),
            }
          : {}),
      };
    } catch (error) {
      await cleanupAssets();
      throw error;
    }
  }

  private async createAssetReferenceRewriter(
    bundleDir: string,
    workspaceRoot: string,
    assets: NonNullable<
      import("../../types/RunBundleTypes").RunBundleManifest["assets"]
    >
  ): Promise<{
    rewrite: (value: unknown) => unknown;
    cleanup: () => Promise<void>;
  }> {
    const replacements = new Map<string, string>();
    const createdFiles: string[] = [];
    const realWorkspace = await fs.promises.realpath(workspaceRoot);
    try {
      for (const asset of assets) {
        const segments = asset.path.split("/");
        if (segments.some((segment) => !isSafePathSegment(segment))) {
          throw new Error(`Invalid bundled asset path: ${asset.path}`);
        }
        const bundleSegments =
          segments[0] === RUN_BUNDLE_FILES.ASSETS_DIR
            ? segments.slice(1)
            : segments;
        // Run bundle exports store every referenced asset under assets/<name>;
        // they do not preserve Save As' prompt/attachment category, so imports
        // place all assets in the workspace attachment store.
        const relative =
          bundleSegments[0] === "prompts" || bundleSegments[0] === "attachments"
            ? bundleSegments.slice(1)
            : bundleSegments;
        if (!relative.length)
          throw new Error(`Invalid bundled asset path: ${asset.path}`);
        const store = path.join(realWorkspace, ".ctrlyoke", "attachments");
        await fs.promises.mkdir(store, { recursive: true });
        const realStore = await fs.promises.realpath(store);
        if (!isPathWithinDirectory(realStore, realWorkspace))
          throw new Error("Asset store escapes the importing workspace.");
        let destination = path.resolve(realStore, ...relative);
        if (!isPathWithinDirectory(destination, realStore))
          throw new Error(`Asset path escapes its store: ${asset.path}`);
        await fs.promises.mkdir(path.dirname(destination), { recursive: true });
        const realParent = await fs.promises.realpath(
          path.dirname(destination)
        );
        if (!isPathWithinDirectory(realParent, realStore))
          throw new Error(`Asset destination escapes its store: ${asset.path}`);
        const source = path.resolve(bundleDir, ...segments);
        const realBundle = await fs.promises.realpath(bundleDir);
        const realSource = await fs.promises.realpath(source);
        if (!isPathWithinDirectory(realSource, realBundle))
          throw new Error(`Bundled asset escapes its bundle: ${asset.path}`);
        const content = await fs.promises.readFile(realSource);
        let exists = false;
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
            try {
              const hashedExisting = await fs.promises.lstat(destination);
              if (hashedExisting.isSymbolicLink() || !hashedExisting.isFile()) {
                throw new Error(
                  `Asset destination is not a regular file: ${destination}`
                );
              }
              if (!(await fs.promises.readFile(destination)).equals(content)) {
                throw new Error(
                  `Conflicting bundled asset destination: ${destination}`
                );
              }
              exists = true;
            } catch (hashedError) {
              if (!hasErrnoCode(hashedError, NODE_ERROR_CODES.ENOENT))
                throw hashedError;
            }
          } else {
            exists = true;
          }
        } catch (error) {
          if (!hasErrnoCode(error, NODE_ERROR_CODES.ENOENT)) throw error;
        }
        if (!exists) {
          await writeFileAtomic(destination, content);
          createdFiles.push(destination);
        }
        const workspaceRelative = path
          .relative(realWorkspace, destination)
          .replace(/\\/g, "/");
        const normalizedAssetPath = bundleSegments.join("/");
        replacements.set(
          normalizeReferenceAssetPath(normalizedAssetPath),
          workspaceRelative
        );
      }
      return {
        rewrite: (input: unknown) =>
          mapJsonStrings(input, rewriteAssetReferences),
        cleanup: async () => {
          await Promise.all(
            createdFiles.map((file) => fs.promises.rm(file, { force: true }))
          );
        },
      };
    } catch (error) {
      await Promise.all(
        createdFiles.map((file) => fs.promises.rm(file, { force: true }))
      );
      throw error;
    }

    function rewriteAssetReferences(value: string): string {
      const references = parseAllFileReferences(value);
      let rewritten = value;
      for (const reference of [...references].reverse()) {
        const relativeAsset = normalizeReferenceAssetPath(reference.path);
        const replacementPath = replacements.get(relativeAsset);
        if (!replacementPath) continue;
        rewritten =
          rewritten.slice(0, reference.startOffset!) +
          buildAssetReference(reference, replacementPath) +
          rewritten.slice(reference.endOffset!);
      }
      return rewritten;
    }
  }
}

function normalizeReferenceAssetPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized.startsWith(`${RUN_BUNDLE_FILES.ASSETS_DIR}/`)
    ? normalized.slice(RUN_BUNDLE_FILES.ASSETS_DIR.length + 1)
    : normalized;
}

function buildAssetReference(
  reference: FileReference,
  relativePath: string
): string {
  if (reference.symbolName !== undefined) {
    return buildSymbolReference(
      relativePath,
      reference.symbolName,
      reference.startLine!,
      reference.endLine!,
      reference.symbolKind
    );
  }
  if (reference.startLine !== undefined && reference.endLine !== undefined) {
    return buildSelectionReference(
      relativePath,
      reference.startLine,
      reference.endLine
    );
  }
  return reference.isDirectory
    ? `@${relativePath.replace(/\/$/, "")}/`
    : buildFileReference(relativePath);
}

function normalizeImportedRuntime(
  workingFile: Record<string, unknown> | undefined,
  manifest: import("../../types/RunBundleTypes").RunBundleManifest,
  runManifest: import("../../types/RunBundleTypes").RunBundleRunManifest,
  viewOnly?: { reason: string }
): Partial<WorkingFileRuntime> {
  const normalized: Record<string, unknown> = {
    ...((workingFile?._runtime as Record<string, unknown> | undefined) ?? {}),
  };
  delete normalized.worktree;
  delete normalized.stopReason;
  delete normalized.worktreeNotice;
  delete normalized.pendingRewind;
  normalized.executionState = EXECUTION_STATES.STOPPED;
  normalized.currentIndex =
    typeof normalized.currentIndex === "number"
      ? normalized.currentIndex
      : Array.isArray(workingFile?.steps)
        ? workingFile.steps.length
        : runManifest.stepCount;
  normalized.importedFrom = {
    provenance: manifest.provenance,
    exportedAt: manifest.exportedAt,
    exportedByVersion: manifest.exportedByVersion,
    sourceRoot: manifest.sourceRoot,
    ...(viewOnly ? { viewOnly } : {}),
    ...(manifest.importedFrom ? { previous: manifest.importedFrom } : {}),
  };
  return normalized as Partial<WorkingFileRuntime>;
}
