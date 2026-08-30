import { QUEUE_POSITION } from "../types/DashboardConstants";

/**
 * JSON-schema shape used by ctrlyoke's MCP tools.
 *
 * Kept in a small Node-only module so prompt helpers can describe the tools
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

/** The single source of truth for ctrlyoke's exposed MCP tool definitions. */
export const MCP_TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "ctrlyoke_queue_status",
    description:
      "See the steps in your workflow: which have finished, which is running now, and which are still queued.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ctrlyoke_append_queue",
    description:
      "Add one or more steps to your workflow's queue. This is how you build up or extend the workflow — from staging the very first steps of a plan to adding a follow-up once you discover more work is needed. Call ctrlyoke_capabilities first if you want to choose a harness or model for the new steps.",
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
    name: "ctrlyoke_capabilities",
    description:
      "List the harnesses installed on this machine and the models each one supports. Call this before setting a harness or model on a step so you pick values that exist.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ctrlyoke_read_output",
    description:
      "Read what earlier steps in your workflow produced. Use this to build on a previous step's conclusions instead of repeating its work.",
    inputSchema: {
      type: "object",
      properties: {
        indices: {
          type: "array",
          items: { type: "number" },
          description:
            "Zero-based step numbers to read. Omit to read them all.",
        },
      },
    },
  },
  {
    name: "ctrlyoke_global_status",
    description:
      "List the other ctrlyoke workflows in this workspace and what they are doing. Call this before wide-reaching edits so you can leave files another workflow is working on alone, and recognize build or test failures it caused rather than chasing them.",
    inputSchema: {
      type: "object",
      properties: {
        workflowKey: {
          type: "string",
          description:
            "Report only this workflow, as identified by a previous ctrlyoke_global_status call.",
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

/** Queue tools documented by the built-in MCP skill. */
export const MCP_QUEUE_TOOL_NAMES = [
  "ctrlyoke_queue_status",
  "ctrlyoke_append_queue",
  "ctrlyoke_capabilities",
  "ctrlyoke_read_output",
  "ctrlyoke_global_status",
] as const;
