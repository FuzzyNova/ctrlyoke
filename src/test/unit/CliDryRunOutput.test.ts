import * as assert from "assert";
import { suite, test } from "mocha";
import { buildCliPreviewJsonResult } from "../../cli/CliJsonResultBuilder";
import { CliTerminalFormatter } from "../../cli/CliTerminalFormatter";
import type { WorkflowExecutionPreview } from "../../types/ExecutionPreviewTypes";

function previewFixture(): WorkflowExecutionPreview {
  return {
    workflow: {
      name: "fixture",
      stepCount: 1,
      harnessIds: ["claude-cli"],
      totalByteCount: 12,
      totalTokenEstimate: 3,
      workspaceMutationCount: 0,
    },
    diagnostics: [
      {
        code: "compatibility.example",
        severity: "warning",
        harnessId: "claude-cli",
        capability: "permissions",
        state: {
          fidelity: "partial",
          mechanism: "native",
          verification: "verified",
        },
        message: "A shared diagnostic",
      },
    ],
    steps: [
      {
        stepIndex: 0,
        type: "prompt",
        resolvedProperties: {
          harnessId: "claude-cli",
          executionMode: "headless",
          continuationMode: "new-session",
          session: { present: false },
          skills: [],
          mcpServerIds: ["private"],
          hooks: [],
          permissions: { allowedRules: [], deniedRules: [] },
          limits: { violations: [] },
          conditions: { pre: [], end: [], retry: { maxAttempts: 1 } },
          propertySources: {},
        },
        command: {
          executable: "claude",
          args: ["--header", "Bearer abcdefghijklmnopqrst"],
          displayCommand: "claude --header Bearer abcdefghijklmnopqrst",
          displayShell: "posix",
          requiresShellVerbatimArgs: false,
          cwd: "workspace",
          environmentKeys: ["PRIVATE_API_KEY"],
        },
        mcpApplication: {
          injectionMethod: "inline-cli-config",
          servers: [
            {
              id: "private",
              transport: "stdio",
              toolFilters: [],
              environmentKeys: ["PRIVATE_API_KEY"],
              inlineConfigFragment: '{"api_key":"super-secret-value"}',
            },
          ],
        },
        workspaceMutations: [],
        variables: [],
        conditions: { pre: [], end: [], retry: { maxAttempts: 1 } },
        diagnostics: [],
      },
    ],
  };
}

suite("CLI dry-run output", () => {
  test("redacts again at the JSON output boundary without changing the contract", () => {
    const output = buildCliPreviewJsonResult(previewFixture());
    const serialized = JSON.stringify(output);

    assert.ok(serialized.includes("compatibility.example"));
    assert.ok(serialized.includes("PRIVATE_API_KEY"));
    assert.ok(!serialized.includes("abcdefghijklmnopqrst"));
    assert.ok(!serialized.includes("super-secret-value"));
  });

  test("prints diagnostics before step details and describes truncation precisely", () => {
    const preview = previewFixture();
    preview.steps[0].prompt = {
      sections: [
        {
          category: "prompt-text",
          byteCount: 20,
          lineCount: 1,
          tokenEstimate: 5,
          chunkIndex: 0,
          contentHash: "hash",
          body: "visible",
          truncationReason: "body-budget",
        },
      ],
      totalByteCount: 20,
      includedBodyByteCount: 7,
      bodyBudgetBytes: 7,
    };

    const lines: string[] = [];
    CliTerminalFormatter.renderExecutionPreview(preview, (line) =>
      lines.push(line)
    );

    const diagnosticIndex = lines.findIndex((line) =>
      line.includes("compatibility.example")
    );
    const stepIndex = lines.findIndex((line) => line === "Steps");
    assert.ok(diagnosticIndex >= 0);
    assert.ok(stepIndex > diagnosticIndex);
    assert.ok(
      lines.some((line) =>
        line.includes("showing 7 of 20 bytes; reason=body-budget")
      )
    );
  });
});
