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
  EXECUTION_STATES,
  QUEUE_POSITION,
  type QueuePosition,
} from "./types/DashboardConstants";
import * as WorkflowPaths from "./utils/WorkflowPaths";
import { WorkflowLineageRepository } from "./core/orchestration/WorkflowLineageRepository";
import { RunContinuationService } from "./core/orchestration/RunContinuationService";
import { RunOutputResolver } from "./core/orchestration/RunOutputResolver";
import type { RunRef, WorkflowKey } from "./types/CtrlYokeTypes";

// Path constants (must match ConfigurationUtils.PATH_CONSTANTS)
const CTRLYOKE_DIR = ".ctrlyoke";
const LOGS_DIR = "logs";
const CAPABILITIES_FILE = "capabilities.json";

const lineageRepository = new WorkflowLineageRepository();

const runSelectorProperties = {
  workflowKey: {
    type: "string",
    description:
      "Stable workflow lineage key. Provide with runRef to target one promoted run.",
  },
  runRef: {
    type: "string",
    description:
      "Stable promoted-run reference. Requires workflowKey; never use a display index.",
  },
};

// Initialize log file only when diagnostic logging is explicitly enabled.
// CTRLYOKE_DIAGNOSTIC_LOGS=true is passed by the extension when
// ctrlyoke.enableDiagnosticLogs is on. NODE_ENV=development enables it in dev.
const workspaceRoot = process.env.CTRLYOKE_WORKSPACE || process.cwd();
const diagnosticLogsEnabled =
  process.env.CTRLYOKE_DIAGNOSTIC_LOGS === "true" ||
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
  return process.env.CTRLYOKE_UNLIMITED_MODE === "true";
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
        "(not set — will scan working dir)",
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
    return [
      {
        name: "ctrlyoke_queue_status",
        description:
          "Get status for one promoted ctrlyoke run. Provide workflowKey and runRef to inspect a historical run; with no selector, CTRLYOKE_WORKING_FILE must pin one exact promoted run.",
        inputSchema: {
          type: "object",
          properties: runSelectorProperties,
        },
      },
      {
        name: "ctrlyoke_append_queue",
        description: `Append a runtime-free tail to one promoted ctrlyoke run. Target with workflowKey and runRef, or rely only on an exact CTRLYOKE_WORKING_FILE pin. This follows lineage lock and revision rules; '${QUEUE_POSITION.NEXT}' is not supported for addressed continuation appends.`,
        inputSchema: {
          type: "object",
          properties: {
            ...runSelectorProperties,
            expectedDefinitionRevision: {
              type: "number",
              description:
                "Optional definition revision returned by queue_status; rejects stale writes deterministically.",
            },
            expectedDescriptorRevision: {
              type: "number",
              description:
                "Optional descriptor revision returned by queue_status; rejects stale writes deterministically.",
            },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  prompt: {
                    type: "string",
                    description: "The prompt text to add",
                  },
                  model: {
                    type: "string",
                    description: "Optional model override",
                  },
                  harness: {
                    type: "string",
                    description: "Optional harness override",
                  },
                  resumeSession: { type: "boolean" },
                  sessionId: { type: "number" },
                },
                required: ["prompt"],
              },
              description: "Non-empty runtime-free tail to append.",
            },
            position: {
              type: "string",
              enum: [QUEUE_POSITION.END],
              description: `Must be '${QUEUE_POSITION.END}' so the selected run's executed prefix remains immutable.`,
            },
            source: {
              type: "string",
              description: "Optional source identifier",
            },
          },
          required: ["steps", "position"],
        },
      },
      {
        name: "ctrlyoke_capabilities",
        description:
          "Get available harnesses and their supported models on this machine. Call this before appending prompts with harness or model overrides to ensure you use valid values. Returns only harnesses that are installed and detected as available.",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "ctrlyoke_read_output",
        description:
          "Read response text from one promoted ctrlyoke run without rebinding an executor. workflowKey/runRef can select historical output.",
        inputSchema: {
          type: "object",
          properties: {
            ...runSelectorProperties,
            indices: {
              type: "array",
              items: { type: "number" },
              description:
                "Zero-based indices; omit or pass [] for all prompts.",
            },
          },
        },
      },
      {
        name: "ctrlyoke_global_status",
        description:
          "List current workflow addresses, or select a lineage/current run with workflowKey and an exact historical run with workflowKey/runRef.",
        inputSchema: {
          type: "object",
          properties: runSelectorProperties,
        },
      },
      {
        name: "ctrlyoke_submit_commit_message",
        description:
          "Submit the generated commit message to ctrlyoke. Call this tool with the complete commit message text once you have composed it. Only call this tool when explicitly instructed to do so.",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "The complete commit message",
            },
          },
          required: ["message"],
        },
      },
    ];
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
        return this.handleQueueStatus(args);
      case "ctrlyoke_append_queue":
        return this.queueOperation(() => this.handleQueueAppend(args));
      case "ctrlyoke_capabilities":
        return this.handleCapabilities();
      case "ctrlyoke_read_output":
        return this.handleReadOutput(args);
      case "ctrlyoke_global_status":
        return this.handleGlobalStatus(args);
      case "ctrlyoke_submit_commit_message":
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
  private async handleQueueStatus(args: unknown) {
    const selected = await this.resolveSelectedRun(args, "queue_status");
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
   * Handle ctrlyoke_append_queue tool invocation
   * Appends prompts to the queue with position control
   */
  private async handleQueueAppend(args: any) {
    log("Processing append_queue request...");
    const {
      steps,
      position,
      source = "MCP Tool",
      expectedDefinitionRevision,
      expectedDescriptorRevision,
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
      expectedDefinitionRevision?: number;
      expectedDescriptorRevision?: number;
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

    if (position !== QUEUE_POSITION.END) {
      log("ERROR: Invalid position:", position);
      throw new Error(
        `position must be '${QUEUE_POSITION.END}' for an addressed append`
      );
    }

    const selected = await this.resolveSelectedRun(args, "append_queue");
    const target = await RunContinuationService.validateContinuationTarget(
      this.workspaceRoot,
      selected.workflowKey,
      selected.runRef,
      lineageRepository,
      "append",
      true
    );
    if (
      expectedDefinitionRevision !== undefined &&
      expectedDefinitionRevision !== target.definitionRevision
    ) {
      throw new Error(
        `Definition revision conflict: expected ${expectedDefinitionRevision}, found ${target.definitionRevision}`
      );
    }
    if (
      expectedDescriptorRevision !== undefined &&
      expectedDescriptorRevision !== target.descriptorRevision
    ) {
      throw new Error(
        `Descriptor revision conflict: expected ${expectedDescriptorRevision}, found ${target.descriptorRevision}`
      );
    }

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

      const insertIndex = (queueData.steps || []).length;

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

      const appended = await RunContinuationService.appendTailToRun(
        this.workspaceRoot,
        selected.workflowKey,
        selected.runRef,
        validPrompts,
        target.definitionRevision,
        target.descriptorRevision,
        lineageRepository,
        target.allowInterruptedRun
      );

      response = {
        success: true,
        stepsAdded: validPrompts.length,
        stepsRejected: rejectedPrompts.length,
        newQueueSize: appended.workingFile.steps?.length ?? 0,
        insertIndex,
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
    const selected = await this.resolveSelectedRun(args, "read_output");
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
   * Returns the status of every workflow in the workspace queue — not just the
   * current one. Agents should call this at session start to understand what
   * other workflows are running so they can avoid file conflicts and ignore
   * errors caused by sibling workflows.
   */
  private async handleGlobalStatus(args: unknown) {
    log("Scanning .runs/ for all workflow lineages:", this.workspaceRoot);

    try {
      const selector = this.parseSelector(args, "global_status", true);
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

  private parseSelector(
    args: unknown,
    operation: string,
    allowWorkflowOnly: boolean = false
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
    if (
      !allowWorkflowOnly &&
      (workflowKey === undefined) !== (runRef === undefined)
    ) {
      throw new Error(
        `${operation}: workflowKey and runRef must be provided together`
      );
    }
    if (workflowKey !== undefined)
      WorkflowPaths.assertValidWorkflowKey(workflowKey);
    if (runRef !== undefined) WorkflowPaths.assertValidRunRef(runRef);
    return {
      ...(workflowKey !== undefined && { workflowKey }),
      ...(runRef !== undefined && { runRef }),
    };
  }

  private async resolveSelectedRun(
    args: unknown,
    operation: string
  ): Promise<{
    workflowKey: WorkflowKey;
    runRef: RunRef;
    filePath: string;
    descriptorRevision: number;
  }> {
    const selector = this.parseSelector(args, operation);
    const pinnedPath = process.env.CTRLYOKE_WORKING_FILE;
    const pinnedAddress = pinnedPath
      ? WorkflowPaths.parseWorkingFileAddressFromPath(pinnedPath)
      : undefined;
    if (pinnedPath && (!pinnedAddress || !pinnedAddress.runRef)) {
      throw new Error(
        `${operation}: CTRLYOKE_WORKING_FILE must pin one exact promoted run`
      );
    }
    if (!selector.workflowKey || !selector.runRef) {
      if (!pinnedAddress?.runRef) {
        throw new Error(
          `${operation}: workflowKey and runRef are required unless CTRLYOKE_WORKING_FILE pins an exact promoted run`
        );
      }
      selector.workflowKey = pinnedAddress.workflowKey;
      selector.runRef = pinnedAddress.runRef;
    }
    if (
      pinnedAddress &&
      (pinnedAddress.workflowKey !== selector.workflowKey ||
        pinnedAddress.runRef !== selector.runRef)
    ) {
      throw new Error(
        `${operation}: selector conflicts with CTRLYOKE_WORKING_FILE pin`
      );
    }
    const filePath = WorkflowPaths.runFilePath(
      this.workspaceRoot,
      selector.workflowKey,
      selector.runRef
    );
    await fs.access(filePath);
    const descriptor = await lineageRepository.readDescriptor(
      this.workspaceRoot,
      selector.workflowKey
    );
    return {
      workflowKey: selector.workflowKey,
      runRef: selector.runRef,
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

if (require.main === module) {
  log("Initializing ctrlyoke MCP Server...");
  const server = new CtrlYokeMCPServer();
  server.start().catch((error) => {
    log("FATAL ERROR: Failed to start MCP server");
    log("Error:", error);
    log("Stack:", error.stack);
    process.exit(1);
  });
}
