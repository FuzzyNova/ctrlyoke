import type { PromptFile, WorkflowStep } from "./CtrlYokeTypes";
import type { ResolvedProperties } from "../utils/PropertyResolver";

/** Narrow working-file persistence contract exposed to harnesses. */
export interface WorkflowWorkingFilePersistence {
  updateWorkingFile(skipMerge?: boolean): Promise<void>;
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
  /** Path to the .flightpath.json working file (sets CTRLYOKE_WORKING_FILE for MCP). */
  workingFilePath?: string;
  resolvedProperties?: ResolvedProperties;
  workflowFile?: PromptFile;
  /** Minimal working-file persistence hook used for prompt runtime metadata. */
  workingFilePersistence?: WorkflowWorkingFilePersistence;
  /** Read-only accessor for prior-context finalStep loop responses. */
  getFinalStepResponseTexts?: () => string[];
  /** Session ID from the most recent finalStep execution. Consumed by SessionResolver
   *  when sessionId is the "finalStep" sentinel on any prompt (queue or finalStep phase).
   *  Note: only applies when finalStep is an AI prompt step (not a ScriptStep). */
  finalStepSessionId?: string;
}
