import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { writeFileAtomic } from "../../utils/AtomicFileUtils";
import type { WorkflowLineageDescriptor } from "../../types/CtrlYokeTypes";
import type { WorkflowTimelineEventDraft } from "../../types/WorkflowTimelineTypes";
import {
  RUN_BUNDLE_FILES,
  type RunBundleEvent,
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

export interface RunBundleImportOptions extends ReadRunBundleOptions {
  workspaceRoot: string;
  bundleDir: string;
  again?: boolean;
  name?: string;
}

export type RunBundleImportResult =
  | { status: "imported"; workflowKey: string; runRef: string }
  | { status: "alreadyImported"; workflowKey: string };

export class RunBundleImporter {
  constructor(
    private readonly materializer = new RunMaterializer(),
    private readonly lineageRepository = new WorkflowLineageRepository()
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
      kind: "runBundle",
      provenance: header.manifest.provenance,
      sourceRoot: header.manifest.sourceRoot,
      exportedAt: header.manifest.exportedAt,
      exportedByVersion: header.manifest.exportedByVersion,
      bundleName: path.basename(path.resolve(options.bundleDir)),
    };
    if (!options.again) {
      for (const workflowKey of await this.lineageRepository.listLineageKeys(
        options.workspaceRoot
      )) {
        const descriptor = await this.lineageRepository.tryReadDescriptor(
          options.workspaceRoot,
          workflowKey
        );
        const imported = descriptor?.importedFrom;
        if (
          imported?.kind === "runBundle" &&
          imported.provenance.workflowKey ===
            provenance.provenance.workflowKey &&
          imported.provenance.runRef === provenance.provenance.runRef &&
          imported.sourceRoot === provenance.sourceRoot &&
          imported.exportedAt === provenance.exportedAt
        ) {
          return { status: "alreadyImported", workflowKey };
        }
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
                ? options.workspaceRoot
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
      executionState: header.runManifest.executionState,
      currentIndex: (definition.steps as unknown[] | undefined)?.length ?? 0,
      startedAt: header.runManifest.startedAt,
      nextSequence: header.runManifest.nextSequence,
      provenance,
    });
    return {
      status: "imported",
      workflowKey: materialized.workflowKey,
      runRef: materialized.runRef,
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
