import {
  MCP_WORKFLOW_TOOL_NAMES,
  MCP_TOOL_DEFINITIONS,
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
  type McpToolInputSchema,
} from "./McpToolDefinitions";
import { MCP_SKILL_NAMES } from "../types/DashboardConstants";

const MCP_SERVER_PATH_PLACEHOLDER = "<mcp-server.js path>";
const PATH_PLACEHOLDER = "<path>";
const COMMIT_OUTPUT_PATH_PLACEHOLDER = "<commit output path>";

function exampleValue(schema: McpToolInputSchema): unknown {
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[0];
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    return exampleValue(schema.oneOf[0]);
  }

  switch (schema.type) {
    case "object": {
      const properties = schema.properties ?? {};
      const required = new Set(schema.required ?? Object.keys(properties));
      return Object.fromEntries(
        Object.entries(properties)
          .filter(([name]) => required.has(name))
          .map(([name, property]) => [name, exampleValue(property)])
      );
    }
    case "array":
      return schema.items ? [exampleValue(schema.items)] : [];
    case "number":
      return 0;
    case "boolean":
      return false;
    case "string":
      return "example";
    default:
      return null;
  }
}

function renderParameters(schema: McpToolInputSchema): string {
  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(properties);

  if (entries.length === 0) {
    return "Parameters: none.";
  }

  const lines = entries.map(([name, property]) => {
    const requirement = required.has(name) ? "required" : "optional";
    const type = property.oneOf
      ? property.oneOf.map((variant) => variant.type).join(" or ")
      : property.items
        ? `${property.type} of ${property.items.type}`
        : property.type;
    const description = property.description
      ? ` — ${property.description}`
      : "";
    return `- \`${name}\` (${requirement}, ${type})${description}`;
  });

  return ["Parameters:", ...lines].join("\n");
}

/** Render live MCP tool definitions as instructions for the built-in skill. */
export class McpToolSkillGenerator {
  static generateToolReference(toolNames: string[]): string {
    const requestedNames = new Set(toolNames);
    const tools = MCP_TOOL_DEFINITIONS.filter((tool) =>
      requestedNames.has(tool.name)
    );

    return [
      "## Available ctrlyoke MCP tools",
      ...tools.map((tool) => {
        const args = JSON.stringify(exampleValue(tool.inputSchema));
        const command =
          tool.name === MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME
            ? `node \"${MCP_SERVER_PATH_PLACEHOLDER}\" --tool ${tool.name} --args '${args}' --workspace \"${PATH_PLACEHOLDER}\" --commit-output \"${COMMIT_OUTPUT_PATH_PLACEHOLDER}\"`
            : `node \"${MCP_SERVER_PATH_PLACEHOLDER}\" --tool ${tool.name} --args '${args}' --workspace \"${PATH_PLACEHOLDER}\" --working-file \"${PATH_PLACEHOLDER}\"`;
        return [
          `### ${tool.name}`,
          tool.description,
          renderParameters(tool.inputSchema),
          "Example:",
          command,
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
    staticContent: string
  ): string | undefined {
    const toolNames =
      skillName === MCP_SKILL_NAMES.COMMIT_MESSAGE
        ? MCP_COMMIT_MESSAGE_SKILL_TOOL_NAMES
        : skillName === MCP_SKILL_NAMES.TOOLS
          ? MCP_TOOL_SKILL_TOOL_NAMES
          : undefined;

    return toolNames
      ? `${staticContent.trimEnd()}\n\n${this.generateToolReference([...toolNames])}`
      : undefined;
  }
}

/** The built-in skill's workflow-tool subset. */
export const MCP_TOOL_SKILL_TOOL_NAMES: readonly string[] =
  MCP_WORKFLOW_TOOL_NAMES;

/** The built-in skill's commit-message tool subset. */
export const MCP_COMMIT_MESSAGE_SKILL_TOOL_NAMES: readonly string[] = [
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
];
