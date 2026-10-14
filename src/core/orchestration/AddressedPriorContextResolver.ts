import * as fs from "fs";
import * as path from "path";
import {
  isPriorContextRunSource,
  type PriorContext,
  type PriorContextRunSource,
  type RunRef,
  type WorkflowKey,
  type WorkflowRunAddress,
  type WorkflowStep,
} from "../../types/CtrlYokeTypes";
import type { PriorContextItem } from "../HarnessIntegration";
import type { PriorContextRequest } from "../../utils/PriorContextMerge";
import {
  PRIOR_CONTEXT_DETAILS,
  type PriorContextDetail,
} from "../../types/DashboardConstants";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import {
  RunOutputResolver,
  type RunOutputProjectionOptions,
} from "./RunOutputResolver";
import { WorkflowLineageRepository } from "./WorkflowLineageRepository";
import {
  matchRunSelector,
  matchWorkflowSelector,
  RUN_SELECTOR_MATCH_KINDS,
  WORKFLOW_SELECTOR_MATCH_KINDS,
  type WorkflowLineageLookup,
} from "./WorkflowRunSelector";

export interface PriorContextResolverOptions {
  readonly workspaceRoot?: string;
  readonly historyFilePath?: string;
  readonly outputResolver: RunOutputResolver;
  readonly projectionOptions?: Omit<
    RunOutputProjectionOptions,
    "workspaceRoot"
  >;
}

/**
 * Build the timeline-backed prior-context callback shared by live execution
 * and dry-run preview. An absent root or history path means there is no run
 * history to resolve yet, which is a valid preview state.
 */
export function createPriorContextResolver({
  workspaceRoot,
  historyFilePath,
  outputResolver,
  projectionOptions,
}: PriorContextResolverOptions): (
  contexts: readonly PriorContextRequest[],
  allPrompts: readonly WorkflowStep[],
  groupStartBoundary: number
) => Promise<PriorContextItem[]> {
  return async (contexts, allPrompts, groupStartBoundary) => {
    if (!workspaceRoot || !historyFilePath) {
      return [];
    }
    return new AddressedPriorContextResolver(workspaceRoot, outputResolver, {
      workspaceRoot,
      ...projectionOptions,
    }).resolve(contexts, (sameRunContexts) =>
      outputResolver.resolvePriorContextItems(
        historyFilePath,
        sameRunContexts,
        allPrompts,
        groupStartBoundary,
        { workspaceRoot, ...projectionOptions }
      )
    );
  };
}

/**
 * Resolves another run's prior context without accepting a caller path.
 * A source must be a real, terminal run under this workspace's `.runs` root;
 * drafts, symlinks, missing runs, and live runs are never imported.
 */
export class AddressedPriorContextResolver {
  constructor(
    private readonly workspaceRoot: string,
    private readonly outputResolver: RunOutputResolver,
    private readonly projectionOptions: RunOutputProjectionOptions = {
      workspaceRoot,
    },
    private readonly lineages: WorkflowLineageLookup = new WorkflowLineageRepository()
  ) {}

  async resolve(
    contexts: readonly PriorContextRequest[],
    resolveSameRun: (
      contexts: readonly PriorContextRequest[]
    ) => Promise<PriorContextItem[]>
  ): Promise<PriorContextItem[]> {
    const local: PriorContextRequest[] = [];
    const addressed: {
      source: PriorContextRunSource;
      detail: PriorContextDetail;
    }[] = [];
    for (const request of contexts) {
      const selection =
        typeof request === "object" &&
        !Array.isArray(request) &&
        "context" in request
          ? request
          : undefined;
      const context = selection ? selection.context : (request as PriorContext);
      const detail = selection?.detail ?? PRIOR_CONTEXT_DETAILS.FULL;
      if (isPriorContextRunSource(context))
        addressed.push({ source: context, detail });
      else local.push(request);
    }

    const items = await resolveSameRun(local);
    for (const { source, detail } of addressed) {
      const address = await this.resolveSource(source);
      await this.assertAuthorizedTerminalRun(address);
      items.push(
        ...(await this.outputResolver.resolveAllPriorContextItems(
          WorkflowPaths.manifestPath(
            this.workspaceRoot,
            address.workflowKey,
            address.runRef
          ),
          this.projectionOptions,
          detail
        ))
      );
    }
    return items;
  }

