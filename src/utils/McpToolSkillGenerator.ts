import {
  MCP_COORDINATION_TOOL_NAMES,
  MCP_WORKFLOW_TOOL_NAMES,
  MCP_TOOL_DEFINITIONS,
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
  type McpToolInputSchema,
  type McpToolDefinition,
  type McpToolExample,
} from "./McpToolDefinitions";
import { MCP_SKILL_NAMES } from "../types/DashboardConstants";
import type { McpToolSkillRunContext } from "../types/WorkflowContextTypes";
import {
  getMcpSchemaExampleValue,
  getMcpSchemaProperties,
  getMcpSchemaRequiredProperties,
  getMcpSchemaTypeDescription,
} from "./McpSchemaValidator";

const MCP_SERVER_PATH_PLACEHOLDER = "<mcp-server.js path>";
const PATH_PLACEHOLDER = "<path>";
const COMMIT_OUTPUT_PATH_PLACEHOLDER = "<commit output path>";
const WORKSPACE_PATH_PLACEHOLDER = "<workspace path>";
const WORKING_FILE_PATH_PLACEHOLDER = "<working-file path>";
const EXECUTION_ROOT_PATH_PLACEHOLDER = "<execution-root path>";
const STEP_INDEX_PLACEHOLDER = "<step index>";
const PARALLEL_GROUP_ID_PLACEHOLDER = "<parallel group id>";

function resolvePath(
  context: McpToolSkillRunContext | undefined,
  value: keyof McpToolSkillRunContext,
  placeholder: string
): string {
  const resolved = context?.[value];
  return resolved === undefined ? placeholder : String(resolved);
}

function resolveValue<T extends string | number>(
  context: McpToolSkillRunContext | undefined,
  value: keyof McpToolSkillRunContext,
  placeholder: string,
  fallback?: T
): string {
  const resolved = context?.[value];
  if (resolved === undefined) {
    return fallback === undefined ? placeholder : String(fallback);
  }
  return String(resolved);
}

function substituteStaticPathPlaceholders(
  staticContent: string,
  context: McpToolSkillRunContext | undefined
): string {
  if (!context) {
    return staticContent;
  }

  return staticContent
    .replaceAll(MCP_SERVER_PATH_PLACEHOLDER, context.mcpServerPath)
    .replaceAll(WORKSPACE_PATH_PLACEHOLDER, context.workspaceRoot)
    .replaceAll(
      WORKING_FILE_PATH_PLACEHOLDER,
      context.workingFilePath ?? WORKING_FILE_PATH_PLACEHOLDER
    )
    .replaceAll(
      COMMIT_OUTPUT_PATH_PLACEHOLDER,
      context.commitOutputPath ?? COMMIT_OUTPUT_PATH_PLACEHOLDER
    );
}

function renderParameters(schema: McpToolInputSchema): string {
  const required = getMcpSchemaRequiredProperties(schema);
  const entries = getMcpSchemaProperties(schema);

  if (entries.length === 0) {
    return "Parameters: none.";
  }

  const lines = entries.map(([name, property]) => {
    const requirement = required.has(name) ? "required" : "optional";
    const type = getMcpSchemaTypeDescription(property);
    const description = property.description
      ? ` — ${property.description}`
      : "";
    return `- \`${name}\` (${requirement}, ${type})${description}`;
  });

  return ["Parameters:", ...lines].join("\n");
}

