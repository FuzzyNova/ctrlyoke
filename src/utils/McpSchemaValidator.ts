import {
  MCP_TOOL_DEFINITIONS,
  type McpToolInputSchema,
  type McpToolName,
  type ValidatedMcpToolCall,
} from "./McpToolDefinitions";

const MCP_SCHEMA_TYPES = {
  OBJECT: "object",
  STRING: "string",
  NUMBER: "number",
  BOOLEAN: "boolean",
  ARRAY: "array",
} as const;

export function getMcpSchemaProperties(
  schema: McpToolInputSchema
): [string, McpToolInputSchema][] {
  return Object.entries(schema.properties ?? {});
}

export function getMcpSchemaRequiredProperties(
  schema: McpToolInputSchema
): ReadonlySet<string> {
  return new Set(schema.required ?? []);
}

export function getMcpSchemaVariants(
  schema: McpToolInputSchema
): readonly McpToolInputSchema[] {
  return schema.oneOf ?? [];
}

export function getMcpSchemaExampleValue(schema: McpToolInputSchema): unknown {
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[0];
  }
  const variants = getMcpSchemaVariants(schema);
  if (variants.length > 0) {
    return getMcpSchemaExampleValue(variants[0]);
  }

  switch (schema.type) {
    case MCP_SCHEMA_TYPES.OBJECT: {
      const properties = getMcpSchemaProperties(schema);
      const required = new Set(
        schema.required ?? properties.map(([name]) => name)
      );
      return Object.fromEntries(
        properties
          .filter(([name]) => required.has(name))
          .map(([name, property]) => [name, getMcpSchemaExampleValue(property)])
      );
    }
    case MCP_SCHEMA_TYPES.ARRAY:
      return schema.items ? [getMcpSchemaExampleValue(schema.items)] : [];
    case "number":
      return schema.minimum ?? 0;
    case "boolean":
      return false;
    case MCP_SCHEMA_TYPES.STRING:
      return "example";
    default:
      return null;
  }
}

export function getMcpSchemaTypeDescription(
  schema: McpToolInputSchema
): string {
  const variants = getMcpSchemaVariants(schema);
  if (variants.length > 0) {
    return variants.map(getMcpSchemaTypeDescription).join(" or ");
  }
  if (schema.items) {
    return `${schema.type} of ${getMcpSchemaTypeDescription(schema.items)}`;
  }
  return schema.type ?? "value";
}

function expectedDescription(schema: McpToolInputSchema): string {
  const variants = getMcpSchemaVariants(schema);
  if (variants.length > 0) {
    return variants.map(expectedDescription).join(" or ");
  }
  if (schema.enum && schema.enum.length > 0) {
    return `one of ${schema.enum.map((value) => JSON.stringify(value)).join(", ")}`;
  }
  const type = getMcpSchemaTypeDescription(schema);
  return schema.minimum !== undefined
    ? `${type} greater than or equal to ${schema.minimum}`
    : type;
}

function validateSchema(
  schema: McpToolInputSchema,
  value: unknown,
  fieldPath: string
): void {
  const variants = getMcpSchemaVariants(schema);
  if (variants.length > 0) {
    for (const variant of variants) {
      try {
        validateSchema(variant, value, fieldPath);
        return;
      } catch {
        // Try the next oneOf branch before reporting the combined expectation.
      }
    }
    throw new Error(`${fieldPath} must be ${expectedDescription(schema)}`);
  }

  if (schema.enum && !schema.enum.includes(value as string)) {
    throw new Error(`${fieldPath} must be ${expectedDescription(schema)}`);
  }

  switch (schema.type) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${fieldPath} must be an object`);
      }
      const record = value as Record<string, unknown>;
      for (const required of getMcpSchemaRequiredProperties(schema)) {
        if (record[required] === undefined) {
          throw new Error(`${fieldPath}.${required} is required`);
        }
      }
      for (const [name, property] of getMcpSchemaProperties(schema)) {
        if (record[name] !== undefined) {
          validateSchema(property, record[name], `${fieldPath}.${name}`);
        }
      }
      return;
    }
    case "array":
      if (!Array.isArray(value)) {
        throw new Error(`${fieldPath} must be an array`);
      }
      if (schema.items) {
        value.forEach((item, index) =>
          validateSchema(schema.items!, item, `${fieldPath}[${index}]`)
        );
      }
      return;
    case "string":
      if (typeof value !== "string") {
        throw new Error(`${fieldPath} must be a string`);
      }
      return;
    case MCP_SCHEMA_TYPES.NUMBER:
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`${fieldPath} must be a number`);
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw new Error(
          `${fieldPath} must be greater than or equal to ${schema.minimum}`
        );
      }
      return;
    case MCP_SCHEMA_TYPES.BOOLEAN:
      if (typeof value !== "boolean") {
        throw new Error(`${fieldPath} must be a boolean`);
      }
      return;
    default:
      throw new Error(`${fieldPath} has an unsupported schema type`);
  }
}

export function validateMcpInputSchema(
  schema: McpToolInputSchema,
  args: unknown,
  toolName: string
): unknown {
  const normalizedArgs =
    args === undefined && schema.type === MCP_SCHEMA_TYPES.OBJECT ? {} : args;
  validateSchema(schema, normalizedArgs, toolName);
  return normalizedArgs;
}

function isMcpToolName(name: string): name is McpToolName {
  return MCP_TOOL_DEFINITIONS.some((tool) => tool.name === name);
}

/** Validate a call once and preserve the tool/argument relationship for dispatch. */
export function validateMcpToolCall(
  name: string,
  args: unknown
): ValidatedMcpToolCall {
  if (!isMcpToolName(name)) {
    throw new Error(`Unknown tool: ${name}`);
  }
  const definition = MCP_TOOL_DEFINITIONS.find((tool) => tool.name === name)!;
  const validatedArgs = validateMcpInputSchema(
    definition.inputSchema,
    args,
    name
  );

  // The schema is runtime data; this is the single boundary where its checked
  // value is connected to the named TypeScript argument contract.
  return { name, args: validatedArgs } as ValidatedMcpToolCall;
}
