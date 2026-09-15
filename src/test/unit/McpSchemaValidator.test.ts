import * as assert from "assert";
import { suite, test } from "mocha";
import {
  MCP_APPEND_QUEUE_ITEM_SCHEMA,
  MCP_TOOL_DEFINITIONS,
  type McpToolInputSchema,
} from "../../utils/McpToolDefinitions";
import {
  getMcpSchemaExampleValue,
  getMcpSchemaProperties,
  getMcpSchemaRequiredProperties,
  getMcpSchemaVariants,
  validateMcpInputSchema,
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
      Record<string, unknown> | unknown[];
  }
  delete current[path[path.length - 1] as keyof typeof current];
}

function hasPath(value: unknown, path: RequiredPathSegment[]): boolean {
  let current: unknown = value;
  for (const segment of path) {
    if (current === null || typeof current !== "object") {
      return false;
    }
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, String(segment))) {
      return false;
    }
    current = record[String(segment)];
  }
  return true;
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
        if (!hasPath(args, path)) {
          return;
        }
        removePath(args, path);
        const expectedPath = displayPath(definition.name, path);
        assert.throws(
          () => validateMcpToolCall(definition.name, args),
          (error) =>
            error instanceof Error &&
            (error.message === `${expectedPath} is required` ||
              (expectedPath === "append_step.steps[0].prompt" &&
                error.message ===
                  "append_step.steps[0] must be object or object"))
        );
      });
    }
  }

  test("accepts a flat append queue item", () => {
    assert.doesNotThrow(() =>
      validateMcpInputSchema(
        MCP_APPEND_QUEUE_ITEM_SCHEMA,
        { prompt: "Implement the feature." },
        "queueItem"
      )
    );
  });

  test("accepts a valid parallel append queue item", () => {
    assert.doesNotThrow(() =>
      validateMcpInputSchema(
        MCP_APPEND_QUEUE_ITEM_SCHEMA,
        {
          parallel: [{ prompt: "Implement it." }, { prompt: "Test it." }],
          failFast: false,
        },
        "queueItem"
      )
    );
  });

  test("accepts a mixed array of flat and parallel queue items", () => {
    assert.doesNotThrow(() =>
      validateMcpInputSchema(
        { type: "array", items: MCP_APPEND_QUEUE_ITEM_SCHEMA },
        [
          { prompt: "Prepare it." },
          { parallel: [{ prompt: "Build it." }, { prompt: "Verify it." }] },
          { prompt: "Document it." },
        ],
        "queue"
      )
    );
  });

  test("rejects an empty parallel queue item", () => {
    assert.throws(
      () =>
        validateMcpInputSchema(
          MCP_APPEND_QUEUE_ITEM_SCHEMA,
          { parallel: [] },
          "queueItem"
        ),
      /queueItem must be object or object/
    );
  });

  test("rejects a one-member parallel queue item", () => {
    assert.throws(
      () =>
        validateMcpInputSchema(
          MCP_APPEND_QUEUE_ITEM_SCHEMA,
          { parallel: [{ prompt: "Only one." }] },
          "queueItem"
        ),
      /queueItem must be object or object/
    );
  });

  test("rejects a nested parallel queue item", () => {
    assert.throws(
      () =>
        validateMcpInputSchema(
          MCP_APPEND_QUEUE_ITEM_SCHEMA,
          {
            parallel: [
              { parallel: [{ prompt: "Nested." }, { prompt: "Group." }] },
              { prompt: "Flat." },
            ],
          },
          "queueItem"
        ),
      /queueItem must be object or object/
    );
  });

  test("rejects a hybrid item carrying prompt and parallel", () => {
    assert.throws(
      () =>
        validateMcpInputSchema(
          MCP_APPEND_QUEUE_ITEM_SCHEMA,
          {
            prompt: "Hybrid.",
            parallel: [{ prompt: "First." }, { prompt: "Second." }],
          },
          "queueItem"
        ),
      /queueItem must be object or object/
    );
  });

  test("rejects an unknown property on the flat branch", () => {
    assert.throws(() =>
      validateMcpInputSchema(
        MCP_APPEND_QUEUE_ITEM_SCHEMA,
        { prompt: "Known.", extra: true },
        "queueItem"
      )
    );
  });

  test("rejects an unknown property on the parallel branch", () => {
    assert.throws(() =>
      validateMcpInputSchema(
        MCP_APPEND_QUEUE_ITEM_SCHEMA,
        {
          parallel: [{ prompt: "First." }, { prompt: "Second." }],
          extra: true,
        },
        "queueItem"
      )
    );
  });

  test("enforces minItems on hand-built schemas", () => {
    assert.throws(
      () =>
        validateMcpInputSchema(
          { type: "array", minItems: 2 },
          ["only one"],
          "values"
        ),
      /values must contain at least 2 items/
    );
  });

  test("enforces additionalProperties false on hand-built schemas", () => {
    assert.throws(
      () =>
        validateMcpInputSchema(
          {
            type: "object",
            properties: { known: { type: "string" } },
            additionalProperties: false,
          },
          { known: "value", unknown: true },
          "input"
        ),
      /input\.unknown is not allowed/
    );
  });

  test("tolerates extra keys when additionalProperties is not declared", () => {
    assert.doesNotThrow(() =>
      validateMcpInputSchema(
        { type: "object", properties: { known: { type: "string" } } },
        { known: "value", extra: true },
        "input"
      )
    );
  });

  test("requires oneOf to match exactly one branch", () => {
    assert.throws(
      () =>
        validateMcpInputSchema(
          { oneOf: [{ type: "string" }, { type: "string" }] },
          "matches both",
          "value"
        ),
      /value matched more than one accepted shape/
    );
  });

  test("uses the flat queue item as the union example", () => {
    assert.deepStrictEqual(
      getMcpSchemaExampleValue(MCP_APPEND_QUEUE_ITEM_SCHEMA),
      { prompt: "example" }
    );
  });
});
