/**
 * FlightPath MCP Server
 *
 * Provides queue management tools for Copilot CLI, Claude CLI, and Codex CLI.
 * Spawned as child process via stdio transport.
 *
 * Usage:
 *   node mcp-server.js
 *
 * Environment Variables:
 *   FLIGHTPATH_WORKSPACE - Workspace root directory (defaults to cwd)
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
} from "./types/FlightPathTypes";
import { isScriptStep } from "./types/FlightPathTypes";
import {
  EXECUTION_STATES,
  QUEUE_POSITION,
  type QueuePosition,
} from "./types/DashboardConstants";
import { withFileLock } from "./utils/FileLockUtils";

// Path constants (must match ConfigurationUtils.PATH_CONSTANTS)
const FLIGHTPATH_DIR = ".flightpath";
const LOGS_DIR = "logs";
const QUEUE_DIR = ".queue";
const CAPABILITIES_FILE = "capabilities.json";

// Initialize log file only when diagnostic logging is explicitly enabled.
// FLIGHTPATH_DIAGNOSTIC_LOGS=true is passed by the extension when
// flightpath.enableDiagnosticLogs is on. NODE_ENV=development enables it in dev.
const workspaceRoot = process.env.FLIGHTPATH_WORKSPACE || process.cwd();
const diagnosticLogsEnabled =
  process.env.FLIGHTPATH_DIAGNOSTIC_LOGS === "true" ||
  process.env.NODE_ENV === "development";

let logFile: string | null = null;
if (diagnosticLogsEnabled) {
  const logDir = path.join(workspaceRoot, FLIGHTPATH_DIR, LOGS_DIR);
  try {
    fsSync.mkdirSync(logDir, { recursive: true });
    logFile = path.join(logDir, `flightpath-mcp-${Date.now()}.log`);
  } catch {
    // Proceed without file logging if directory creation fails
  }
}

/**
 * Log to file (TUI captures stderr, so we write to .flightpath/logs/).
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
 * FlightPath MCP Server
 * Provides tools for AI agents to read and extend workflow queues
 */
/**
 * Read queue size limit from environment (set by the extension via MCP config env vars).
 * Falls back to 100 if not set. A value of 0 or FLIGHTPATH_UNLIMITED_MODE=true means no limit.
 */
function getMaxQueueSize(): number {
  const envValue = process.env.FLIGHTPATH_MAX_QUEUE_SIZE;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return 100; // Default, matches package.json default
}

function isUnlimitedMode(): boolean {
  return process.env.FLIGHTPATH_UNLIMITED_MODE === "true";
}

class FlightPathMCPServer {
  private server: InstanceType<typeof Server>;
  private workspaceRoot: string;
  private operationQueue: Promise<any> = Promise.resolve();

