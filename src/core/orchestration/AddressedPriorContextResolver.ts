import * as fs from "fs";
import * as path from "path";
import {
  isWorkflowRunAddress,
  type PriorContext,
  type WorkflowRunAddress,
  type WorkflowStep,
} from "../../types/CtrlYokeTypes";
import type { PriorContextItem } from "../HarnessIntegration";
import type { PriorContextRequest } from "../../utils/PriorContextMerge";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { RunOutputResolver, type RunOutputProjectionOptions } from "./RunOutputResolver";

export interface PriorContextResolverOptions {
  readonly workspaceRoot?: string;
  readonly historyFilePath?: string;
  readonly outputResolver: RunOutputResolver;
  readonly projectionOptions?: Omit<RunOutputProjectionOptions, "workspaceRoot">;
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
    return new AddressedPriorContextResolver(
      workspaceRoot,
      outputResolver,
      { workspaceRoot, ...projectionOptions }
    ).resolve(contexts, (sameRunContexts) =>
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
 * Resolves explicitly-addressed prior context without accepting a caller path.
 * A source must be a real, terminal run under this workspace's `.runs` root;
 * drafts, symlinks, missing runs, and live runs are never imported.
 */
export class AddressedPriorContextResolver {
  constructor(
    private readonly workspaceRoot: string,
    private readonly outputResolver: RunOutputResolver,
    private readonly projectionOptions: RunOutputProjectionOptions = { workspaceRoot }
  ) {}

  async resolve(
    contexts: readonly PriorContextRequest[],
    resolveSameRun: (
      contexts: readonly PriorContextRequest[]
    ) => Promise<PriorContextItem[]>
  ): Promise<PriorContextItem[]> {
    const local: PriorContextRequest[] = [];
    const addressed: { address: WorkflowRunAddress; detail: "full" | "summary" }[] = [];
    for (const request of contexts) {
      const selection = typeof request === "object" && !Array.isArray(request) && "context" in request ? request : undefined;
      const context = selection ? selection.context : request as PriorContext;
      const detail = selection?.detail ?? "full";
      if (isWorkflowRunAddress(context)) addressed.push({ address: context, detail });
      else local.push(request);
    }

    const items = await resolveSameRun(local);
    for (const { address, detail } of addressed) {
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