  /**
   * Turn a typed source into one run's address. Messages name only the
   * selector and lineage keys the author can already see, never a path.
   */
  private async resolveSource(
    source: PriorContextRunSource
  ): Promise<WorkflowRunAddress> {
    const match = await matchWorkflowSelector(
      this.workspaceRoot,
      this.lineages,
      source.workflow
    );
    if (match.kind === WORKFLOW_SELECTOR_MATCH_KINDS.AMBIGUOUS) {
      throw new Error(
        `Prior-context workflow "${source.workflow}" matches more than one workflow (${match.workflowKeys.join(", ")}); use its workflow key instead`
      );
    }
    if (match.kind === WORKFLOW_SELECTOR_MATCH_KINDS.NOT_FOUND) {
      throw new Error(
        `Prior-context workflow "${source.workflow}" was not found in this workspace`
      );
    }

    const runs = await this.readRuns(match.workflowKey);
    if (source.run === undefined) {
      const latest = runs.find((run) => run.completedAt !== undefined);
      if (!latest) {
        throw new Error(
          `Prior-context workflow "${source.workflow}" has no completed run`
        );
      }
      return { workflowKey: match.workflowKey, runRef: latest.runRef };
    }

    const runMatch = matchRunSelector(runs, source.run);
    if (runMatch.kind === RUN_SELECTOR_MATCH_KINDS.FOUND) {
      return { workflowKey: match.workflowKey, runRef: runMatch.run.runRef };
    }
    throw new Error(
      runMatch.kind === RUN_SELECTOR_MATCH_KINDS.AMBIGUOUS
        ? `Prior-context run ${source.run} is ambiguous in workflow "${source.workflow}"; use its run reference instead`
        : `Prior-context run ${source.run} was not found in workflow "${source.workflow}"`
    );
  }

  /** A lineage's readable runs, newest first; unreadable manifests are skipped. */
  private async readRuns(
    workflowKey: WorkflowKey
  ): Promise<{ runRef: RunRef; runId: number; completedAt?: number }[]> {
    const runRefs = await this.lineages.listRunRefs(
      this.workspaceRoot,
      workflowKey
    );
    const runs = await Promise.all(
      runRefs.map(async (runRef) => {
        try {
          const manifest = await this.outputResolver.getManifest(
            WorkflowPaths.manifestPath(this.workspaceRoot, workflowKey, runRef)
          );
          return {
            runRef,
            runId: manifest.runId,
            completedAt: manifest.completedAt,
          };
        } catch {
          return undefined;
        }
      })
    );
    return runs.filter((run) => run !== undefined);
  }

  private async assertAuthorizedTerminalRun(
    address: WorkflowRunAddress
  ): Promise<void> {
    try {
      WorkflowPaths.assertValidWorkflowKey(address.workflowKey);
      WorkflowPaths.assertValidRunRef(address.runRef);
      const root = await fs.promises.realpath(
        WorkflowPaths.runsRoot(this.workspaceRoot)
      );
      const runDir = WorkflowPaths.runDir(
        this.workspaceRoot,
        address.workflowKey,
        address.runRef
      );
      const [runStat, realRunDir, manifest] = await Promise.all([
        fs.promises.lstat(runDir),
        fs.promises.realpath(runDir),
        this.outputResolver.getManifest(
          WorkflowPaths.manifestPath(
            this.workspaceRoot,
            address.workflowKey,
            address.runRef
          )
        ),
      ]);
      if (
        !runStat.isDirectory() ||
        runStat.isSymbolicLink() ||
        !isContained(realRunDir, root) ||
        !manifest.completedAt
      ) {
        throw new Error("unavailable");
      }
    } catch {
      // Do not expose workspace paths or filesystem details to prompts/webviews.
      throw new Error(
        "The selected prior-context run is unavailable, deleted, or not yet complete"
      );
    }
  }
}

function isContained(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