  constructor() {
    this.workspaceRoot = process.env.FLIGHTPATH_WORKSPACE || process.cwd();
    log("MCP Server initializing...");
    log("Workspace root:", this.workspaceRoot);
    log("Environment variables:", {
      FLIGHTPATH_WORKSPACE: process.env.FLIGHTPATH_WORKSPACE,
      FLIGHTPATH_WORKING_FILE:
        process.env.FLIGHTPATH_WORKING_FILE ||
        "(not set — will scan queue dir)",
      FLIGHTPATH_MAX_QUEUE_SIZE:
        process.env.FLIGHTPATH_MAX_QUEUE_SIZE || "(not set — default 100)",
      FLIGHTPATH_UNLIMITED_MODE:
        process.env.FLIGHTPATH_UNLIMITED_MODE || "(not set — default false)",
      NODE_ENV: process.env.NODE_ENV,
    });

    this.server = new Server(
      {
        name: "flightpath",
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

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      log("ListTools request received");
      return {
        tools: [
          {
            name: "flightpath_queue_status",
            description:
              "Get comprehensive status of the current FlightPath workflow queue, including metadata and all prompts with their execution state",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "flightpath_append_queue",
            description: `Append prompts to the current FlightPath workflow queue. Use when you want to extend the workflow with additional tasks. Supports inserting after current position ('${QUEUE_POSITION.NEXT}') or at end of queue ('${QUEUE_POSITION.END}'). Call flightpath_capabilities first to get valid harness IDs and model values.`,
            inputSchema: {
              type: "object",
              properties: {
                steps: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      prompt: {
                        type: "string",
                        description: "The prompt text to add to the queue",
                      },
                      model: {
                        type: "string",
                        description:
                          "Model override for this prompt. Call flightpath_capabilities to get valid model values per harness.",
                      },
                      harness: {
                        type: "string",
                        description:
                          "Harness override for this prompt. If omitted, uses the workflow default. Call flightpath_capabilities to get installed harness IDs and their available models.",
                      },
                      resumeSession: {
                        type: "boolean",
                        description:
                          "Continue a prior prompt's conversation session. Must be true to enable session resumption. Default: false (new session).",
                      },
                      sessionId: {
                        type: "number",
                        description:
                          "1-based prompt number whose session to resume. Requires resumeSession: true. Omit to resume the immediately preceding prompt's session.",
                      },
                    },
                    required: ["prompt"],
                  },
                  description: "Array of prompts to add to the queue",
                },
                position: {
                  type: "string",
                  enum: [QUEUE_POSITION.NEXT, QUEUE_POSITION.END],
                  description: `Where to insert steps: '${QUEUE_POSITION.NEXT}' (after current) or '${QUEUE_POSITION.END}' (at end of queue)`,
                },
                source: {
                  type: "string",
                  description:
                    'Source identifier (e.g., "copilot-cli", "claude-cli", "AI-generated testing tasks")',
                },
              },
              required: ["steps", "position"],
            },
          },
          {
            name: "flightpath_capabilities",
            description:
              "Get available harnesses and their supported models on this machine. Call this before appending prompts with harness or model overrides to ensure you use valid values. Returns only harnesses that are installed and detected as available.",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
          {
            name: "flightpath_read_output",
            description:
              "Read the AI response text from completed prompts in the current workflow. Use this to inspect prior results before deciding what to add next.",
            inputSchema: {
              type: "object",
              properties: {
                indices: {
                  type: "array",
                  items: { type: "number" },
                  description:
                    "Zero-based indices of prompts to read. Omit or pass empty array to read all prompts.",
                },
              },
            },
          },
          {
            name: "flightpath_global_status",
            description:
              "Get the status of ALL FlightPath workflows currently in the workspace queue, not just the current one. Call this at the start of a session to understand what other agents are working on, avoid editing files they own, and ignore compile/test errors they may have caused. Returns name, execution state, harness, current step, and working file path for each workflow.",
            inputSchema: {
              type: "object",
              properties: {},
            },
          },
        ],
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
          let result;
          switch (name) {
            case "flightpath_queue_status":
              log("Handling queue_status...");
              result = await this.handleQueueStatus();
              log("queue_status completed successfully");
              return result;
            case "flightpath_append_queue":
              log("Handling append_queue...");
              // Queue the operation to prevent race conditions
              result = await this.queueOperation(() =>
                this.handleQueueAppend(args)
              );
              log("append_queue completed successfully");
              log("Result:", JSON.stringify(result, null, 2));
              return result;
            case "flightpath_capabilities":
              log("Handling capabilities...");
              result = await this.handleCapabilities();
              log("capabilities completed successfully");
              return result;
            case "flightpath_read_output":
              log("Handling read_output...");
              result = await this.handleReadOutput(args);
              log("read_output completed successfully");
              return result;
            case "flightpath_global_status":
              log("Handling global_status...");
              result = await this.handleGlobalStatus();
              log("global_status completed successfully");
              return result;
            default:
              throw new Error(`Unknown tool: ${name}`);
          }
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
   * Handle flightpath_queue_status tool invocation
   * Returns comprehensive queue state including metadata and all prompts
   */
  private async handleQueueStatus() {
    log("Finding active working file...");
    const workingFile = await this.findActiveWorkingFile();
    log("Working file:", workingFile || "(none found)");

    if (!workingFile) {
      throw new Error(
        "No active FlightPath workflow found. Start a workflow in VS Code first."
      );
    }

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
      metadata: {
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
   * Handle flightpath_append_queue tool invocation
   * Appends prompts to the queue with position control
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

    // Find active working file
    log("Finding active working file...");
    const workingFile = await this.findActiveWorkingFile();
    log("Working file:", workingFile || "(none found)");

    if (!workingFile) {
      throw new Error(
        "No active FlightPath workflow found. Start a workflow in VS Code first."
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
      rejectionDetails?: Array<{
        prompt: string;
        name?: string;
        reason?: string;
      }>;
    } | null = null;

    await withFileLock(workingFile, async () => {
      // Read current queue state
      log("Reading current queue state...");
      const fileContent = await fs.readFile(workingFile, "utf8");
      const queueData: WorkingFile = JSON.parse(fileContent);
      log("Current queue size:", queueData.steps?.length || 0);

      const runtime = queueData._runtime || {
        currentIndex: 0,
        executionState: EXECUTION_STATES.IDLE,
      };
      const completedCount = (queueData.steps || []).filter(
        (p) => p._runtime?.completedAt !== undefined
      ).length;
      log("Current runtime state:", {
        currentIndex: runtime.currentIndex,
        executionState: runtime.executionState,
        completedCount,
      });

      // Calculate insert index
      const insertIndex =
        position === QUEUE_POSITION.NEXT
          ? runtime.currentIndex + 1
          : (queueData.steps || []).length;
      log("Insert index calculated:", insertIndex);

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

      // Insert valid prompts at calculated position
      if (!queueData.steps) {
        log("Initializing empty prompts array");
        queueData.steps = [];
      }
      log(
        "Inserting",
        validPrompts.length,
        "valid prompts at index",
        insertIndex
      );
      queueData.steps.splice(insertIndex, 0, ...validPrompts);
      log("New queue size:", queueData.steps.length);

      // Update runtime metadata
      queueData._runtime = runtime;

      // If queue is completed/idle, set to running state
      if (
        runtime.executionState === EXECUTION_STATES.COMPLETED ||
        runtime.executionState === EXECUTION_STATES.IDLE
      ) {
        log(
          "Updating execution state from",
          runtime.executionState,
          "to",
          EXECUTION_STATES.RUNNING
        );
        runtime.executionState = EXECUTION_STATES.RUNNING;
      }

      // Write atomically (temp file + rename)
      const tempFile = workingFile + ".tmp";
      log("Writing to temp file:", tempFile);
      await fs.writeFile(tempFile, JSON.stringify(queueData, null, 2), "utf8");
      log("Renaming temp file to working file...");
      await fs.rename(tempFile, workingFile);
      log("File write completed successfully");

      response = {
        success: true,
        stepsAdded: validPrompts.length,
        stepsRejected: rejectedPrompts.length,
        newQueueSize: queueData.steps.length,
        insertIndex,
        workingFile: path.relative(this.workspaceRoot, workingFile),
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
    });

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
   * Read and parse .flightpath/capabilities.json.
   * Returns null if the file does not exist or cannot be parsed.
   */
  private async readCapabilities(): Promise<any | null> {
    const capabilitiesPath = path.join(
      this.workspaceRoot,
      FLIGHTPATH_DIR,
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
   * Handle flightpath_capabilities tool invocation.
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
   * Handle flightpath_read_output tool invocation.
   * Returns AI response text from completed prompts.
   */
  private async handleReadOutput(args: any) {
    const workingFile = await this.findActiveWorkingFile();

    if (!workingFile) {
      throw new Error(
        "No active FlightPath workflow found. Start a workflow in VS Code first."
      );
    }

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

    const outputs = requestedIndices
      .filter((i) => i >= 0 && i < allSteps.length)
      .map((i) => {
        const p = allSteps[i];
        return {
          index: i,
          prompt: isScriptStep(p) ? `(script) ${p.script}` : p.prompt,
          status: this.getStepStatus(i, runtime, allSteps),
          responseText: p._runtime?.responseText ?? null,
        };
      });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ outputs }, null, 2),
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
   * Handle flightpath_global_status tool invocation.
   * Returns the status of every workflow in the workspace queue — not just the
   * current one. Agents should call this at session start to understand what
   * other workflows are running so they can avoid file conflicts and ignore
   * errors caused by sibling workflows.
   */
  private async handleGlobalStatus() {
    const queueDir = path.join(this.workspaceRoot, FLIGHTPATH_DIR, QUEUE_DIR);
    log("Scanning queue directory for all workflows:", queueDir);

    try {
      const files = await fs.readdir(queueDir);
      const queueFiles = files.filter((f) => f.endsWith(".flightpath.json"));
      log("Found queue files:", queueFiles.length);

      const workflows = await Promise.all(
        queueFiles.map(async (f) => {
          const filePath = path.join(queueDir, f);
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
                { workspaceRoot: this.workspaceRoot, workflowCount: 0, workflows: [] },
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
   * Find the active working file for this workflow execution.
   *
   * Lookup order:
   * 1. FLIGHTPATH_WORKING_FILE env var — set per-workflow by the MCP config generator
   *    so each AI session targets exactly its own queue file (multi-workflow safe).
   * 2. Fallback: scan .flightpath/.queue/ and prefer files with executionState=running,
   *    then most recently modified (single-workflow fallback).
   */
  private async findActiveWorkingFile(): Promise<string | null> {
    // 1. Prefer the pinned file from the per-workflow MCP config
    const pinnedFile = process.env.FLIGHTPATH_WORKING_FILE;
    if (pinnedFile) {
      log("Using pinned working file:", pinnedFile);
      try {
        await fs.access(pinnedFile);
        return pinnedFile;
      } catch (error: any) {
        log(
          "Pinned working file not accessible, falling back to scan:",
          error.message
        );
      }
    }

    // 2. Scan the queue directory
    const queueDir = path.join(this.workspaceRoot, FLIGHTPATH_DIR, QUEUE_DIR);
    log("Searching for working files in:", queueDir);

    try {
      const files = await fs.readdir(queueDir);
      log("Files found:", files.length);
      const queueFiles = files.filter((f) => f.endsWith(".flightpath.json"));
      log("Queue files found:", queueFiles.length, queueFiles);

      if (queueFiles.length === 0) {
        log("No active working files found");
        return null;
      }

      // Read each file's executionState so we can prefer RUNNING ones
      const fileInfos = await Promise.all(
        queueFiles.map(async (f) => {
          const filePath = path.join(queueDir, f);
          try {
            const [content, stats] = await Promise.all([
              fs.readFile(filePath, "utf8"),
              fs.stat(filePath),
            ]);
            const data = JSON.parse(content);
            return {
              path: filePath,
              mtime: stats.mtime,
              executionState:
                (data._runtime?.executionState as string) ?? "idle",
            };
          } catch {
            return null;
          }
        })
      );

      const validFiles = fileInfos.filter(
        (f): f is { path: string; mtime: Date; executionState: string } =>
          f !== null
      );

      if (validFiles.length === 0) {
        return null;
      }

      // Prefer RUNNING files over all others; fall back to most-recently-modified
      const runningFiles = validFiles.filter(
        (f) => f.executionState === EXECUTION_STATES.RUNNING
      );
      const candidates = runningFiles.length > 0 ? runningFiles : validFiles;
      candidates.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

      log(
        "Selected working file:",
        candidates[0].path,
        `(state=${candidates[0].executionState})`
      );
      return candidates[0].path;
    } catch (error: any) {
      log("ERROR finding active working file:", error.message);
      log("Error stack:", error.stack);
      return null;
    }
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
    log("FlightPath MCP Server Starting");
    log("Log file:", logFile);
    log("Workspace:", this.workspaceRoot);
    log("===================================");
    log("Creating stdio transport...");
    const transport = new StdioServerTransport();
    log("Connecting server to transport...");
    await this.server.connect(transport);
    log("===================================");
    log("FlightPath MCP Server STARTED");
    log("Listening for tool requests...");
    log("===================================");
  }
}

// Start server
log("Initializing FlightPath MCP Server...");
const server = new FlightPathMCPServer();
server.start().catch((error) => {
  log("FATAL ERROR: Failed to start MCP server");
  log("Error:", error);
  log("Stack:", error.stack);
  process.exit(1);
});
