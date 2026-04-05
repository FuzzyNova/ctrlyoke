/**
 * Prompt utility functions and types
 */

import {
  STEP_STATUS,
  PROMPT_PROPERTIES,
  type StepStatus,
} from "../types/messages";

export { PROMPT_PROPERTIES };

export type EndConditionCompareSource =
  | "auto"
  | "stdout"
  | "stderr"
  | "exitCode";

/**
 * End condition configuration
 */
export interface EndCondition {
  script: string;
  returns: string;
  compareSource?: EndConditionCompareSource;
  timeout?: number;
  maxRetries?: number;
  retryPrompt?: string;
}

/**
 * Runtime metadata populated during/after execution
 */
export interface PromptRuntime {
  harness?: string;
  model?: string;
  sessionId?: string;
  startedAt?: number;
  completedAt?: number;
  retryCount?: number;
  isRetry?: boolean;
}

/**
 * Raw prompt data from workflow file
 */
export interface RawPrompt {
  name?: string;
  prompt: string;
  harness?: string;
  model?: string;
  agent?: string | null;
  skills?: string[] | null;
  resumeSession?: boolean;
  sessionId?: string | number;
  mcpServers?: (string | object)[] | null;
  hooks?: object[] | null;
  endCondition?: EndCondition | null;
  _runtime?: PromptRuntime;
}

/**
 * Execution details for a prompt
 */
export interface PromptDetails {
  output?: string;
  response?: string;
  error?: string;
  elapsed?: number;
  tokens?: { prompt: number; completion: number };
  streamingChunks?: string[];
  [key: string]: unknown;
}

/**
 * Prompt item with all properties for display and editing
 */
export interface PromptStep {
  /** Index in the prompts array */
  index: number;
  /** The prompt text */
  text: string;
  /** Current execution status */
  status: StepStatus;
  /** Execution details (output, errors, etc.) */
  details: PromptDetails;
  /** Harness override */
  harness?: string;
  /** Model override */
  model?: string;
  /** Agent file path */
  agent?: string | null;
  /** Skill names to attach (progressive disclosure) */
  skills?: string[] | null;
  /** Whether to resume previous session */
  resumeSession?: boolean;
  /** Specific session ID to use */
  sessionId?: string | number;
  /** MCP servers to attach for this prompt */
  mcpServers?: (string | object)[] | null;
  /** User hooks configuration */
  hooks?: object[] | null;
  /** End condition configuration */
  endCondition?: EndCondition | null;
  /** Runtime metadata from execution */
  _runtime?: PromptRuntime;
}

/**
 * Create a prompt item with all properties preserved
 * Used when loading workflows, restoring sessions, or extending the queue
 *
 * @param prompt - Raw prompt object or string from workflow file
 * @param index - Index in the prompts array
 * @param status - Initial step status (defaults to pending)
 * @param details - Additional execution details
 * @returns Fully populated PromptStep
 *
 * @example
 * // From string prompt
 * createPromptStep("Analyze the code", 0)
 *
 * // From object prompt
 * createPromptStep({ prompt: "Fix bugs", model: "gpt-5" }, 1)
 *
 * // With status and details
 * createPromptStep(prompt, 2, "completed", { elapsed: 5000 })
 */
export function createPromptStep(
  prompt: RawPrompt | string,
  index: number,
  status: StepStatus = STEP_STATUS.PENDING,
  details: PromptDetails = {}
): PromptStep {
  // Handle string prompts
  if (typeof prompt === "string") {
    return {
      index,
      text: prompt,
      status,
      details,
      harness: undefined,
      model: undefined,
      agent: undefined,
      resumeSession: undefined,
      sessionId: undefined,
      mcpServers: undefined,
      hooks: undefined,
      endCondition: undefined,
    };
  }

  // Handle object prompts - preserve all properties
  return {
    index,
    text: prompt.prompt,
    status,
    details,
    harness: prompt.harness,
    model: prompt.model,
    agent: prompt.agent,
    skills: prompt.skills,
    resumeSession: prompt.resumeSession,
    sessionId: prompt.sessionId,
    mcpServers: prompt.mcpServers,
    hooks: (prompt as any).hooks,
    endCondition: prompt.endCondition,
    _runtime: prompt._runtime,
  };
}

/**
 * Convert PromptStep back to raw format for saving
 * Only includes properties that are defined
 *
 * @param item - PromptStep to convert
 * @returns Raw prompt object suitable for workflow file
 */
export function promptStepToRaw(item: PromptStep): RawPrompt {
  const raw: RawPrompt = {
    prompt: item.text,
  };

  // Only include defined optional properties
  if (item.harness !== undefined) raw.harness = item.harness;
  if (item.model !== undefined) raw.model = item.model;
  if (item.agent !== undefined) raw.agent = item.agent;
  if (item.skills !== undefined) raw.skills = item.skills;
  if (item.resumeSession !== undefined) raw.resumeSession = item.resumeSession;
  if (item.sessionId !== undefined) raw.sessionId = item.sessionId;
  if (item.mcpServers !== undefined) raw.mcpServers = item.mcpServers;
  if (item.hooks !== undefined) raw.hooks = item.hooks;
  if (item.endCondition !== undefined) raw.endCondition = item.endCondition;
  if (item._runtime !== undefined) raw._runtime = item._runtime;

  return raw;
}

/**
 * Check if a prompt has been executed (completed or failed)
 */
export function isPromptExecuted(item: PromptStep): boolean {
  return (
    item.status === STEP_STATUS.COMPLETED || item.status === STEP_STATUS.FAILED
  );
}

/**
 * Check if a prompt is currently running
 */
export function isPromptRunning(item: PromptStep): boolean {
  return (
    item.status === STEP_STATUS.RUNNING || item.status === STEP_STATUS.SENT
  );
}

/**
 * Check if a prompt is pending (not yet started)
 */
export function isPromptPending(item: PromptStep): boolean {
  return item.status === STEP_STATUS.PENDING;
}

/**
 * Get display-friendly label for a prompt
 * Uses first line truncated, or "Prompt N" fallback
 *
 * @param item - Prompt item
 * @param maxLength - Maximum label length
 * @returns Display label
 */
export function getPromptLabel(
  item: PromptStep,
  maxLength: number = 50
): string {
  if (!item.text) {
    return `Prompt ${item.index + 1}`;
  }

  // Get first line
  const firstLine = item.text.split("\n")[0].trim();

  if (!firstLine) {
    return `Prompt ${item.index + 1}`;
  }

  // Truncate if needed
  if (firstLine.length > maxLength) {
    return firstLine.substring(0, maxLength - 3) + "...";
  }

  return firstLine;
}
