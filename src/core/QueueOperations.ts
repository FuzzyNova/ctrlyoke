/**
 * Shared queue operations for ctrlyoke MCP server and Language Model Tools
 * Single source of truth for queue status and append operations
 * Used by:
 * 1. MCP server (CLI integration)
 * 2. VS Code Language Model Tools (Chat integration)
 * 3. Queue Next/End commands (user actions)
 */

import { PromptQueue } from "./PromptQueue";
import {
  PromptStep,
  EndCondition,
  isScriptStep,
} from "../types/CtrlYokeTypes";
import {
  EXECUTION_STATES,
  QUEUE_POSITION,
  STEP_STATUS,
  type HarnessId,
  type QueuePosition,
} from "../types/DashboardConstants";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";

/**
 * Queue status response (single source for both MCP and Language Model Tools)
 */
export interface QueueStatusResponse {
  metadata: {
    workflowName: string | null;
    harness: string | null;
    model: string | null;
    currentIndex: number;
    totalSteps: number;
    completedSteps: number;
    executionState: string;
    maxQueueSize: number;
    remainingSlots: number;
    workingFile: string | null;
  };
  steps: Array<{
    index: number;
    prompt: string;
    status: string;
    model?: string;
    retryCount?: number;
  }>;
}

/**
 * Read output request (single source for both MCP and Language Model Tools)
 */
export interface ReadOutputRequest {
  /** Zero-based indices of prompts to read. Omit or empty to read all. */
  indices?: number[];
}

/**
 * Read output response (single source for both MCP and Language Model Tools)
 */
export interface ReadOutputResponse {
  outputs: Array<{
    index: number;
    prompt: string;
    status: string;
    responseText: string | null;
  }>;
}

/**
 * Append steps request (single source for both MCP and Language Model Tools)
 */
export interface AppendStepsRequest {
  steps: Array<{
    prompt: string;
    model?: string;
    harness?: string;
    resumeSession?: boolean;
    sessionId?: number;
    endCondition?: EndCondition;
  }>;
  position: QueuePosition;
  source: string;
}

/**
 * Append steps response (single source for both MCP and Language Model Tools)
 */
export interface AppendStepsResponse {
  success: boolean;
  stepsAdded: number;
  newQueueSize: number;
  insertIndex: number;
  workingFile: string | null;
}

/**
 * Get comprehensive queue status including metadata and all steps
 * Single-sourced logic used by MCP server and Language Model Tools
 * @param queue The PromptQueue instance
 * @param workingFilePath Optional working file path (from queue state or external)
 * @returns Queue status with metadata and all steps
 */
export function getQueueStatus(
  queue: PromptQueue,
  workingFilePath?: string
): QueueStatusResponse {
  const state = queue.getState();
  const runtime = queue.getRuntimeStateMachine();

  // Get queue size limits from settings
  const queueConfig = ConfigurationUtils.getDynamicQueueConfig();
  const maxQueueSize = queueConfig.maxQueueSize;
  const unlimitedMode = queueConfig.unlimitedMode;

  const remainingSlots = unlimitedMode
    ? Infinity
    : Math.max(0, maxQueueSize - state.steps.length);

  // Extract workflow name from working file path if available
  let workflowName: string | null = null;
  if (workingFilePath || state.workingFilePath) {
    const filePath = workingFilePath || state.workingFilePath!;
    const fileName = filePath.split(/[/\\]/).pop() || "";
    // Remove timestamp and extension: "workflow-2024-12-23T15-30-00.ctrlyoke.json" -> "workflow"
    workflowName = fileName
      .replace(/\.ctrlyoke\.json$/, "")
      .replace(/-\d{4}-\d{2}-\d{2}T.*$/, "");
  }

  const workflowFile = queue.getWorkflowFile();

  return {
    metadata: {
      workflowName,
      harness: workflowFile.harness ?? null,
      model: workflowFile.model ?? null,
      currentIndex: state.currentIndex,
      totalSteps: state.steps.length,
      completedSteps: state.results.filter(
        (r) => r.status === STEP_STATUS.COMPLETED
      ).length,
      executionState: runtime.status,
      maxQueueSize: unlimitedMode ? 0 : maxQueueSize, // 0 means unlimited
      remainingSlots: remainingSlots === Infinity ? 0 : remainingSlots,
      workingFile: state.workingFilePath || null,
    },
    steps: state.steps.map((p, index) => ({
      index,
      prompt: isScriptStep(p) ? p.script : p.prompt,
      status: state.results[index]?.status || STEP_STATUS.PENDING,
      model: isScriptStep(p) ? undefined : p.model,
      retryCount: state.results[index]?.retryCount,
    })),
  };
}

