import * as assert from "node:assert";
import { suite, test } from "mocha";

import { HARNESS_IDS } from "../../types/DashboardConstants";
import type { WorkflowExecutionPreview } from "../../types/ExecutionPreviewTypes";
import {
  REDACTION_MARKER,
  redactPreviewText,
  redactExecutionPreview,
} from "../../types/PreviewRedactor";

function createPreview(variableValue: string): WorkflowExecutionPreview {
  return {
    parallelGroups: [],
    parallelGroupPreflights: [],
    workflow: {
      name: "redaction test",
      stepCount: 1,
      harnessIds: [HARNESS_IDS.CLAUDE_CLI],
      totalByteCount: 0,
      totalTokenEstimate: 0,
      workspaceMutationCount: 0,
    },
    steps: [
      {
        stepIndex: 0,
        type: "prompt",
        resolvedProperties: {
          harnessId: HARNESS_IDS.CLAUDE_CLI,
          skills: [],
          mcpServerIds: [],
          hooks: [],
          permissions: { allowedRules: [], deniedRules: [] },
          limits: { violations: [] },
          conditions: {
            pre: [],
            end: [],
            retry: { maxAttempts: 1 },
          },
          session: { present: false },
          propertySources: {},
        },
        variables: [
          {
            name: "credential",
            source: "prompt",
            value: variableValue,
            redactions: [],
          },
        ],
        conditions: {
          pre: [],
          end: [],
          retry: { maxAttempts: 1 },
        },
        workspaceMutations: [],
        diagnostics: [],
      },
    ],
    diagnostics: [],
  };
}

function redactedVariable(value: string) {
  return redactExecutionPreview(createPreview(value)).steps[0].variables[0];
}

suite("PreviewRedactor", () => {
  test("passes parallel group metadata through unchanged", () => {
    const preview = createPreview("safe");
    preview.parallelGroups = [
      {
        id: "group",
        startIndex: 0,
        endIndex: 1,
        failFast: true,
      },
    ];
    preview.parallelGroupPreflights = [
      {
        parallelGroupId: "group",
        effectiveWidth: 1,
        executableMemberCount: 2,
      },
    ];
    preview.steps[0].parallelGroupId = "group";

    const redacted = redactExecutionPreview(preview);

    assert.deepStrictEqual(redacted.parallelGroups, preview.parallelGroups);
    assert.deepStrictEqual(
      redacted.parallelGroupPreflights,
      preview.parallelGroupPreflights
    );
    assert.strictEqual(redacted.steps[0].parallelGroupId, "group");
  });

  test("masks private key blocks", () => {
    const result = redactedVariable(
      "-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----"
    );

    assert.strictEqual(result.value, REDACTION_MARKER);
    assert.strictEqual(result.redactions[0].ruleId, "private-key");
  });

  test("masks bearer tokens", () => {
    const result = redactedVariable("Bearer abcdefghijklmnopqrstuvwxyz123456");

    assert.strictEqual(result.value, `Bearer ${REDACTION_MARKER}`);
    assert.strictEqual(result.redactions[0].ruleId, "bearer-token");
  });

  test("masks common credential prefixes", () => {
    const result = redactedVariable("sk-1234567890abcdef");

    assert.strictEqual(result.value, REDACTION_MARKER);
    assert.strictEqual(result.redactions[0].ruleId, "credential-prefix");
  });

  test("masks credential assignments", () => {
    const result = redactedVariable("api_key=abcdefghijk123");

    assert.strictEqual(result.value, `api_key=${REDACTION_MARKER}`);
    assert.strictEqual(result.redactions[0].ruleId, "credential-assignment");
  });

  test("does not redact ctrlyoke's own ${secret:NAME} reference syntax", () => {
    const result = redactedVariable("${secret:TEST_SECRET}");

    assert.strictEqual(result.value, "${secret:TEST_SECRET}");
    assert.strictEqual(result.redactions.length, 0);
  });

  test("masks exact resolved values, including deterministic JSON escaping", () => {
    const secret = 'value-with-"quotes"';
    const result = redactPreviewText(
      `config=${JSON.stringify(secret)}`,
      [],
      [secret, JSON.stringify(secret).slice(1, -1)]
    );

    assert.strictEqual(result.text, `config="${REDACTION_MARKER}"`);
    assert.ok(result.spans.some((span) => span.ruleId === "exact-secret"));
    assert.ok(!result.text.includes(secret));
  });

  test("masks hook commands and inline MCP config fragments", () => {
    const preview = createPreview("safe");
    preview.steps[0].resolvedProperties.hooks = [
      {
        event: "notification",
        command: "notify --token=abcdefghijk123",
        redactions: [],
      },
    ];
    preview.steps[0].mcpApplication = {
      injectionMethod: "config-file",
      servers: [
        {
          id: "example",
          transport: "stdio",
          toolFilters: [],
          environmentKeys: ["MCP_TOKEN"],
          inlineConfigFragment: '{"token":"abcdefghijk123"}',
          inlineConfigRedactions: [],
        },
      ],
    };

    const result = redactExecutionPreview(preview);
    const hook = result.steps[0].resolvedProperties.hooks[0];
    const server = result.steps[0].mcpApplication?.servers[0];

    assert.strictEqual(hook.command, `notify --token=${REDACTION_MARKER}`);
    assert.ok(hook.redactions.length > 0);
    assert.strictEqual(
      server?.inlineConfigFragment,
      `{"token":"${REDACTION_MARKER}"}`
    );
    assert.ok((server?.inlineConfigRedactions?.length ?? 0) > 0);
  });

  test("is idempotent", () => {
    const preview = createPreview("token=abcdefghijk123");
    const once = redactExecutionPreview(preview);
    const twice = redactExecutionPreview(once);

    assert.deepStrictEqual(twice, once);
    assert.strictEqual(
      preview.steps[0].variables[0].value,
      "token=abcdefghijk123"
    );
  });

  test("preserves DTO shape and structurally omits environment values", () => {
    const preview = createPreview("safe-value");
    preview.steps[0].mcpApplication = {
      injectionMethod: "config-file",
      servers: [
        {
          id: "example",
          transport: "stdio",
          toolFilters: [],
          environmentKeys: ["MCP_TOKEN"],
        },
      ],
    };
    const result = redactExecutionPreview(preview);

    assert.deepStrictEqual(Object.keys(result), Object.keys(preview));
    assert.deepStrictEqual(
      Object.keys(result.steps[0]),
      Object.keys(preview.steps[0])
    );
    assert.deepStrictEqual(
      Object.keys(result.steps[0].resolvedProperties),
      Object.keys(preview.steps[0].resolvedProperties)
    );
    assert.deepStrictEqual(
      result.steps[0].resolvedProperties,
      preview.steps[0].resolvedProperties
    );

    const serialized = JSON.stringify(result);
    assert.ok(serialized.includes("environmentKeys"));
    assert.ok(!serialized.includes("MCP_SECRET_VALUE"));
  });
});
