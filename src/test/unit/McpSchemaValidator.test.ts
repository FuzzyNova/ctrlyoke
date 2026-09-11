import * as assert from "assert";
import { suite, test } from "mocha";
import {
  MCP_TOOL_DEFINITIONS,
  type McpToolInputSchema,
} from "../../utils/McpToolDefinitions";
import {
  getMcpSchemaExampleValue,
  getMcpSchemaProperties,
  getMcpSchemaRequiredProperties,
  getMcpSchemaVariants,
  validateMcpToolCall,
} from "../../utils/McpSchemaValidator";

type RequiredPathSegment = string | number;

function requiredPaths(
  schema: McpToolInputSchema,
  path: RequiredPathSegment[] = []
): RequiredPathSegment[][] {
  const paths: RequiredPathSegment[][] = [];
  for (const required of getMcpSchemaRequiredProperties(schema)) {
    paths.push([...path, required]);
  }
  for (const [name, property] of getMcpSchemaProperties(schema)) {
    paths.push(...requiredPaths(property, [...path, name]));
  }
  for (const variant of getMcpSchemaVariants(schema)) {
    paths.push(...requiredPaths(variant, path));
  }
  if (schema.items) {
    paths.push(...requiredPaths(schema.items, [...path, 0]));
  }
  return paths;
}

function displayPath(toolName: string, path: RequiredPathSegment[]): string {
  return path.reduce<string>(
    (result, segment) =>
      typeof segment === "number"
        ? `${result}[${segment}]`
        : `${result}.${segment}`,
    toolName
  );
}

function removePath(value: unknown, path: RequiredPathSegment[]): void {
  let current = value as Record<string, unknown> | unknown[];
  for (const segment of path.slice(0, -1)) {
    current = current[segment as keyof typeof current] as
      | Record<string, unknown>
      | unknown[];
  }
  delete current[path[path.length - 1] as keyof typeof current];
}

suite("MCP tool schema validation", () => {
  for (const definition of MCP_TOOL_DEFINITIONS) {
    test(`${definition.name} accepts its schema example`, () => {
      const args = getMcpSchemaExampleValue(definition.inputSchema);
      assert.doesNotThrow(() => validateMcpToolCall(definition.name, args));
    });

    for (const path of requiredPaths(definition.inputSchema)) {
      test(`${definition.name} reports missing ${displayPath(definition.name, path)}`, () => {
        const args = getMcpSchemaExampleValue(definition.inputSchema);
        removePath(args, path);
        const expectedPath = displayPath(definition.name, path);
        assert.throws(
          () => validateMcpToolCall(definition.name, args),
          (error) =>
            error instanceof Error &&
            error.message === `${expectedPath} is required`
        );
      });
    }
  }
});
