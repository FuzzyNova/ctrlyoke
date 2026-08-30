/**
 * ctrlyoke MCP Server
 *
 * Provides queue management tools for Copilot CLI, Claude CLI, and Codex CLI.
 * Spawned as child process via stdio transport.
 *
 * Usage:
 *   node mcp-server.js
 *
 * Environment Variables:
 *   CTRLYOKE_WORKSPACE - Workspace root directory (defaults to cwd)
 */

// Use require with CJS paths - package.json has wildcard export "./*" mapping to "./dist/cjs/*"
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");
import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import type {
  PromptStep,
  WorkflowStep,
  WorkingFile,
  WorkingFileRuntime,
} from "./types/CtrlYokeTypes";
import { isScriptStep } from "./types/CtrlYokeTypes";
import {
  BOOLEAN_STRING_VALUES,
  EXECUTION_STATES,
  QUEUE_POSITION,
  type QueuePosition,
} from "./types/DashboardConstants";
import * as WorkflowPaths from "./utils/WorkflowPaths";
import { WorkflowLineageRepository } from "./core/orchestration/WorkflowLineageRepository";
import { RunContinuationService } from "./core/orchestration/RunContinuationService";
import { RunOutputResolver } from "./core/orchestration/RunOutputResolver";
import type { RunRef, WorkflowKey } from "./types/CtrlYokeTypes";
import { repoToplevel } from "./utils/GitUtils";
import {
  ProjectStateRegistry,
  getStateHomeWarning,
} from "./utils/ProjectStateRegistry";
import { ctrlyokeStateHome } from "./utils/ProjectStatePaths";
import {
  initializeRunHistoryLocation,
  parseRunHistoryLocation,
} from "./utils/RunHistoryStoragePolicy";
import {
  MCP_COMMIT_MESSAGE_TOOL_NAME,
  MCP_TOOL_DEFINITIONS,
} from "./utils/McpToolDefinitions";

export { MCP_TOOL_DEFINITIONS } from "./utils/McpToolDefinitions";

// Path constants (must match ConfigurationUtils.PATH_CONSTANTS)
const CTRLYOKE_DIR = ".ctrlyoke";
const LOGS_DIR = "logs";
const CAPABILITIES_FILE = "capabilities.json";

const lineageRepository = new WorkflowLineageRepository();

// Initialize log file only when diagnostic logging is explicitly enabled.
// CTRLYOKE_DIAGNOSTIC_LOGS=true is passed by the extension when
// ctrlyoke.enableDiagnosticLogs is on. NODE_ENV=development enables it in dev.
const workspaceRoot = process.env.CTRLYOKE_WORKSPACE || process.cwd();
const diagnosticLogsEnabled =
  process.env.CTRLYOKE_DIAGNOSTIC_LOGS === BOOLEAN_STRING_VALUES.TRUE ||
  process.env.NODE_ENV === "development";

let logFile: string | null = null;
if (diagnosticLogsEnabled) {
  const logDir = path.join(workspaceRoot, CTRLYOKE_DIR, LOGS_DIR);
  try {
    fsSync.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, `ctrlyoke-mcp-${Date.now()}.log`);
  } catch {
    // Proceed without file logging if directory creation fails
  }
}

/**
 * Log to file (TUI captures stderr, so we write to .ctrlyoke/logs/).
 * No-op when diagnostic logging is disabled.
 */
