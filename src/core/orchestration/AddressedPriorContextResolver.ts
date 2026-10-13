import * as fs from "fs";
import * as path from "path";
import {
  isWorkflowRunAddress,
  type PriorContext,
  type WorkflowRunAddress,
  type WorkflowStep,
} from "../../types/CtrlYokeTypes";
import type { PriorContextItem } from "../HarnessIntegration";
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
  contexts: readonly PriorContext[],
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
    contexts: readonly PriorContext[],
    resolveSameRun: (
      contexts: readonly PriorContext[]
    ) => Promise<PriorContextItem[]>
  ): Promise<PriorContextItem[]> {
    const local: PriorContext[] = [];
    const addressed: WorkflowRunAddress[] = [];
    for (const context of contexts) {
      if (isWorkflowRunAddress(context)) addressed.push(context);
      else local.push(context);
    }

    const items = await resolveSameRun(local);
    for (const address of addressed) {
      await this.assertAuthorizedTerminalRun(address);
      items.push(
        ...(await this.outputResolver.resolveAllPriorContextItems(
          WorkflowPaths.manifestPath(
            this.workspaceRoot,
            address.workflowKey,
            address.runRef
          ),
          this.projectionOptions
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
