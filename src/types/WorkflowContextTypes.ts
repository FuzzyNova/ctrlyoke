import type { PromptItem, PromptFile } from "./FlightPathTypes";
import type { ResolvedProperties } from "../utils/PropertyResolver";
import type { PromptQueue } from "../flightpath/PromptQueue";

/**
 * Workflow context passed to harness sendPrompt calls.
 * Single source of truth — replaces all per-file inline type duplicates.
 *
 * Add fields here; no other file needs updating for new context properties.
 */
export interface WorkflowContext {
  promptIndex: number;
  allPrompts: PromptItem[];
  filePath?: string;
  /** Human-readable workflow name (derived from file basename or first prompt text).
   *  Used for temp file naming — avoids ISO timestamps embedded in working file paths. */
  workflowName?: string;
  /** Workflow instance UUID — matches activeWorkflowId in the webview for PTY session keying. */
  instanceId?: string;
  /** Path to the .flightpath.json working file (sets FLIGHTPATH_WORKING_FILE for MCP). */
  workingFilePath?: string;
  resolvedProperties?: ResolvedProperties;
  workflowFile?: PromptFile;
  promptQueue?: PromptQueue;
  /** Session ID from the most recent finalPrompt execution. Consumed by SessionResolver
   *  when sessionId is the "finalPrompt" sentinel on any prompt (queue or finalPrompt phase). */
  finalPromptSessionId?: string;
}