function log(...args: any[]) {
  if (!logFile) {
    return;
  }
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args
    .map((arg) =>
      typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
    )
    .join(" ")}\n`;

  try {
    fsSync.appendFileSync(logFile, message, "utf8");
  } catch {
    // Ignore file write errors silently
  }
}

/**
 * ctrlyoke MCP Server
 * Provides tools for AI agents to read and extend workflow queues
 */
/**
 * Read queue size limit from environment (set by the extension via MCP config env vars).
 * Falls back to 100 if not set. A value of 0 or CTRLYOKE_UNLIMITED_MODE=true means no limit.
 */
function getMaxQueueSize(): number {
  const envValue = process.env.CTRLYOKE_MAX_QUEUE_SIZE;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 100; // Default, matches package.json default
}

function isUnlimitedMode(): boolean {
  return process.env.CTRLYOKE_UNLIMITED_MODE === BOOLEAN_STRING_VALUES.TRUE;
}

export class CtrlYokeMCPServer {
  private server: InstanceType<typeof Server>;
  private workspaceRoot: string;
  private operationQueue: Promise<any> = Promise.resolve();

  constructor(options: { workspaceRoot?: string } = {}) {
    this.workspaceRoot =
      options.workspaceRoot || process.env.CTRLYOKE_WORKSPACE || process.cwd();
    log("MCP Server initializing...");
    log("Workspace root:", this.workspaceRoot);
    log("Environment variables:", {
      CTRLYOKE_WORKSPACE: process.env.CTRLYOKE_WORKSPACE,
      CTRLYOKE_WORKING_FILE:
        process.env.CTRLYOKE_WORKING_FILE ||
        "(not set — workflow tools will refuse to run)",
      CTRLYOKE_HOME: process.env.CTRLYOKE_HOME || "(default)",
      CTRLYOKE_RUN_HISTORY_LOCATION:
        process.env.CTRLYOKE_RUN_HISTORY_LOCATION || "(default: user)",
      CTRLYOKE_MAX_QUEUE_SIZE:
        process.env.CTRLYOKE_MAX_QUEUE_SIZE || "(not set — default 100)",
      CTRLYOKE_UNLIMITED_MODE:
        process.env.CTRLYOKE_UNLIMITED_MODE || "(not set — default false)",
      NODE_ENV: process.env.NODE_ENV,
    });

    this.server = new Server(
      {
        name: "ctrlyoke",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    log("MCP Server handlers registered");
  }

  public getToolDefinitions() {
    return MCP_TOOL_DEFINITIONS;
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      log("ListTools request received");
      return {
        tools: this.getToolDefinitions(),
      };
    });

    // Handle tool invocations
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: any) => {
        const { name, arguments: args } = request.params;
        log("\n=== Tool Invocation ===");
        log("Tool name:", name);
        log("Arguments:", JSON.stringify(args, null, 2));

        try {
          return await this.invokeTool(name, args);
        } catch (error: any) {
          log("ERROR in tool invocation:", error);
          log("Error stack:", error.stack);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error.message}`,
              },
            ],
            isError: true,
          };
        }
      }
    );
  }

  /** Dispatch one tool without transport error wrapping; useful to embedders and focused tests. */
  public async invokeTool(name: string, args: unknown): Promise<unknown> {
    switch (name) {
      case "ctrlyoke_queue_status":
        return this.handleQueueStatus();
      case "ctrlyoke_append_queue":
        return this.queueOperation(() => this.handleQueueAppend(args));
      case "ctrlyoke_capabilities":
        return this.handleCapabilities();
      case "ctrlyoke_read_output":
        return this.handleReadOutput(args);
      case "ctrlyoke_global_status":
        return this.handleGlobalStatus(args);
      case MCP_COMMIT_MESSAGE_TOOL_NAME:
        return this.handleSubmitCommitMessage(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  /**
   * Queue an operation to prevent race conditions
   * All append operations are serialized through this queue
   */
  private async queueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previousOperation = this.operationQueue;
    let release: () => void;

    // Gate promise always resolves (never rejects) so that:
    //   1. Subsequent operations are never blocked by a previous failure.
    //   2. There is no unhandled promise rejection that would crash the process.
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      // Wait for the previous operation to complete (ignoring its outcome)
      await previousOperation;
      log("Operation started (previous operations completed)");

      // Execute the current operation
      const result = await operation();
      release!();
      return result;
    } catch (error) {
      release!(); // Always unblock the queue, even on failure
      throw error;
    }
  }

  /**
   * Handle ctrlyoke_queue_status tool invocation
   * Returns comprehensive queue state including metadata and all prompts
   */
  private async handleQueueStatus() {
    const selected = await this.resolveRun("queue_status");
    const workingFile = selected.filePath;

    const fileContent = await fs.readFile(workingFile, "utf8");
    const queueData: WorkingFile = JSON.parse(fileContent);

    const runtime = queueData._runtime || {
      currentIndex: 0,
      executionState: EXECUTION_STATES.IDLE,
    };

    const allSteps = (queueData.steps || []) as WorkflowStep[];
    const steps = allSteps.map((p, index) => ({
      index,
      prompt: isScriptStep(p) ? `(script) ${p.script}` : p.prompt,
      status: this.getStepStatus(index, runtime, allSteps),
      model: isScriptStep(p) ? undefined : p.model,
    }));

    const completedCount = allSteps.filter(
      (p) => p._runtime?.completedAt !== undefined
    ).length;

    const unlimited = isUnlimitedMode();
    const maxSize = getMaxQueueSize();

    const response = {
      workflowKey: selected.workflowKey,
      runRef: selected.runRef,
      metadata: {
        workflowKey: selected.workflowKey,
        runRef: selected.runRef,
        workflowName: queueData.workflowName,
        harness: queueData.harness ?? null,
        model: queueData.model ?? null,
        currentIndex: runtime.currentIndex,
        totalSteps: allSteps.length,
        completedSteps: completedCount,
        executionState: runtime.executionState,
        maxQueueSize: unlimited ? "unlimited" : maxSize,
        remainingSlots: unlimited ? "unlimited" : maxSize - allSteps.length,
        workingFile: path.relative(this.workspaceRoot, workingFile),
        definitionRevision: queueData.definitionRevision ?? 1,
        descriptorRevision: selected.descriptorRevision,
      },
      steps,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  /**
   * Handle ctrlyoke_append_queue tool invocation.
   * Adds prompts to this server's own run with position control. The target is
   * never taken from the arguments — see `resolveRun`.
   */
  private async handleQueueAppend(args: any) {
    log("Processing append_queue request...");
    const {
      steps,
      position,
      source = "MCP Tool",
    } = args as {
      steps: Array<
        PromptStep & {
          resumeSession?: boolean;
          sessionId?: number;
          harness?: string;
        }
      >;
      position: QueuePosition;
      source?: string;
    };

    log("Parsed arguments:", {
      stepCount: steps?.length || 0,
      position,
      source,
    });

    // Validate inputs
    if (!Array.isArray(steps) || steps.length === 0) {
      log("ERROR: Invalid steps array", steps);
      throw new Error("steps must be a non-empty array");
    }

    if (position !== QUEUE_POSITION.NEXT && position !== QUEUE_POSITION.END) {
      log("ERROR: Invalid position:", position);
      throw new Error(
        `position must be '${QUEUE_POSITION.NEXT}' or '${QUEUE_POSITION.END}'`
      );
    }

    const selected = await this.resolveRun("append_queue");
    const target = await RunContinuationService.validateContinuationTarget(
      this.workspaceRoot,
      selected.workflowKey,
      selected.runRef,
      lineageRepository,
      "append",
      true
    );

    // Validate harness/model against capabilities.json (best-effort: skip if file absent)
    const capabilities = await this.readCapabilities();
    if (capabilities) {
      for (const p of steps) {
        const promptHarness = p.harness;
        const promptModel = p.model;
        if (promptHarness) {
          const harnessEntry = capabilities.harnesses.find(
            (h: any) => h.id === promptHarness
          );
          if (!harnessEntry) {
            const available = capabilities.harnesses
              .filter((h: any) => h.available)
              .map((h: any) => h.id)
              .join(", ");
            throw new Error(
              `Invalid harness '${promptHarness}'. Available harnesses: ${available || "(none)"}`
            );
          }
          if (promptModel && harnessEntry.models.length > 0) {
            const modelValues = harnessEntry.models.map((m: any) => m.value);
            if (!modelValues.includes(promptModel)) {
              throw new Error(
                `Invalid model '${promptModel}' for harness '${promptHarness}'. Valid models: ${modelValues.join(", ")}`
              );
            }
          }
        }
      }
    }

    let response: {
      success: boolean;
      stepsAdded: number;
      stepsRejected: number;
      newQueueSize: number;
      insertIndex: number;
      workingFile: string;
      workflowKey: WorkflowKey;
      runRef: RunRef;
      definitionRevision: number;
      descriptorRevision: number;
      rejectionDetails?: Array<{
        prompt: string;
        name?: string;
        reason?: string;
      }>;
    } | null = null;

    {
      const queueData: WorkingFile = JSON.parse(
        await fs.readFile(selected.filePath, "utf8")
      );
      log("Current queue size:", queueData.steps?.length || 0);

      // Validate prompts (check for already-completed only)
      log("Starting deduplication validation...");
      const validationResults = this.validatePrompts(
        steps,
        (queueData.steps || []) as WorkflowStep[]
      );
      log("Validation results:", validationResults);

      const validPrompts = validationResults
        .filter((r) => r.accepted)
        .map((r) => r.prompt);
      const rejectedPrompts = validationResults.filter((r) => !r.accepted);

      if (validPrompts.length === 0) {
        log("All prompts rejected, returning error response");
        const rejectionReasons = rejectedPrompts
          .map((r) => `"${r.prompt.prompt.substring(0, 50)}...": ${r.reason}`)
          .join("; ");
        throw new Error(
          `All ${steps.length} prompts rejected. Reasons: ${rejectionReasons}`
        );
      }

      // Validate queue size limit (only for prompts that will actually be added)
      const unlimited = isUnlimitedMode();
      const maxQueueSize = getMaxQueueSize();
      const newTotalSize = (queueData.steps || []).length + validPrompts.length;
      log("Queue size check:", {
        current: (queueData.steps || []).length,
        adding: validPrompts.length,
        rejected: rejectedPrompts.length,
        newTotal: newTotalSize,
        max: unlimited ? "unlimited" : maxQueueSize,
      });

      if (!unlimited && newTotalSize > maxQueueSize) {
        throw new Error(
          `Queue size limit exceeded. Current: ${(queueData.steps || []).length}, Adding: ${validPrompts.length}, Max: ${maxQueueSize}`
        );
      }

      const appended = await RunContinuationService.appendStepsToRun(
        this.workspaceRoot,
        selected.workflowKey,
        selected.runRef,
        validPrompts,
        target.definitionRevision,
        lineageRepository,
        target.allowInterruptedRun,
        position
      );

      response = {
        success: true,
        stepsAdded: validPrompts.length,
        stepsRejected: rejectedPrompts.length,
        newQueueSize: appended.workingFile.steps?.length ?? 0,
        // Resolved inside the run-file lock; with 'next' it can differ from the
        // caller's view if the run advanced between its status read and this write.
        insertIndex: appended.insertIndex,
        workingFile: path.relative(this.workspaceRoot, selected.filePath),
        workflowKey: selected.workflowKey,
        runRef: selected.runRef,
        definitionRevision: appended.definitionRevision,
        descriptorRevision: appended.descriptorRevision,
        ...(rejectedPrompts.length > 0 && {
          rejectionDetails: rejectedPrompts.map((r) => ({
            prompt:
              r.prompt.prompt.substring(0, 100) +
              (r.prompt.prompt.length > 100 ? "..." : ""),
            name: r.prompt.name,
            reason: r.reason,
          })),
        }),
      };
    }

    if (!response) {
      throw new Error("Failed to append steps: no response generated");
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  /**
   * Read and parse .ctrlyoke/capabilities.json.
   * Returns null if the file does not exist or cannot be parsed.
   */
  private async readCapabilities(): Promise<any | null> {
    const capabilitiesPath = path.join(
      this.workspaceRoot,
      CTRLYOKE_DIR,
      CAPABILITIES_FILE
    );
    try {
      const content = await fs.readFile(capabilitiesPath, "utf8");
      return JSON.parse(content);
    } catch {
      return null;
    }
  }

  /**
   * Handle ctrlyoke_capabilities tool invocation.
   * Returns available harnesses and their supported models.
   */
  private async handleCapabilities() {
    const capabilities = await this.readCapabilities();

    if (!capabilities) {
      throw new Error(
        "capabilities.json not found. Start a workflow in VS Code first to initialize harness detection."
      );
    }

    // Filter to available harnesses only
    const availableHarnesses = (capabilities.harnesses as any[])
      .filter((h) => h.available)
      .map((h) => ({
        id: h.id,
        displayName: h.displayName,
        available: true,
        models: (h.models as any[]).map((m) => m.value),
      }));

    const response = {
      generatedAt: capabilities.generatedAt,
      harnesses: availableHarnesses,
    };

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(response, null, 2),
        },
      ],
    };
  }

  /**
   * Handle ctrlyoke_read_output tool invocation.
   * Returns AI response text from completed prompts.
   */
  private async handleReadOutput(args: any) {
    const selected = await this.resolveRun("read_output");
    const workingFile = selected.filePath;

    const fileContent = await fs.readFile(workingFile, "utf8");
    const queueData: WorkingFile = JSON.parse(fileContent);
    const allSteps = (queueData.steps || []) as WorkflowStep[];

    const runtime = queueData._runtime || {
      currentIndex: 0,
      executionState: EXECUTION_STATES.IDLE,
    };

    const requestedIndices: number[] =
      Array.isArray(args?.indices) && args.indices.length > 0
        ? args.indices
        : allSteps.map((_: any, i: number) => i);

    const resolver = new RunOutputResolver();
    const resolved = selected.runRef
      ? await resolver.resolveLatestAttempts(
          WorkflowPaths.manifestPath(
            this.workspaceRoot,
            selected.workflowKey,
            selected.runRef
          ),
          requestedIndices
            .filter((i) => i >= 0 && i < allSteps.length)
            .map((stepIndex) => ({ kind: "queue" as const, stepIndex }))
        )
      : new Map();
    const outputs = requestedIndices
      .filter((i) => i >= 0 && i < allSteps.length)
      .map((i) => {
        const p = allSteps[i];
        return {
          index: i,
          prompt: isScriptStep(p) ? `(script) ${p.script}` : p.prompt,
          status: this.getStepStatus(i, runtime, allSteps),
          responseText: resolved.get(`queue:${i}`)?.responseText ?? null,
        };
      });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              workflowKey: selected.workflowKey,
              runRef: selected.runRef,
              outputs,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  /**
   * Validate prompts before appending.
   * Only check 1 remains: reject prompts that have already been completed.
   * Completion is determined by per-prompt _runtime.completedAt (source of truth).
   */
  private validatePrompts(
    newPrompts: PromptStep[],
    existingPrompts: WorkflowStep[]
  ): Array<{ prompt: PromptStep; accepted: boolean; reason?: string }> {
    const results: Array<{
      prompt: PromptStep;
      accepted: boolean;
      reason?: string;
    }> = [];

    for (const newPrompt of newPrompts) {
      // Check 1: Already completed (per-prompt _runtime.completedAt is authoritative)
      const alreadyCompleted = existingPrompts.some(
        (p) =>
          p._runtime?.completedAt !== undefined &&
          !isScriptStep(p) &&
          p.prompt === newPrompt.prompt
      );

      if (alreadyCompleted) {
        results.push({
          prompt: newPrompt,
          accepted: false,
          reason: "Prompt already completed",
        });
        continue;
      }

      results.push({ prompt: newPrompt, accepted: true });
    }

    return results;
  }

  /**
   * Handle ctrlyoke_global_status tool invocation.
   * The only tool that reports on workflows other than this server's own, and
   * read-only by design: agents call it to learn what sibling workflows are
   * running so they can avoid file conflicts and attribute stray build errors.
   * Still requires an attached run — a process serving no workflow has no
   * business enumerating the workspace's workflows.
   */
  private async handleGlobalStatus(args: unknown) {
    log("Scanning run storage for all workflow lineages:", this.workspaceRoot);

    try {
      this.requireRunAddress("global_status");
      const selector = this.parseOtherWorkflowSelector(args, "global_status");
      const workflowKeys = selector.workflowKey
        ? [selector.workflowKey]
        : await lineageRepository.listLineageKeys(this.workspaceRoot);
      log("Found lineages:", workflowKeys.length);

      const workflows = await Promise.all(
        workflowKeys.map(async (workflowKey) => {
          let filePath: string;
          let runRef: RunRef | null;
          try {
            if (selector.runRef) {
              filePath = WorkflowPaths.runFilePath(
                this.workspaceRoot,
                workflowKey,
                selector.runRef
              );
              runRef = selector.runRef;
            } else {
              const descriptor = await lineageRepository.readDescriptor(
                this.workspaceRoot,
                workflowKey
              );
              runRef = descriptor.latestRunRef ?? null;
              filePath = runRef
                ? WorkflowPaths.runFilePath(
                    this.workspaceRoot,
                    workflowKey,
                    runRef
                  )
                : WorkflowPaths.draftFilePath(this.workspaceRoot, workflowKey);
            }
          } catch {
            return null;
          }
          try {
            const content = await fs.readFile(filePath, "utf8");
            const data: WorkingFile = JSON.parse(content);
            const runtime = data._runtime || {
              currentIndex: 0,
              executionState: EXECUTION_STATES.IDLE,
            };
            const allSteps = (data.steps || []) as WorkflowStep[];
            const completedCount = allSteps.filter(
              (p) => p._runtime?.completedAt !== undefined
            ).length;

            return {
              workflowKey,
              runRef,
              workflowName: data.workflowName,
              executionState: runtime.executionState,
              harness: data.harness ?? null,
              model: data.model ?? null,
              currentStep: runtime.currentIndex + 1,
              totalSteps: allSteps.length,
              completedSteps: completedCount,
              startedAt: data.startedAt ?? null,
              lastModifiedAt: data.lastModifiedAt ?? null,
              workingFile: path.relative(this.workspaceRoot, filePath),
              ...(runtime.worktree
                ? {
                    worktree: {
                      mode: runtime.worktree.mode,
                      branchName: runtime.worktree.branchName,
                      worktreePath: runtime.worktree.worktreePath,
                      lifecycleState: runtime.worktree.lifecycleState,
                      directoryState: runtime.worktree.directoryState,
                    },
                  }
                : {}),
              ...(runtime.worktreeNotice
                ? { worktreeNotice: runtime.worktreeNotice }
                : {}),
            };
          } catch {
            return null;
          }
        })
      );

      const validWorkflows = workflows.filter(
        (w): w is NonNullable<typeof w> => w !== null
      );

      const response = {
        workspaceRoot: this.workspaceRoot,
        workflowCount: validWorkflows.length,
        workflows: validWorkflows,
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    } catch (error: any) {
      if (error.code === "ENOENT") {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  workspaceRoot: this.workspaceRoot,
                  workflowCount: 0,
                  workflows: [],
                },
                null,
                2
              ),
            },
          ],
        };
      }
      throw error;
    }
  }

  /**
   * Handle ctrlyoke_submit_commit_message tool invocation.
   * Writes the commit message to the output path specified by CTRLYOKE_COMMIT_OUTPUT.
   * The CLI entrypoint can populate that variable from --commit-output.
   * Used exclusively by CommitMessageGenerator to capture the AI-generated commit message
   * as a structured tool argument rather than parsing prose response text.
   */
  private async handleSubmitCommitMessage(args: any) {
    const { message } = args as { message: string };
    if (!message?.trim()) {
      throw new Error("message is required and cannot be empty");
    }

    const outputPath = process.env.CTRLYOKE_COMMIT_OUTPUT;
    if (outputPath) {
      await fs.writeFile(outputPath, message.trim(), "utf8");
      log("Commit message written to:", outputPath);
    } else {
      log(
        "CTRLYOKE_COMMIT_OUTPUT not set — message captured but not persisted"
      );
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ success: true }),
        },
      ],
    };
  }

  /**
   * Optional narrowing filters for `ctrlyoke_global_status`. Both fields are
   * optional and neither can redirect any other tool — see `resolveRun`.
   */
  private parseOtherWorkflowSelector(
    args: unknown,
    operation: string
  ): { workflowKey?: WorkflowKey; runRef?: RunRef } {
    const value = (args ?? {}) as Record<string, unknown>;
    const workflowKey = value.workflowKey;
    const runRef = value.runRef;
    if (workflowKey !== undefined && typeof workflowKey !== "string") {
      throw new Error(`${operation}: workflowKey must be a string`);
    }
    if (runRef !== undefined && typeof runRef !== "string") {
      throw new Error(`${operation}: runRef must be a string`);
    }
    if (runRef !== undefined && workflowKey === undefined) {
      throw new Error(`${operation}: runRef requires workflowKey`);
    }
    if (workflowKey !== undefined)
      WorkflowPaths.assertValidWorkflowKey(workflowKey);
    if (runRef !== undefined) WorkflowPaths.assertValidRunRef(runRef);
    return {
      ...(workflowKey !== undefined && { workflowKey }),
      ...(runRef !== undefined && { runRef }),
    };
  }

  /**
   * The run this server exists to serve. ctrlyoke sets `CTRLYOKE_WORKING_FILE`
   * to the executing run's file whenever it launches a harness, and that is the
   * only supported way to run this server: it answers for one workflow run, so
   * a process without one has no workflow to answer for. No tool argument
   * participates in this — there is no addressing to get wrong or to abuse.
   */
  private requireRunAddress(operation: string): {
    workflowKey: WorkflowKey;
    runRef: RunRef;
  } {
    const pinnedPath = process.env.CTRLYOKE_WORKING_FILE;
    const address = pinnedPath
      ? WorkflowPaths.parseWorkingFileAddressFromPath(pinnedPath)
      : undefined;
    if (!address?.runRef) {
      throw new Error(
        `${operation}: no ctrlyoke workflow run is attached to this MCP server. It is launched by ctrlyoke for one run; to drive ctrlyoke from outside a workflow, use the ctrlyoke CLI.`
      );
    }
    return { workflowKey: address.workflowKey, runRef: address.runRef };
  }

  private async resolveRun(operation: string): Promise<{
    workflowKey: WorkflowKey;
    runRef: RunRef;
    filePath: string;
    descriptorRevision: number;
  }> {
    const { workflowKey, runRef } = this.requireRunAddress(operation);
    const filePath = WorkflowPaths.runFilePath(
      this.workspaceRoot,
      workflowKey,
      runRef
    );
    await fs.access(filePath);
    const descriptor = await lineageRepository.readDescriptor(
      this.workspaceRoot,
      workflowKey
    );
    return {
      workflowKey,
      runRef,
      filePath,
      descriptorRevision: descriptor.revision,
    };
  }

  /**
   * Determine step status based on per-step completedAt (source of truth)
   */
  private getStepStatus(
    index: number,
    runtime: WorkingFileRuntime,
    steps: WorkflowStep[]
  ): string {
    if (steps[index]?._runtime?.completedAt !== undefined) {
      return "completed";
    }
    if (index === runtime.currentIndex) {
      return "running";
    }
    if (index < runtime.currentIndex) {
      return "completed"; // Fallback for steps before current
    }
    return "pending";
  }

  /**
   * Start the MCP server with stdio transport
   */
  async start() {
    log("===================================");
    log("ctrlyoke MCP Server Starting");
    log("Log file:", logFile);
    log("Workspace:", this.workspaceRoot);
    log("===================================");
    log("Creating stdio transport...");
    const transport = new StdioServerTransport();
    log("Connecting server to transport...");
    await this.server.connect(transport);
    log("===================================");
    log("ctrlyoke MCP Server STARTED");
    log("Listening for tool requests...");
    log("===================================");
  }
}

