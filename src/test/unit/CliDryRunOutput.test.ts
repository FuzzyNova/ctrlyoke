import * as assert from "assert";
import { execFileSync } from "child_process";
import chalk from "chalk";
import * as path from "path";
import { suite, test } from "mocha";
import { buildCliPreviewJsonResult } from "../../cli/CliJsonResultBuilder";
import { CliTerminalFormatter } from "../../cli/CliTerminalFormatter";
import type { WorkflowExecutionPreview } from "../../types/ExecutionPreviewTypes";
import {
  PREVIEW_PROMPT_CATEGORIES,
  PREVIEW_PROMPT_CATEGORY_LABELS,
  PREVIEW_TRUNCATION_REASON_COPY,
  PREVIEW_TRUNCATION_REASONS,
  type PreviewPromptCategory,
} from "../../types/DashboardConstants";

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
  test("renders MCP parameters and results in terminal output", () => {
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const formatterPath = path.join(
      repoRoot,
      "out",
      "cli",
      "CliTerminalFormatter.js"
    );
    const constantsPath = path.join(
      repoRoot,
      "out",
      "types",
      "DashboardConstants.js"
    );
    const output = execFileSync(
      process.execPath,
      [
        "-e",
        `const { CliTerminalFormatter } = require(${JSON.stringify(formatterPath)});
const { CLI_EVENT_TYPES } = require(${JSON.stringify(constantsPath)});
CliTerminalFormatter.renderEvent({
  type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
  data: {
    server: "queue",
    tool: "append",
    parameters: { prompt: "terminal parameter output" },
    result: { success: true, output: "terminal result output" },
  },
});`,
      ],
      { encoding: "utf8" }
    );

    assert.ok(output.includes("⚙ queue:append"));
    assert.ok(
      output.includes('{"prompt":"terminal parameter output"}')
    );
    assert.ok(output.includes("⎿  terminal result output"));
  });

  test("keeps category labels exhaustive", () => {
    const labels: Record<PreviewPromptCategory, string> =
      PREVIEW_PROMPT_CATEGORY_LABELS;
    assert.deepStrictEqual(
      Object.keys(labels).sort(),
      Object.values(PREVIEW_PROMPT_CATEGORIES).sort()
    );
  });

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

  test("renders not-yet-available prior context neutrally with distinct delivery copy", () => {
    const previousLevel = chalk.level;
    chalk.level = 1;
    try {
      const preview = previewFixture();
      preview.steps[0].prompt = {
        sections: [
          {
            category: PREVIEW_PROMPT_CATEGORIES.PRIOR_CONTEXT,
            byteCount: 0,
            lineCount: null,
            tokenEstimate: 0,
            chunkIndex: 0,
            contentHash: null,
            truncationReason: PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE,
          },
        ],
        totalByteCount: 0,
        includedBodyByteCount: 0,
        bodyBudgetBytes: 7,
      };

      const lines: string[] = [];
      CliTerminalFormatter.renderExecutionPreview(preview, (line) =>
        lines.push(line)
      );

      const delivery = lines.find((line) =>
        line.includes("reason=not-yet-available")
      );
      assert.ok(delivery);
      assert.ok(
        delivery.includes(
          PREVIEW_TRUNCATION_REASON_COPY[
            PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE
          ]
        )
      );
      assert.ok(
        !delivery.includes("the harness receives the provider reference")
      );
      assert.ok(
        !delivery.includes("the full planned payload remains available")
      );
      assert.ok(!delivery.includes("\u001b[33m"));
      assert.ok(lines.some((line) => line.includes("Prior context")));
    } finally {
      chalk.level = previousLevel;
    }
  });

  test("shares direct-reference delivery copy with the dashboard", () => {
    const preview = previewFixture();
    preview.steps[0].prompt = {
      sections: [
        {
          category: PREVIEW_PROMPT_CATEGORIES.FILE_REFERENCE,
          byteCount: 24,
          lineCount: null,
          tokenEstimate: 6,
          chunkIndex: 0,
          contentHash: null,
          truncationReason: PREVIEW_TRUNCATION_REASONS.REFERENCE,
          path: "C:\\workspace\\README.md",
        },
      ],
      totalByteCount: 24,
      includedBodyByteCount: 0,
      bodyBudgetBytes: 7,
    };

    const lines: string[] = [];
    CliTerminalFormatter.renderExecutionPreview(preview, (line) =>
      lines.push(line)
    );

    assert.ok(
      lines.some((line) =>
        line.includes(
          PREVIEW_TRUNCATION_REASON_COPY[PREVIEW_TRUNCATION_REASONS.REFERENCE]
        )
      )
    );
  });
});
