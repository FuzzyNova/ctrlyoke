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
  AppendSegment,
  WorkingFile,
  WorkingFileRuntime,
} from "./types/FlightPathTypes";
import { EXECUTION_STATES } from "./types/DashboardConstants";

// Initialize log file
const workspaceRoot = process.env.FLIGHTPATH_WORKSPACE || process.cwd();
const logDir = path.join(workspaceRoot, ".flightpath", "logs");
const logFile = path.join(logDir, `mcp-server-${Date.now()}.log`);

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
class FlightPathMCPServer {
  private server: typeof Server;
  private workspaceRoot: string;

  constructor() {
    this.workspaceRoot = process.env.FLIGHTPATH_WORKSPACE || process.cwd();
    log("MCP Server initializing...");
    log("Workspace root:", this.workspaceRoot);
    log("Environment variables:", {
      FLIGHTPATH_WORKSPACE: process.env.FLIGHTPATH_WORKSPACE,
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
            description:
              "Append prompts to the current FlightPath workflow queue. Use when you want to extend the workflow with additional tasks. Supports inserting after current position ('next') or at end of queue ('end').",
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
                  enum: ["next", "end"],
                  description:
                    "Where to insert prompts: 'next' (after current) or 'end' (at end of queue)",
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
              result = await this.handleQueueAppend(args);
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
      completedPrompts: [],
      executionState: EXECUTION_STATES.IDLE,
      appendSegments: [],
    };

    const prompts = (queueData.prompts || []).map((p, index) => ({
      index,
      prompt: p.prompt,
      status: this.getPromptStatus(index, runtime),
      model: p.model,
    }));

    const response = {
      metadata: {
        workflowName: queueData.workflowName,
        currentIndex: runtime.currentIndex,
        totalPrompts: prompts.length,
        completedPrompts: runtime.completedPrompts.length,
        executionState: runtime.executionState,
        maxQueueSize: 100, // TODO: Read from config
        remainingSlots: 100 - prompts.length,
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
      position: "next" | "end";
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

    if (position !== "next" && position !== "end") {
      log("ERROR: Invalid position:", position);
      throw new Error("position must be 'next' or 'end'");
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

    // Read current queue state
    log("Reading current queue state...");
    const fileContent = await fs.readFile(workingFile, "utf8");
    const queueData: WorkingFile = JSON.parse(fileContent);
    log("Current queue size:", queueData.prompts?.length || 0);

    const runtime = queueData._runtime || {
      currentIndex: 0,
      completedPrompts: [],
      executionState: EXECUTION_STATES.IDLE,
      appendSegments: [],
    };
    log("Current runtime state:", {
      currentIndex: runtime.currentIndex,
      executionState: runtime.executionState,
      completedCount: runtime.completedPrompts?.length || 0,
    });

    // Calculate insert index
    const insertIndex =
      position === "next"
        ? runtime.currentIndex + 1
        : (queueData.prompts || []).length;
    log("Insert index calculated:", insertIndex);

    // Validate queue size limit
    const maxQueueSize = 100; // TODO: Read from config
    const newTotalSize = (queueData.prompts || []).length + prompts.length;
    log("Queue size check:", {
      current: (queueData.prompts || []).length,
      adding: prompts.length,
      newTotal: newTotalSize,
      max: maxQueueSize,
    });

    if (newTotalSize > maxQueueSize) {
      throw new Error(
        `Queue size limit exceeded. Current: ${(queueData.prompts || []).length}, Adding: ${prompts.length}, Max: ${maxQueueSize}`
      );
    }

    // Insert prompts at calculated position
    if (!queueData.prompts) {
      log("Initializing empty prompts array");
      queueData.prompts = [];
    }
    log("Inserting", prompts.length, "prompts at index", insertIndex);
    queueData.prompts.splice(insertIndex, 0, ...prompts);
    log("New queue size:", queueData.prompts.length);

    // Track segment metadata
    const segment: AppendSegment = {
      id: this.generateId(),
      timestamp: Date.now(),
      source: reason ? `${source}: ${reason}` : source,
      promptCount: prompts.length,
      promptIndices: Array.from(
        { length: prompts.length },
        (_, i) => insertIndex + i
      ),
    };
    log("Created append segment:", segment);

    if (!runtime.appendSegments) {
      runtime.appendSegments = [];
    }
    runtime.appendSegments.push(segment);
    log("Total append segments:", runtime.appendSegments.length);

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

    const response = {
      success: true,
      promptsAdded: prompts.length,
      newQueueSize: queueData.prompts.length,
      insertIndex,
      workingFile: path.relative(this.workspaceRoot, workingFile),
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
   * Find the most recently modified working file in .flightpath/.queue/
   */
  private async findActiveWorkingFile(): Promise<string | null> {
    const queueDir = path.join(this.workspaceRoot, ".flightpath", ".queue");
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

      // Get most recently modified file
      const fileStats = await Promise.all(
        queueFiles.map(async (f) => {
          const filePath = path.join(queueDir, f);
          const stats = await fs.stat(filePath);
          return {
            path: filePath,
            mtime: stats.mtime,
          };
        })
      );

      fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      log("Selected most recent file:", fileStats[0].path);
      return fileStats[0].path;
    } catch (error: any) {
      log("ERROR finding active working file:", error.message);
      log("Error stack:", error.stack);
      return null;
    }
  }

  /**
   * Determine prompt status based on runtime state
   */
  private getPromptStatus(index: number, runtime: WorkingFileRuntime): string {
    if (runtime.completedPrompts.includes(String(index))) {
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
   * Generate a unique segment ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(7)}`;
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
