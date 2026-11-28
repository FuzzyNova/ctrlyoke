import * as path from "path";
import type { ExecutionWorkspace } from "../types/WorkflowContextTypes";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import { mapSourceDefinitionPathToExecution } from "../platform/WorkspaceRootResolver";
import { pathsEqual } from "../utils/PathCasing";
import { PromptFileResolver } from "./PromptFileResolver";

/**
 * What a run resolves its prompt-file and sub-workflow references from: its
 * execution workspace and authored definition. `WorkflowExecutionContext`
 * extends it, and `WorkflowInstance.getPromptFileResolutionInput` describes an
 * instance's current one, so a queue-time check builds the resolver its
 * launch will build.
 */
export interface PromptFileResolutionInput {
  readonly executionWorkspace: ExecutionWorkspace;
  readonly workspaceFolderPath?: string;
  readonly namedWorkspaceRoots?: readonly ResolverWorkspaceFolder[];
  /** Authored workflow definition, the semantic base for relative refs. */
  readonly sourceDefinitionPath?: string;
}

export interface PromptFileResolutionOptions {
  promptFileResolver: PromptFileResolver;
  /** The authored definition as the execution checkout sees it. */
  sourceDefinitionPath?: string;
}

/**
 * The single source of the resolver a run uses for prompt-file references,
 * pre/end-condition prompt files and sub-workflow `workflow` paths (D5): the
 * execution root first, then `sourceCheckoutRoot` as the fallback, with the
 * definition mapped into the execution checkout (a definition it cannot map
 * disables `./`/`../` references). A context whose folder differs from an
 * execution root that has no checkout pair is the legacy no-worktree shape and
 * resolves from that folder instead; `getPlatformNamedRoots` names its roots
 * when the context carries none.
 */
export function buildPromptFileResolutionOptions(
  input: PromptFileResolutionInput,
  getPlatformNamedRoots: () => readonly ResolverWorkspaceFolder[]
): PromptFileResolutionOptions {
  const executionWorkspace = input.executionWorkspace;
  const legacyFolder =
    !executionWorkspace.sourceCheckoutRoot &&
    !executionWorkspace.executionCheckoutRoot &&
    input.workspaceFolderPath !== undefined &&
    !pathsEqual(
      path.resolve(input.workspaceFolderPath),
      path.resolve(executionWorkspace.executionRoot)
    )
      ? input.workspaceFolderPath
      : undefined;
  const executionRoot = legacyFolder ?? executionWorkspace.executionRoot;
  const workspaceRoots =
    legacyFolder !== undefined
      ? [executionRoot]
      : executionWorkspace.workspaceRoots;
  const namedRoots =
    legacyFolder !== undefined
      ? (input.namedWorkspaceRoots ?? getPlatformNamedRoots())
      : executionWorkspace.namedWorkspaceRoots;
  const definitionPath = mapSourceDefinitionPathToExecution(
    input.sourceDefinitionPath,
    executionWorkspace.sourceCheckoutRoot,
    executionWorkspace.executionCheckoutRoot
  );
  return {
    promptFileResolver: new PromptFileResolver({
      workspaceRoot: executionRoot,
      namedRoots,
      trustedRoots: workspaceRoots,
      sourceCheckoutRoot: executionWorkspace.sourceCheckoutRoot,
      approvedExternalRoots: executionWorkspace.approvedExternalRoots,
      allowWorkflowRelativeReferences:
        definitionPath.allowWorkflowRelativeReferences,
    }),
    sourceDefinitionPath: definitionPath.executionPath,
  };
}
