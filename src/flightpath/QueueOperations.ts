/**
 * Shared queue operations for FlightPath MCP server and Language Model Tools
 * Single source of truth for queue status and append operations
 * Used by:
 * 1. MCP server (CLI integration)
 * 2. VS Code Language Model Tools (Chat integration)
 * 3. Queue Next/End commands (user actions)
 */

import { PromptQueue } from "./PromptQueue";
import {
  PromptItem,
  EndCondition,
  EXECUTION_STATES,
} from "../types/FlightPathTypes";
import {
  QUEUE_POSITION,
  type QueuePosition,
} from "../types/DashboardConstants";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import * as vscode from "vscode";

/**
 * Queue status response (single source for both MCP and Language Model Tools)
 */
export interface QueueStatusResponse {
  metadata: {
    workflowName: string | null;
    currentIndex: number;
    totalPrompts: number;
    completedPrompts: number;
    executionState: string;
    maxQueueSize: number;
    remainingSlots: number;
    workingFile: string | null;
  };
  prompts: Array<{
    index: number;
    prompt: string;
    status: string;
    model?: string;
    retryCount?: number;
  }>;
}

/**
 * Append prompts request (single source for both MCP and Language Model Tools)
 */
export interface AppendPromptsRequest {
  prompts: Array<{
    prompt: string;
    model?: string;
    endCondition?: EndCondition;
  }>;
  position: QueuePosition;
  source: string;
  reason?: string;
}

/**
 * Append prompts response (single source for both MCP and Language Model Tools)
 */
export interface AppendPromptsResponse {
  success: boolean;
  promptsAdded: number;
  newQueueSize: number;
  insertIndex: number;
  workingFile: string | null;
}

/**
 * Get comprehensive queue status including metadata and all prompts
 * Single-sourced logic used by MCP server and Language Model Tools
 * @param queue The PromptQueue instance
 * @param workingFilePath Optional working file path (from queue state or external)
 * @returns Queue status with metadata and all prompts
 */
export function getQueueStatus(
  queue: PromptQueue,
  workingFilePath?: string
): QueueStatusResponse {
  const state = queue.getState();

  // Get queue size limits from settings
  const queueConfig = ConfigurationUtils.getDynamicQueueConfig();
  const maxQueueSize = queueConfig.maxQueueSize;
  const unlimitedMode = queueConfig.unlimitedMode;

  const remainingSlots = unlimitedMode
    ? Infinity
    : Math.max(0, maxQueueSize - state.prompts.length);

  // Extract workflow name from working file path if available
  let workflowName: string | null = null;
  if (workingFilePath || state.workingFilePath) {
    const filePath = workingFilePath || state.workingFilePath!;
    const fileName = filePath.split(/[/\\]/).pop() || "";
    // Remove timestamp and extension: "workflow-2024-12-23T15-30-00.flightpath.json" -> "workflow"
    workflowName = fileName
      .replace(/\.flightpath\.json$/, "")
      .replace(/-\d{4}-\d{2}-\d{2}T.*$/, "");
  }

  return {
    metadata: {
      workflowName,
      currentIndex: state.currentIndex,
      totalPrompts: state.prompts.length,
      completedPrompts: state.results.filter((r) => r.status === "completed")
        .length,
      executionState: state.status,
      maxQueueSize: unlimitedMode ? 0 : maxQueueSize, // 0 means unlimited
      remainingSlots: remainingSlots === Infinity ? 0 : remainingSlots,
      workingFile: state.workingFilePath || null,
    },
    prompts: state.prompts.map((p, index) => ({
      index,
      prompt: p.prompt,
      status: state.results[index]?.status || "pending",
      model: p.model,
      retryCount: state.results[index]?.retryCount,
    })),
  };
}

/**
 * Append prompts to the queue with position control (next or end)
 * Single-sourced logic used by MCP server, Language Model Tools, and Queue commands
 * @param queue The PromptQueue instance
 * @param request The append request with prompts, position, and source
 * @returns Append response with success status and new queue size
 * @throws Error if queue cannot accept appends or size limit exceeded
 */
export async function appendToQueue(
  queue: PromptQueue,
  request: AppendPromptsRequest
): Promise<AppendPromptsResponse> {
  // 1. Validate queue state
  if (!queue.canAppend()) {
    throw new Error("Cannot append: Queue is in cancelled or error state");
  }

  // 2. Check queue size limits
  const queueConfig = ConfigurationUtils.getDynamicQueueConfig();
  const maxQueueSize = queueConfig.maxQueueSize;
  const unlimitedMode = queueConfig.unlimitedMode;

  const state = queue.getState();
  const currentSize = state.prompts.length;
  const newSize = currentSize + request.prompts.length;

  if (!unlimitedMode && newSize > maxQueueSize) {
    throw new Error(
      `Queue size limit exceeded: ${newSize}/${maxQueueSize} prompts. ` +
        `Enable unlimitedMode or increase maxQueueSize to proceed.`
    );
  }

  // 3. Convert request prompts to PromptItem format
  const promptItems: PromptItem[] = request.prompts.map((p) => ({
    prompt: p.prompt,
    model: p.model,
    endCondition: p.endCondition,
  }));

  // 4. Calculate insert index based on position
  const insertIndex =
    request.position === QUEUE_POSITION.NEXT
      ? state.currentIndex + 1
      : state.prompts.length;

  // 5. Append prompts (PromptQueue.appendPrompts now supports position)
  await queue.appendPrompts(promptItems, request.source, request.position);

  // 6. Get updated state
  const updatedState = queue.getState();

  return {
    success: true,
    promptsAdded: request.prompts.length,
    newQueueSize: updatedState.prompts.length,
    insertIndex,
    workingFile: updatedState.workingFilePath || null,
  };
}
