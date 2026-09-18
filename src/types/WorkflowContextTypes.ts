import * as path from "path";
import type {
  ConditionEvaluationSummary,
  PriorContext,
  PromptFile,
  WorkflowStep,
  WorktreeResolution,
} from "./CtrlYokeTypes";
import type { ResolvedProperties } from "../utils/PropertyResolver";
import type {
  HarnessIntegration,
  PriorContextItem,
} from "../core/HarnessIntegration";
import type { CompatibilityDiagnostic } from "./CompatibilityTypes";
import type { ResolverWorkspaceFolder } from "../platform/WorkspaceRootResolver";
import type { RunSecretRedactor } from "../utils/SecretRedactionService";

/**
 * Immutable roots used by one workflow execution.
 *
 * The state and execution roots are identical until worktree support supplies
 * a separate checkout. Keeping both roots in the contract now prevents later
 * callers from adding an ad-hoc cwd override.
 */
export interface ExecutionWorkspace {
  /** The resolved run-storage state root for history, queue state, and locks. */
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

  /** Worktree selection and its authored/default origin for this execution. */
  readonly worktree?: WorktreeResolution;
}

/** Stable identity used to decide whether a retained integration may be reused. */
export function getExecutionWorkspaceIdentity(
  workspace: ExecutionWorkspace
): string {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return JSON.stringify({
    stateRoot: normalize(workspace.stateRoot),
    executionRoot: normalize(workspace.executionRoot),
    sourceCheckoutRoot: workspace.sourceCheckoutRoot
      ? normalize(workspace.sourceCheckoutRoot)
      : undefined,
    executionCheckoutRoot: workspace.executionCheckoutRoot
      ? normalize(workspace.executionCheckoutRoot)
      : undefined,
    workspaceRoots: workspace.workspaceRoots.map(normalize),
    namedWorkspaceRoots: workspace.namedWorkspaceRoots.map((root) => ({
      name: root.name,
      fsPath: normalize(root.fsPath),
    })),
    approvedExternalRoots: workspace.approvedExternalRoots.map(normalize),
  });
}

/** Narrow working-file persistence contract exposed to harnesses. */
export interface WorkflowWorkingFilePersistence {
  updateWorkingFile(skipMerge?: boolean): Promise<void>;
  /** Persist a newly discovered harness session before the prompt completes. */
  persistSessionId?(promptIndex: number, sessionId: string): Promise<void>;
}

/**
 * Runtime addresses used by the built-in MCP-as-skill instructions.
 *
 * The server and workspace paths are always available during execution. The
 * Coordination-only flags are optional because sequential participants need
 * only the run address; parallel-group participants add their step identity.
 */
export interface McpToolSkillRunContext {
  readonly mcpServerPath: string;
  readonly workspaceRoot: string;
  readonly executionRoot?: string;
  readonly workingFilePath?: string;
  readonly commitOutputPath?: string;
  readonly stepIndex?: number;
  readonly parallelGroupId?: string;
  /**
   * ctrlyoke tools this step denied. The generated skills omit them, so a
   * denied tool is never documented to the agent. In `ctrlyokeMcpMode:
   * "skill"` mode the skill *is* the tool listing, which makes this the
   * only expression of a denial — the CLI entry point does not enforce it, the
   * same way attestation is an accuracy signal rather than a security boundary.
   */
  readonly deniedTools?: readonly string[];
}

/**
 * Workflow context passed to harness sendPrompt calls.
 * Single source of truth — replaces all per-file inline type duplicates.
 *
 * Add fields here; no other file needs updating for new context properties.
 */
export interface WorkflowContext {
  promptIndex: number;
  /** Signed step identity for terminal metadata; falls back to promptIndex when absent. */
  terminalStepIndex?: number;
  allPrompts: WorkflowStep[];
  filePath?: string;
  /** Human-readable workflow name (derived from file basename or first prompt text).
   *  Used for temp file naming — avoids ISO timestamps embedded in working file paths. */
  workflowName?: string;
  /** Workflow instance UUID — matches activeWorkflowId in the webview for PTY session keying. */
  instanceId?: string;
  /** Path to the .ctrlyoke.json working file (sets CTRLYOKE_WORKING_FILE for MCP). */
  workingFilePath?: string;
  /** Concrete addresses for generated built-in MCP skill instructions. */
  mcpToolSkillContext?: McpToolSkillRunContext;
  resolvedProperties?: ResolvedProperties;
  workflowFile?: PromptFile;
  /** Whether the current host can provide a PTY for this execution. */
  hostCanProvidePty?: boolean;
  /** Whether the host can multiplex concurrent interactive sessions. */
  supportsConcurrentInteractiveSessions?: boolean;
  /** Extension-clock timestamp for the prompt output this context is about to start. */
  promptStartedAt?: number;
  /** Minimal working-file persistence hook used for prompt runtime metadata. */
  workingFilePersistence?: WorkflowWorkingFilePersistence;
  /** Latest pre-condition result recorded for this prompt's dispatch target. */
  preConditionResult?: ConditionEvaluationSummary;
  /** Latest end-condition result recorded for this prompt's dispatch target. */
  endConditionResult?: ConditionEvaluationSummary;
  /** Forward runtime compatibility diagnostics to the workflow dashboard. */
  reportCompatibilityDiagnostics?: (
    diagnostics: readonly CompatibilityDiagnostic[],
    timestampMs?: number
  ) => void;
  /** Analyze resolved prompt attachments at the final execution boundary. */
  analyzeCompatibilityForPrompt?: (
    promptIndex: number,
    prompt: import("./CtrlYokeTypes").PromptStep,
    resolvedProperties: ResolvedProperties,
    imageFileRefs: readonly string[]
  ) => Promise<readonly CompatibilityDiagnostic[]>;
  /**
   * Timeline-backed prior-context projection for an executing promoted run.
   * The timeline is the only response source; execution caches are in-memory only.
   */
  resolvePriorContextItems?: (
    contexts: readonly PriorContext[],
    allPrompts: readonly WorkflowStep[],
    groupStartBoundary: number
  ) => Promise<PriorContextItem[]>;
  /**
   * Retire any *other* live harness process in this workflow that still owns
   * the AI session this prompt is about to resume, and close its terminal.
   *
   * Harnesses reject or corrupt a `--resume` of a session another process still
   * holds open — including a finished inject-mode TUI left running for a later
   * step — so the takeover has to be ordered: kill, await exit, then spawn.
   * `requester` is excluded; it retires its own PTY through its own paths.
   */
  releaseConflictingAiSession?: (
    aiSessionId: string,
    requester: HarnessIntegration
  ) => Promise<void>;
  /** Exclusive queue boundary used by grouped prior-context/session lookups. */
  groupStartBoundary?: number;
  /** Session resolution frozen by parallel-group preflight. */
  preflightSession?: { readonly sessionId?: string };
  /** Session ID from the most recent finalStep execution. Consumed by SessionResolver
   *  when sessionId is the "finalStep" sentinel on any prompt (queue or finalStep phase).
   *  Note: only applies when finalStep is an AI prompt step (not a ScriptStep). */
  finalStepSessionId?: string;
  /** State root exported to MCP by an execution integration. */
  stateRoot?: string;
  /**
   * Resolved values for this prompt's secret grants. This is execution-only
   * state used by providers that cannot expand MCP references; it is never
   * persisted or included in workflow/runtime serialization.
   */
  secretEnvironment?: Readonly<Record<string, string>>;
  /** Run-owned redactor populated only with values resolved during execution. */
  secretRedactor?: RunSecretRedactor;
}