/**
 * Read AI response text from completed prompts
 * Single-sourced logic used by MCP server and Language Model Tools
 * @param queue The PromptQueue instance
 * @param request Indices to read (empty/undefined = all prompts)
 * @returns Output entries for each requested prompt
 */
export function readQueueOutput(
  queue: PromptQueue,
  request: ReadOutputRequest
): ReadOutputResponse {
  const state = queue.getState();
  const allSteps = state.steps;

  const indices =
    !request.indices || request.indices.length === 0
      ? allSteps.map((_, i) => i)
      : request.indices;

  const outputs = indices
    .filter((i) => i >= 0 && i < allSteps.length)
    .map((i) => {
      const step = allSteps[i];
      const result = state.results[i];
      return {
        index: i,
        prompt: isScriptStep(step) ? step.script : step.prompt,
        status: result?.status || STEP_STATUS.PENDING,
        responseText: step._runtime?.responseText ?? null,
      };
    });

  return { outputs };
}

/**
 * Append steps to the queue with position control (next or end)
 * Single-sourced logic used by MCP server, Language Model Tools, and Queue commands
 * @param queue The PromptQueue instance
 * @param request The append request with steps, position, and source
 * @returns Append response with success status and new queue size
 * @throws Error if queue cannot accept appends or size limit exceeded
 */
export async function appendToQueue(
  queue: PromptQueue,
  request: AppendStepsRequest
): Promise<AppendStepsResponse> {
  // 1. Validate queue state
  if (!queue.canAppend()) {
    throw new Error("Cannot append: Queue is in cancelled or error state");
  }

  // 2. Check queue size limits
  const queueConfig = ConfigurationUtils.getDynamicQueueConfig();
  const maxQueueSize = queueConfig.maxQueueSize;
  const unlimitedMode = queueConfig.unlimitedMode;

  const state = queue.getState();
  const runtime = queue.getRuntimeStateMachine();
  const currentSize = state.steps.length;
  const newSize = currentSize + request.steps.length;

  if (!unlimitedMode && newSize > maxQueueSize) {
    throw new Error(
      `Queue size limit exceeded: ${newSize}/${maxQueueSize} steps. ` +
        `Enable unlimitedMode or increase maxQueueSize to proceed.`
    );
  }

  // 3. Convert request steps to PromptStep format
  const promptItems: PromptStep[] = request.steps.map((p) => ({
    prompt: p.prompt,
    model: p.model,
    harness: p.harness as HarnessId | undefined,
    resumeSession: p.resumeSession,
    sessionId: p.sessionId,
    endCondition: p.endCondition,
  }));

  // 4. Calculate insert index based on position
  const insertIndex =
    request.position === QUEUE_POSITION.NEXT
      ? state.currentIndex + 1
      : state.steps.length;

  if (runtime.status === EXECUTION_STATES.COMPLETED) {
    runtime.reopenForContinuation();
  }

  // 5. Append steps (PromptQueue now owns topology only)
  await queue.appendSteps(promptItems, request.source, request.position);

  // 6. Get updated state
  const updatedState = queue.getState();

  return {
    success: true,
    stepsAdded: request.steps.length,
    newQueueSize: updatedState.steps.length,
    insertIndex,
    workingFile: updatedState.workingFilePath || null,
  };
}
