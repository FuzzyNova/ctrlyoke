import type { PriorContext, PromptFile, WorkflowStep } from "./CtrlYokeTypes";
import type { ResolvedProperties } from "../utils/PropertyResolver";
import type { PriorContextItem } from "../core/HarnessIntegration";
import type { CompatibilityDiagnostic } from "./CompatibilityTypes";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";

/**
 * Immutable roots used by one workflow execution.
 *
 * The state and execution roots are identical until worktree support supplies
 * a separate checkout. Keeping both roots in the contract now prevents later
 * callers from adding an ad-hoc cwd override.
 */
export interface ExecutionWorkspace {
  /** Where ctrlyoke stores .ctrlyoke/.runs, history, queue state, and locks. */
  readonly stateRoot: string;

  /** The cwd used by the harness, scripts, conditions, and temp prompt files. */
  readonly executionRoot: string;

  /** Canonical Git toplevel from which a linked checkout is created. */
  readonly sourceCheckoutRoot?: string;

  /** Canonical Git toplevel of the checkout in which execution occurs. */
  readonly executionCheckoutRoot?: string;

  /** Trusted project roots as seen by execution, with repo-owned roots remapped. */
  readonly workspaceRoots: readonly string[];

  /** Name/path pairs used by multi-root references and snapshots, also remapped. */
  readonly namedWorkspaceRoots: readonly ResolverWorkspaceFolder[];

  /** External roots approved against stateRoot's trust identity. */
  readonly approvedExternalRoots: readonly string[];
}

/** Narrow working-file persistence contract exposed to harnesses. */
export interface WorkflowWorkingFilePersistence {
  updateWorkingFile(skipMerge?: boolean): Promise<void>;
  /** Persist a newly discovered harness session before the prompt completes. */
  persistSessionId?(promptIndex: number, sessionId: string): Promise<void>;
}

/**
 * Workflow context passed to harness sendPrompt calls.
 * Single source of truth — replaces all per-file inline type duplicates.
 *
 * Add fields here; no other file needs updating for new context properties.
 */
export interface WorkflowContext {
  promptIndex: number;
  allPrompts: WorkflowStep[];
  filePath?: string;
  /** Human-readable workflow name (derived from file basename or first prompt text).
   *  Used for temp file naming — avoids ISO timestamps embedded in working file paths. */
  workflowName?: string;
  /** Workflow instance UUID — matches activeWorkflowId in the webview for PTY session keying. */
  instanceId?: string;
  /** Path to the .ctrlyoke.json working file (sets CTRLYOKE_WORKING_FILE for MCP). */
  workingFilePath?: string;
  resolvedProperties?: ResolvedProperties;
  workflowFile?: PromptFile;
  /** Whether the current host can provide a PTY for this execution. */
  hostCanProvidePty?: boolean;
  /** Minimal working-file persistence hook used for prompt runtime metadata. */
  workingFilePersistence?: WorkflowWorkingFilePersistence;
  /** Forward runtime compatibility diagnostics to the workflow dashboard. */
  reportCompatibilityDiagnostics?: (
    diagnostics: readonly CompatibilityDiagnostic[]
  ) => void;
  /**
   * Timeline-backed prior-context projection for an executing promoted run.
   * The timeline is the only response source; execution caches are in-memory only.
   */
  resolvePriorContextItems?: (
    contexts: readonly PriorContext[],
    allPrompts: readonly WorkflowStep[],
    promptIndex: number
  ) => Promise<PriorContextItem[]>;
  /** Session ID from the most recent finalStep execution. Consumed by SessionResolver
   *  when sessionId is the "finalStep" sentinel on any prompt (queue or finalStep phase).
   *  Note: only applies when finalStep is an AI prompt step (not a ScriptStep). */
  finalStepSessionId?: string;
}