function renderCommand(
  tool: McpToolDefinition,
  args: Record<string, unknown>,
  paths: {
    mcpServerPath: string;
    workspaceRoot: string;
    workingFilePath: string;
    commitOutputPath: string;
    executionRoot: string;
  },
  context: McpToolSkillRunContext | undefined
): string {
  const serializedArgs = JSON.stringify(args);
  if (tool.name === MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME) {
    return `node \"${paths.mcpServerPath}\" --tool ${tool.name} --args '${serializedArgs}' --workspace \"${paths.workspaceRoot}\" --commit-output \"${paths.commitOutputPath}\"`;
  }

  return (
    `node \"${paths.mcpServerPath}\" --tool ${tool.name} --args '${serializedArgs}' --workspace \"${paths.workspaceRoot}\" --working-file \"${paths.workingFilePath}\"` +
    (MCP_COORDINATION_TOOL_NAMES.includes(
      tool.name as (typeof MCP_COORDINATION_TOOL_NAMES)[number]
    )
      ? ` --execution-root \"${paths.executionRoot}\"${
          context?.parallelGroupId !== undefined || !context
            ? ` --step-index \"${resolveValue(context, "stepIndex", STEP_INDEX_PLACEHOLDER)}\"`
            : ""
        }${
          context?.parallelGroupId !== undefined || !context
            ? ` --parallel-group-id \"${resolveValue(context, "parallelGroupId", PARALLEL_GROUP_ID_PLACEHOLDER)}\"`
            : ""
        }`
      : "")
  );
}

function renderExamples(
  tool: McpToolDefinition,
  paths: {
    mcpServerPath: string;
    workspaceRoot: string;
    workingFilePath: string;
    commitOutputPath: string;
    executionRoot: string;
  },
  context: McpToolSkillRunContext | undefined
): string[] {
  const examples: readonly McpToolExample[] = tool.examples ?? [
    {
      description: "example",
      args: getMcpSchemaExampleValue(tool.inputSchema) as Record<
        string,
        unknown
      >,
    },
  ];

  if (examples.length === 1 && examples[0].description === "example") {
    return ["Example:", renderCommand(tool, examples[0].args, paths, context)];
  }

  return [
    "Examples:",
    ...examples.flatMap((example) => [
      `Example (${example.description}):`,
      renderCommand(tool, example.args, paths, context),
    ]),
  ];
}

/** Render live MCP tool definitions as instructions for the built-in skill. */
export class McpToolSkillGenerator {
  static generateToolReference(
    toolNames: string[],
    context?: McpToolSkillRunContext
  ): string {
    const requestedNames = new Set(toolNames);
    const tools = MCP_TOOL_DEFINITIONS.filter((tool) =>
      requestedNames.has(tool.name)
    );
    const mcpServerPath = resolvePath(
      context,
      "mcpServerPath",
      MCP_SERVER_PATH_PLACEHOLDER
    );
    const workspaceRoot = resolvePath(
      context,
      "workspaceRoot",
      PATH_PLACEHOLDER
    );
    const workingFilePath = resolvePath(
      context,
      "workingFilePath",
      PATH_PLACEHOLDER
    );
    const commitOutputPath = resolvePath(
      context,
      "commitOutputPath",
      COMMIT_OUTPUT_PATH_PLACEHOLDER
    );
    const executionRoot = resolvePath(
      context,
      "executionRoot",
      EXECUTION_ROOT_PATH_PLACEHOLDER
    );

    return [
      "## Available ctrlyoke MCP tools",
      ...tools.map((tool) => {
        return [
          `### ${tool.name}`,
          tool.description,
          renderParameters(tool.inputSchema),
          ...renderExamples(
            tool,
            {
              mcpServerPath,
              workspaceRoot,
              workingFilePath,
              commitOutputPath,
              executionRoot,
            },
            context
          ),
        ].join("\n");
      }),
    ].join("\n\n");
  }

  /**
   * Add the live tool reference to one of ctrlyoke's generated built-in skills.
   * Returns undefined for ordinary skills, which should remain verbatim.
   */
  static generateBuiltInSkillContent(
    skillName: string,
    staticContent: string,
    context?: McpToolSkillRunContext
  ): string | undefined {
    const toolNames =
      skillName === MCP_SKILL_NAMES.COMMIT_MESSAGE
        ? MCP_COMMIT_MESSAGE_SKILL_TOOL_NAMES
        : skillName === MCP_SKILL_NAMES.TOOLS
          ? MCP_WORKFLOW_TOOL_NAMES
          : skillName === MCP_SKILL_NAMES.COORDINATION
            ? MCP_COORDINATION_TOOL_NAMES
            : undefined;
    if (!toolNames) return undefined;

    // A denied tool is never documented. Export passes no context, so a
    // snapshot keeps the full listing alongside its placeholders.
    const denied = new Set(context?.deniedTools ?? []);
    const permitted = toolNames.filter((name) => !denied.has(name));

    return `${substituteStaticPathPlaceholders(staticContent, context).trimEnd()}\n\n${this.generateToolReference(permitted, context)}`;
  }
}

/** The built-in skill's commit-message tool subset. */
export const MCP_COMMIT_MESSAGE_SKILL_TOOL_NAMES: readonly string[] = [
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
];
