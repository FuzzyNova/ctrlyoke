import * as path from "path";
import { STEP_TYPES } from "../types/DashboardConstants";
import type { SubWorkflowStep } from "../types/CtrlYokeTypes";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import { workspaceRelativeReference } from "./WorkflowStepPathRebaser";

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
