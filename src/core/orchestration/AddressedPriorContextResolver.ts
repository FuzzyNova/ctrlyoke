import * as fs from "fs";
import * as path from "path";
import type {
  PriorContext,
  WorkflowRunAddress,
} from "../../types/CtrlYokeTypes";
import type { PriorContextItem } from "../HarnessIntegration";
import * as WorkflowPaths from "../../utils/WorkflowPaths";
import { RunOutputResolver } from "./RunOutputResolver";

/**
 * Resolves explicitly-addressed prior context without accepting a caller path.
 * A source must be a real, terminal run under this workspace's `.runs` root;
 * drafts, symlinks, missing runs, and live runs are never imported.
 */
export class AddressedPriorContextResolver {
  constructor(
    private readonly workspaceRoot: string,
    private readonly outputResolver: RunOutputResolver
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
      if (isAddress(context)) addressed.push(context);
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
          )
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

function isAddress(value: PriorContext): value is WorkflowRunAddress {
  return !Array.isArray(value) && typeof value === "object" && value !== null;
}

function isContained(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
