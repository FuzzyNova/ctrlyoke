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
  PromptItem,
  WorkingFile,
  WorkingFileRuntime,
} from "./types/FlightPathTypes";
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

// Initialize log file
const workspaceRoot = process.env.FLIGHTPATH_WORKSPACE || process.cwd();
const logDir = path.join(workspaceRoot, FLIGHTPATH_DIR, LOGS_DIR);
const logFile = path.join(logDir, `flightpath-mcp-${Date.now()}.log`);

// Ensure log directory exists
try {
  fsSync.mkdirSync(logDir, { recursive: true });
} catch (error) {
  // Ignore errors, will fail on first log write if directory can't be created
}

/**
 * Log to file (TUI captures stderr, so we write to .flightpath/logs/)
 */
function log(...args: any[]) {
  const timestamp = new Date().toISOString();
  const message = `[${timestamp}] ${args
    .map((arg) =>
      typeof arg === "object" ? JSON.stringify(arg, null, 2) : String(arg)
    )
    .join(" ")}\n`;

  try {
    fsSync.appendFileSync(logFile, message, "utf8");
  } catch (error) {
    // Fallback to stderr if file write fails
    console.error(message.trim());
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
            description: `Append prompts to the current FlightPath workflow queue. Use when you want to extend the workflow with additional tasks. Supports inserting after current position ('${QUEUE_POSITION.NEXT}') or at end of queue ('${QUEUE_POSITION.END}').`,
            inputSchema: {
              type: "object",
              properties: {
                prompts: {
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
                          "Optional model override (e.g., 'claude-sonnet-4.5', 'gpt-5')",
                      },
                    },
                    required: ["prompt"],
                  },
                  description: "Array of prompts to add to the queue",
                },
                position: {
                  type: "string",
                  enum: [QUEUE_POSITION.NEXT, QUEUE_POSITION.END],
                  description: `Where to insert prompts: '${QUEUE_POSITION.NEXT}' (after current) or '${QUEUE_POSITION.END}' (at end of queue)`,
                },
                source: {
                  type: "string",
                  description:
                    'Source identifier (e.g., "copilot-cli", "claude-cli", "AI-generated testing tasks")',
                },
                reason: {
                  type: "string",
                  description:
                    "Optional explanation for why these prompts are being added",
                },
              },
              required: ["prompts", "position"],
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

    const allPrompts = queueData.prompts || [];
    const prompts = allPrompts.map((p, index) => ({
      index,
      prompt: p.prompt,
      status: this.getPromptStatus(index, runtime, allPrompts),
      model: p.model,
    }));

    const completedCount = allPrompts.filter(
      (p) => p._runtime?.completedAt !== undefined
    ).length;

    const unlimited = isUnlimitedMode();
    const maxSize = getMaxQueueSize();

    const response = {
      metadata: {
        workflowName: queueData.workflowName,
        currentIndex: runtime.currentIndex,
        totalPrompts: prompts.length,
        completedPrompts: completedCount,
        executionState: runtime.executionState,
        maxQueueSize: unlimited ? "unlimited" : maxSize,
        remainingSlots: unlimited ? "unlimited" : maxSize - prompts.length,
        workingFile: path.relative(this.workspaceRoot, workingFile),
      },
      prompts,
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
      prompts,
      position,
      source = "MCP Tool",
      reason,
    } = args as {
      prompts: PromptItem[];
      position: QueuePosition;
      source?: string;
      reason?: string;
    };

    log("Parsed arguments:", {
      promptCount: prompts?.length || 0,
      position,
      source,
      reason,
    });

    // Validate inputs
    if (!Array.isArray(prompts) || prompts.length === 0) {
      log("ERROR: Invalid prompts array", prompts);
      throw new Error("prompts must be a non-empty array");
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

    let response: {
      success: boolean;
      promptsAdded: number;
      promptsRejected: number;
      newQueueSize: number;
      insertIndex: number;
      workingFile: string;
      rejectionDetails?: Array<{
        prompt: string;
        id?: string;
        reason?: string;
      }>;
    } | null = null;

    await withFileLock(workingFile, async () => {
      // Read current queue state
      log("Reading current queue state...");
      const fileContent = await fs.readFile(workingFile, "utf8");
      const queueData: WorkingFile = JSON.parse(fileContent);
      log("Current queue size:", queueData.prompts?.length || 0);

      const runtime = queueData._runtime || {
        currentIndex: 0,
        executionState: EXECUTION_STATES.IDLE,
      };
      const completedCount = (queueData.prompts || []).filter(
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
          : (queueData.prompts || []).length;
      log("Insert index calculated:", insertIndex);

      // Validate prompts (check for already-completed only)
      log("Starting deduplication validation...");
      const validationResults = this.validatePrompts(
        prompts,
        queueData.prompts || []
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
          `All ${prompts.length} prompts rejected. Reasons: ${rejectionReasons}`
        );
      }

      // Validate queue size limit (only for prompts that will actually be added)
      const unlimited = isUnlimitedMode();
      const maxQueueSize = getMaxQueueSize();
      const newTotalSize =
        (queueData.prompts || []).length + validPrompts.length;
      log("Queue size check:", {
        current: (queueData.prompts || []).length,
        adding: validPrompts.length,
        rejected: rejectedPrompts.length,
        newTotal: newTotalSize,
        max: unlimited ? "unlimited" : maxQueueSize,
      });

      if (!unlimited && newTotalSize > maxQueueSize) {
        throw new Error(
          `Queue size limit exceeded. Current: ${(queueData.prompts || []).length}, Adding: ${validPrompts.length}, Max: ${maxQueueSize}`
        );
      }

      // Insert valid prompts at calculated position
      if (!queueData.prompts) {
        log("Initializing empty prompts array");
        queueData.prompts = [];
      }
      log(
        "Inserting",
        validPrompts.length,
        "valid prompts at index",
        insertIndex
      );
      queueData.prompts.splice(insertIndex, 0, ...validPrompts);
      log("New queue size:", queueData.prompts.length);

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
        promptsAdded: validPrompts.length,
        promptsRejected: rejectedPrompts.length,
        newQueueSize: queueData.prompts.length,
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
      throw new Error("Failed to append prompts: no response generated");
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
   * Validate prompts before appending.
   * Only check 1 remains: reject prompts that have already been completed.
   * Completion is determined by per-prompt _runtime.completedAt (source of truth).
   */
  private validatePrompts(
    newPrompts: PromptItem[],
    existingPrompts: PromptItem[]
  ): Array<{ prompt: PromptItem; accepted: boolean; reason?: string }> {
    const results: Array<{
      prompt: PromptItem;
      accepted: boolean;
      reason?: string;
    }> = [];

    for (const newPrompt of newPrompts) {
      // Check 1: Already completed (per-prompt _runtime.completedAt is authoritative)
      const alreadyCompleted = existingPrompts.some(
        (p) =>
          p._runtime?.completedAt !== undefined && p.prompt === newPrompt.prompt
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
   * Find the active working file for this workflow execution.
   *
   * Lookup order:
   * 1. FLIGHTPATH_WORKING_FILE env var — set per-workflow by the MCP config generator
   *    so each AI session targets exactly its own queue file (multi-workflow safe).
   * 2. Fallback: scan .flightpath/.queue/ and prefer files with executionState=running,
   *    then most recently modified (single-workflow backward compat).
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
   * Determine prompt status based on per-prompt completedAt (source of truth)
   */
  private getPromptStatus(
    index: number,
    runtime: WorkingFileRuntime,
    prompts: PromptItem[]
  ): string {
    if (prompts[index]?._runtime?.completedAt !== undefined) {
      return "completed";
    }
    if (index === runtime.currentIndex) {
      return "running";
    }
    if (index < runtime.currentIndex) {
      return "completed"; // Fallback for prompts before current
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
