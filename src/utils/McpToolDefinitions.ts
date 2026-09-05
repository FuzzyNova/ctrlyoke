import { QUEUE_POSITION } from "../types/DashboardConstants";

/**
 * JSON-schema shape used by ctrlyoke's MCP tools.
 *
 * Kept in a small shared module so prompt helpers can describe the tools
 * without importing the MCP server entrypoint (and its transport setup).
 */
export interface McpToolInputSchema {
  type: string;
  description?: string;
  properties?: Record<string, McpToolInputSchema>;
  required?: readonly string[];
  items?: McpToolInputSchema;
  enum?: readonly string[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: McpToolInputSchema;
}

/** Tool that reports the current workflow state. */
export const MCP_WORKFLOW_STATUS_TOOL_NAME = "workflow_status";

/** Tool used to add one or more steps to the workflow. */
export const MCP_APPEND_STEP_TOOL_NAME = "append_step";

/** Tool that lists the installed harnesses and supported models. */
export const MCP_CAPABILITIES_TOOL_NAME = "capabilities";

/** Tool that reads output from earlier workflow steps. */
export const MCP_READ_OUTPUT_TOOL_NAME = "read_output";

/** Tool that lists other workflows in the workspace. */
export const MCP_GLOBAL_STATUS_TOOL_NAME = "global_status";

/** Tool used by the structured commit-message capture path. */
export const MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME = "submit_commit_message";

/** The single source of truth for ctrlyoke's exposed MCP tool definitions. */
export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: MCP_WORKFLOW_STATUS_TOOL_NAME,
    description:
      "See the steps in your workflow: which have finished, which is running now, and which are still queued.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: MCP_APPEND_STEP_TOOL_NAME,
    description:
      "Add one or more steps to your workflow's queue. This is how you build up or extend the workflow — from staging the very first steps of a plan to adding a follow-up once you discover more work is needed. Call capabilities first if you want to choose a harness or model for the new steps.",
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
                description: "What the step should do.",
              },
              name: {
                type: "string",
                description:
                  "Short display label for this step (e.g. 'Implement security'). The UI already shows the step's position (e.g. '2 of 6'), so don't repeat that here.",
              },
              model: {
                type: "string",
                description:
                  "Model to run this step with. Defaults to the workflow's model.",
              },
              harness: {
                type: "string",
                description:
                  "Harness to run this step with. Defaults to the workflow's harness.",
              },
              resumeSession: {
                type: "boolean",
                description:
                  "Continue an earlier step's conversation instead of starting fresh.",
              },
              sessionId: {
                type: "number",
                description:
                  "1-based step number whose conversation to continue. Requires resumeSession.",
              },
            },
            required: ["prompt"],
          },
          description: "One or more steps to add, in the order to run them.",
        },
        position: {
          type: "string",
          enum: [QUEUE_POSITION.NEXT, QUEUE_POSITION.END],
          description:
            "'next' runs the new steps before the rest of the queue; 'end' runs them last.",
        },
        source: {
          type: "string",
          description: "Optional label describing why you added these.",
        },
      },
      required: ["steps", "position"],
    },
  },
  {
    name: MCP_CAPABILITIES_TOOL_NAME,
    description:
      "List the harnesses installed on this machine and the models each one supports. Call this before setting a harness or model on a step so you pick values that exist.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: MCP_READ_OUTPUT_TOOL_NAME,
    description:
      "Read what earlier steps in your workflow produced. Use this to build on a previous step's conclusions instead of repeating its work; for a large output, page one selected step with limit and cursor or inspect its tail.",
    inputSchema: {
      type: "object",
      properties: {
        indices: {
          type: "array",
          items: { type: "number" },
          description:
            "Zero-based step numbers to read. Omit to read them all; paging arguments require exactly one.",
        },
        cursor: {
          type: "string",
          description:
            "Continue reading the selected step from the nextCursor returned by an earlier read_output call.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of characters to return from the selected step. Omit to read through the end.",
        },
        tail: {
          type: "number",
          description:
            "Return the last N characters of the selected step instead of reading forward. Do not combine with cursor or limit.",
        },
      },
    },
  },
  {
    name: MCP_GLOBAL_STATUS_TOOL_NAME,
    description:
      "List the other ctrlyoke workflows in this workspace and what they are doing. Call this before wide-reaching edits so you can leave files another workflow is working on alone, and recognize build or test failures it caused rather than chasing them.",
    inputSchema: {
      type: "object",
      properties: {
        workflowKey: {
          type: "string",
          description:
            "Report only this workflow, as identified by a previous global_status call.",
        },
        runRef: {
          type: "string",
          description:
            "Report only this run of that workflow. Requires workflowKey; never a display number.",
        },
      },
    },
  },
  {
    name: MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
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

/** Workflow tools documented by the built-in MCP skill. */
export const MCP_WORKFLOW_TOOL_NAMES = [
  MCP_WORKFLOW_STATUS_TOOL_NAME,
  MCP_APPEND_STEP_TOOL_NAME,
  MCP_CAPABILITIES_TOOL_NAME,
  MCP_READ_OUTPUT_TOOL_NAME,
  MCP_GLOBAL_STATUS_TOOL_NAME,
] as const;