/** Freeze and prepare the same project registry used by extension and CLI. */
export async function initializeMcpStorage(
  root = workspaceRoot
): Promise<void> {
  const location = parseRunHistoryLocation(
    process.env.CTRLYOKE_RUN_HISTORY_LOCATION
  );
  initializeRunHistoryLocation(location);
  const gitToplevel = await repoToplevel(root);
  const stateHomeWarning = getStateHomeWarning(
    ctrlyokeStateHome(),
    [root],
    gitToplevel ? [gitToplevel] : []
  );
  if (stateHomeWarning) {
    log(`WARNING: ${stateHomeWarning}`);
  }
  await new ProjectStateRegistry().initialize(root, gitToplevel ?? undefined);
}

interface McpToolCliOptions {
  tool: string;
  argsJson: string;
  workspace?: string;
  workingFile?: string;
  commitOutput?: string;
}

function parseMcpToolCliArgs(argv: readonly string[]): McpToolCliOptions {
  let tool: string | undefined;
  let argsJson = "{}";
  let workspace: string | undefined;
  let workingFile: string | undefined;
  let commitOutput: string | undefined;

  const readValue = (index: number, option: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${option} requires a value`);
    }
    return value;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    switch (option) {
      case "--tool":
        tool = readValue(index, option);
        index += 1;
        break;
      case "--args":
        argsJson = readValue(index, option);
        index += 1;
        break;
      case "--workspace":
        workspace = readValue(index, option);
        index += 1;
        break;
      case "--working-file":
        workingFile = readValue(index, option);
        index += 1;
        break;
      case "--commit-output":
        commitOutput = readValue(index, option);
        index += 1;
        break;
      default:
        throw new Error(`Unknown option: ${option}`);
    }
  }

  if (!tool) {
    throw new Error("--tool requires a tool name");
  }

  return { tool, argsJson, workspace, workingFile, commitOutput };
}

async function runMcpToolCli(argv: readonly string[]): Promise<void> {
  const options = parseMcpToolCliArgs(argv);

  if (options.workspace !== undefined) {
    process.env.CTRLYOKE_WORKSPACE = options.workspace;
  }
  if (options.workingFile !== undefined) {
    process.env.CTRLYOKE_WORKING_FILE = options.workingFile;
  }
  if (options.commitOutput !== undefined) {
    process.env.CTRLYOKE_COMMIT_OUTPUT = options.commitOutput;
  }

  await initializeMcpStorage(options.workspace ?? workspaceRoot);
  const result = await new CtrlYokeMCPServer({
    workspaceRoot: options.workspace,
  }).invokeTool(options.tool, JSON.parse(options.argsJson));
  const text = (result as { content?: Array<{ text?: unknown }> }).content?.[0]
    ?.text;
  if (typeof text !== "string") {
    throw new Error("MCP tool result did not contain text content");
  }
  process.stdout.write(`${text}\n`);
  process.exit(0);
}

if (require.main === module) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.includes("--tool")) {
    runMcpToolCli(cliArgs).catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`
      );
      process.exit(1);
    });
  } else {
    log("Initializing ctrlyoke MCP Server...");
    initializeMcpStorage()
      .then(() => new CtrlYokeMCPServer().start())
      .catch((error) => {
        log("FATAL ERROR: Failed to start MCP server");
        log("Error:", error);
        log("Stack:", error.stack);
        process.exit(1);
      });
  }
}
