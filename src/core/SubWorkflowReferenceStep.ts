import * as path from "path";
import {
  PROMPT_FILE_RESOLUTION_STATUSES,
  STEP_TYPES,
} from "../types/DashboardConstants";
import type { SubWorkflowStep } from "../types/CtrlYokeTypes";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import { workspaceRelativeReference } from "./WorkflowStepPathRebaser";
import type { PromptFileResolver } from "./PromptFileResolver";

/** Why a sub-workflow step's `workflow` path did not resolve (D5). */
export function subWorkflowUnresolvedMessage(workflowPath: string): string {
  return `Sub-workflow could not resolve '${workflowPath}'`;
}

/**
 * Resolve a sub-workflow step's `workflow` path as its launch does (D5),
 * with the resolver the launch would build. A path outside the workspace and
 * its approved external roots is refused here exactly as it is at launch.
 */
export async function resolveSubWorkflowReference(
  workflowPath: string,
  resolver: PromptFileResolver,
  sourceDefinitionPath?: string
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  const resolution = await resolver.resolvePath(
    workflowPath,
    sourceDefinitionPath
  );
  return resolution.status === PROMPT_FILE_RESOLUTION_STATUSES.RESOLVED
    ? { ok: true, path: resolution.path }
    : { ok: false, message: subWorkflowUnresolvedMessage(workflowPath) };
}

/**
 * The one workflow step that queues `filePath` as a sub-workflow, shared by
 * every "queue as sub-workflow" entry point. The path is workspace-relative
 * when the file is inside the workspace (prefixed with its folder's name in a
 * multi-root workspace when it is outside the primary folder), else absolute.
 * A relative path resolves from the run's execution checkout at launch
 * (D5), so it also finds the file in a worktree parent.
 */
export function buildSubWorkflowReferenceStep(
  filePath: string,
  workspaceRoot: string,
  namedRoots: readonly ResolverWorkspaceFolder[] = []
): SubWorkflowStep {
  return {
    type: STEP_TYPES.WORKFLOW,
    workflow: workspaceRelativeReference(
      filePath,
      path.resolve(workspaceRoot),
      namedRoots
    ),
  };
}
