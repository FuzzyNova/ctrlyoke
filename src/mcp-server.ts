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
import * as path from "path";
import type {
  PromptItem,
  AppendSegment,
  WorkingFile,
  WorkingFileRuntime,
} from "./types/FlightPathTypes";
import { EXECUTION_STATES } from "./types/DashboardConstants";

/**
 * FlightPath MCP Server
 * Provides tools for AI agents to read and extend workflow queues
 */
class FlightPathMCPServer {
  private server: typeof Server;
  private workspaceRoot: string;

  constructor() {
    this.workspaceRoot = process.env.FLIGHTPATH_WORKSPACE || process.cwd();

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
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
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
    }));

    // Handle tool invocations
    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request: any) => {
        const { name, arguments: args } = request.params;

        try {
          switch (name) {
            case "flightpath_queue_status":
              return await this.handleQueueStatus();
            case "flightpath_append_queue":
              return await this.handleQueueAppend(args);
            default:
              throw new Error(`Unknown tool: ${name}`);
          }
        } catch (error: any) {
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
    const workingFile = await this.findActiveWorkingFile();
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

    // Validate inputs
    if (!Array.isArray(prompts) || prompts.length === 0) {
      throw new Error("prompts must be a non-empty array");
    }

    if (position !== "next" && position !== "end") {
      throw new Error("position must be 'next' or 'end'");
    }

    // Find active working file
    const workingFile = await this.findActiveWorkingFile();
    if (!workingFile) {
      throw new Error(
        "No active FlightPath workflow found. Start a workflow in VS Code first."
      );
    }

    // Read current queue state
    const fileContent = await fs.readFile(workingFile, "utf8");
    const queueData: WorkingFile = JSON.parse(fileContent);

    const runtime = queueData._runtime || {
      currentIndex: 0,
      completedPrompts: [],
      executionState: EXECUTION_STATES.IDLE,
      appendSegments: [],
    };

    // Calculate insert index
    const insertIndex =
      position === "next"
        ? runtime.currentIndex + 1
        : (queueData.prompts || []).length;

    // Validate queue size limit
    const maxQueueSize = 100; // TODO: Read from config
    const newTotalSize = (queueData.prompts || []).length + prompts.length;
    if (newTotalSize > maxQueueSize) {
      throw new Error(
        `Queue size limit exceeded. Current: ${(queueData.prompts || []).length}, Adding: ${prompts.length}, Max: ${maxQueueSize}`
      );
    }

    // Insert prompts at calculated position
    if (!queueData.prompts) {
      queueData.prompts = [];
    }
    queueData.prompts.splice(insertIndex, 0, ...prompts);

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

    if (!runtime.appendSegments) {
      runtime.appendSegments = [];
    }
    runtime.appendSegments.push(segment);

    // Update runtime metadata
    queueData._runtime = runtime;

    // If queue is completed/idle, set to running state
    if (
      runtime.executionState === EXECUTION_STATES.COMPLETED ||
      runtime.executionState === EXECUTION_STATES.IDLE
    ) {
      runtime.executionState = EXECUTION_STATES.RUNNING;
    }

    // Write atomically (temp file + rename)
    const tempFile = workingFile + ".tmp";
    await fs.writeFile(tempFile, JSON.stringify(queueData, null, 2), "utf8");
    await fs.rename(tempFile, workingFile);

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

    try {
      const files = await fs.readdir(queueDir);
      const queueFiles = files.filter((f) => f.endsWith(".flightpath.json"));

      if (queueFiles.length === 0) {
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
      return fileStats[0].path;
    } catch (error) {
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
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    // Log to stderr (stdout is reserved for JSON-RPC)
    console.error(
      `FlightPath MCP Server started (workspace: ${this.workspaceRoot})`
    );
  }
}

// Start server
const server = new FlightPathMCPServer();
server.start().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
