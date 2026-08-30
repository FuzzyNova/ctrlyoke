import {
  MCP_QUEUE_TOOL_NAMES,
  MCP_TOOL_DEFINITIONS,
  type McpToolInputSchema,
} from "./McpToolDefinitions";

const MCP_SERVER_PATH_PLACEHOLDER = "<mcp-server.js path>";
const PATH_PLACEHOLDER = "<path>";

function exampleValue(schema: McpToolInputSchema): unknown {
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[0];
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
    const type = property.items
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
        return [
          `### ${tool.name}`,
          tool.description,
          renderParameters(tool.inputSchema),
          "Example:",
          `node \"${MCP_SERVER_PATH_PLACEHOLDER}\" --tool ${tool.name} --args '${args}' --workspace \"${PATH_PLACEHOLDER}\" --working-file \"${PATH_PLACEHOLDER}\"`,
        ].join("\n");
      }),
    ].join("\n\n");
  }
}

/** The built-in skill's queue-only tool subset. */
export const MCP_TOOL_SKILL_TOOL_NAMES: readonly string[] =
  MCP_QUEUE_TOOL_NAMES;
