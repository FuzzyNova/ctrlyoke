import * as assert from "assert";
import { execFileSync } from "child_process";
import chalk from "chalk";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
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
    parallelGroups: [],
    parallelGroupPreflights: [],
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
          limits: { violations: [], maxStepsSource: "setting queue.maxSteps" },
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

/** `out/test/unit` -> `out`: these cases require the compiled formatter. */
const COMPILED_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Runs `body` in a child Node process with the compiled formatter and
 * `CLI_EVENT_TYPES` already required, and returns everything it wrote to
 * stdout.
 *
 * `FORCE_COLOR: "0"` is the load-bearing part. See the suite's `setup` below:
 * the child inherits the environment, so without this it colours its output
 * exactly when the developer's terminal is a TTY.
 */
function runFormatterScript(body: string): string {
  const requirePath = (...segments: string[]): string =>
    JSON.stringify(path.join(COMPILED_ROOT, ...segments));
  return execFileSync(
    process.execPath,
    [
      "-e",
      `const { CliTerminalFormatter } = require(${requirePath("cli", "CliTerminalFormatter.js")});
const { CLI_EVENT_TYPES, OPERATION_STATUS, COMPACTION_TRIGGERS, SCRIPT_OUTPUT_SOURCES } = require(${requirePath("types", "DashboardConstants.js")});
${body}`,
    ],
    { encoding: "utf8", env: { ...process.env, FORCE_COLOR: "0" } }
  );
}

suite("CLI dry-run output", () => {
  /**
   * These cases assert on the formatter's *structure* — heading text, ordering,
   * indentation — so they must see it uncoloured, and chalk's level is ambient:
   * `npm` exports `FORCE_COLOR` to the scripts it runs whenever its own stdout
   * is a TTY, and chalk honours that in preference to `isTTY`. That is why a
   * bare `npm test` failed here while `npm test > out.log` passed — the
   * redirect is what stopped npm exporting the variable. Pin the level instead
   * of inheriting it; the one case that needs colour turns it back on itself.
   */
  let previousChalkLevel: typeof chalk.level;

  setup(() => {
    previousChalkLevel = chalk.level;
    chalk.level = 0;
  });

  teardown(() => {
    chalk.level = previousChalkLevel;
  });

  /**
   * `--no-color` used to be implemented as `process.env.NO_COLOR = "1"` inside
   * the command action, which never took effect: chalk 5 resolves its level
   * once while the module initializes, and in the bundle that is long before
   * any action runs. The flag therefore did nothing in a TTY — the only place
   * it could have mattered, since a redirected stream is already uncoloured.
   * These two cases pin the mechanism rather than the symptom.
   */
  test("setColorEnabled(false) strips colour from subsequent chalk calls", () => {
    chalk.level = 3;
    process.env.NO_COLOR = "1";
    try {
      assert.strictEqual(
        chalk.red("x"),
        "\u001b[31mx\u001b[39m",
        "an env write after chalk initialized must not be what disables colour"
      );

      CliTerminalFormatter.setColorEnabled(false);

      assert.strictEqual(chalk.level, 0);
      assert.strictEqual(chalk.red("x"), "x");
      assert.strictEqual(chalk.bold(chalk.dim("y")), "y");
      assert.strictEqual(chalk.hex("#ff0000")("z"), "z");
    } finally {
      delete process.env.NO_COLOR;
    }
  });

  test("setColorEnabled(true) leaves chalk's own stream detection alone", () => {
    chalk.level = 0;
    CliTerminalFormatter.setColorEnabled(true);
    assert.strictEqual(
      chalk.level,
      0,
      "omitting --no-color must not force colour onto a redirected stream"
    );
  });

  test("keeps concurrent headless bursts identified by target", () => {
    const output = runFormatterScript(
      `CliTerminalFormatter.renderEvents([{ type: CLI_EVENT_TYPES.TEXT, data: { text: "research" } }], { stepIndex: 1, stepName: "research-auth" });
CliTerminalFormatter.renderEvents([{ type: CLI_EVENT_TYPES.TEXT, data: { text: "done" } }], { stepIndex: 2, stepName: "unit-tests" });
CliTerminalFormatter.flushStreamingBuffer();`
    );

    assert.ok(output.includes("[2 research-auth] research"));
    assert.ok(output.includes("[3 unit-tests] done"));
  });

  test("renders MCP parameters and results in terminal output", () => {
    const output = runFormatterScript(
      `CliTerminalFormatter.renderEvent({
  type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
  data: {
    server: "queue",
    tool: "append",
    parameters: { prompt: "terminal parameter output" },
    result: { success: true, output: "terminal result output" },
  },
});`
    );

    assert.ok(output.includes("⚙ queue:append"));
    assert.ok(output.includes('{"prompt":"terminal parameter output"}'));
    assert.ok(output.includes("⎿  terminal result output"));
  });

  test("renders ask-user-question prompts, options, and resolution", () => {
    const output = runFormatterScript(
      `CliTerminalFormatter.renderEvent({
  type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
  data: {
    status: OPERATION_STATUS.INITIATED,
    questions: [{
      question: "Which deployment target?",
      options: [
        { label: "Staging", description: "Shared test environment" },
        { label: "Production", description: "Live environment" },
      ],
    }],
  },
});
CliTerminalFormatter.renderEvent({
  type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
  data: {
    status: OPERATION_STATUS.COMPLETED,
    questions: [{
      question: "Which deployment target?",
      options: [{ label: "Staging" }, { label: "Production" }],
      answer: "Staging",
    }],
  },
});
CliTerminalFormatter.renderEvent({
  type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
  data: {
    status: OPERATION_STATUS.FAILED,
    questions: [{ question: "Continue?", options: [] }],
    declined: { reason: "rejected" },
  },
});`
    );

    assert.ok(output.includes("Asked 1 question"));
    assert.ok(output.includes("Which deployment target?"));
    assert.ok(output.includes("Staging"));
    assert.ok(output.includes("Answered 1 question"));
    assert.ok(output.includes("Answer: Staging"));
    assert.ok(output.includes("Question declined"));
    assert.ok(output.includes("⎿ Question declined"));
  });

  test("truncates ask-user-question preview art with a notice", () => {
    const output = runFormatterScript(
      `CliTerminalFormatter.renderEvent({
  type: CLI_EVENT_TYPES.ASK_USER_QUESTION,
  data: {
    questions: [{
      question: "Choose a layout",
      options: [{
        label: "Grid",
        preview: Array.from({ length: 10 }, (_, index) => "preview line " + index).join("\\n"),
      }],
    }],
  },
});`
    );

    assert.ok(output.includes("preview line 7"));
    assert.ok(!output.includes("preview line 8"));
    assert.ok(output.includes("… 2 more lines"));
  });

  test("renders compaction details and truncates its summary with a notice", () => {
    const output = runFormatterScript(
      `CliTerminalFormatter.renderEvent({
  type: CLI_EVENT_TYPES.COMPACTION,
  data: {
    trigger: COMPACTION_TRIGGERS.AUTO,
    preTokens: 12000,
    postTokens: 2400,
    summary: Array.from({ length: 10 }, (_, index) => "summary line " + index).join("\\n"),
  },
});`
    );

    assert.ok(output.includes("Conversation compacted (auto)"));
    assert.ok(output.includes("12,000 → 2,400 tokens"));
    assert.ok(output.includes("summary line 7"));
    assert.ok(!output.includes("summary line 8"));
    assert.ok(output.includes("… 2 more lines"));
  });

  test("renders a follow-up-resumed divider", () => {
    const output = runFormatterScript(
      `CliTerminalFormatter.renderEvent({
  type: CLI_EVENT_TYPES.FOLLOW_UP_RESUMED,
  data: { resumedAt: 0 },
});`
    );

    assert.ok(output.includes("Follow-up resumed"));
  });

  test("renders pass, fail, and errored script verdicts", () => {
    const output = runFormatterScript(`
CliTerminalFormatter.renderScriptOutput({
  source: SCRIPT_OUTPUT_SOURCES.PRE_CONDITION,
  response: "ok",
  elapsed: 0.012,
  isStreaming: false,
  scriptVerdict: {
    compareSource: "stdout",
    operator: "eq",
    expected: "ok",
    actual: "ok",
    exitCode: 0,
    outcome: "passed",
    action: "continue",
    durationMs: 12,
  },
}, { stepIndex: 0, stepName: "pre-condition", key: "pass" });
CliTerminalFormatter.renderScriptOutput({
  source: SCRIPT_OUTPUT_SOURCES.END_CONDITION,
  response: "bad",
  elapsed: 0.034,
  isStreaming: false,
  scriptVerdict: {
    compareSource: "stdout",
    operator: "eq",
    expected: "ok",
    actual: "bad",
    exitCode: 1,
    outcome: "failed",
    action: "retry",
    actionDetail: "retry 1 of 3",
    durationMs: 34,
  },
}, { stepIndex: 1, stepName: "end-condition", key: "fail" });
CliTerminalFormatter.renderScriptOutput({
  source: SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP,
  response: "spawn failed",
  elapsed: 0.056,
  isStreaming: false,
  scriptVerdict: {
    compareSource: "exitCode",
    operator: "eq",
    actual: "",
    outcome: "errored",
    action: "stopWorkflow",
    durationMs: 56,
    timedOut: true,
    error: "spawn failed",
  },
}, { stepIndex: 2, stepName: "worktree-setup", key: "error" });`);

    assert.ok(output.includes("Passed"));
    assert.ok(output.includes("Failed"));
    assert.ok(output.includes("Errored"));
    assert.ok(output.includes("Compare: stdout == ok"));
    assert.ok(output.includes("Expected: ok"));
    assert.ok(output.includes("Actual: bad"));
    assert.ok(output.includes("Action: retry (retry 1 of 3)"));
    assert.ok(output.includes("Timed out: yes"));
    assert.ok(output.includes("Error: spawn failed"));
  });

  test("bounds streamed script output with an explicit notice", () => {
    const output = runFormatterScript(`
const chunk = Array.from({ length: 240 }, (_, index) => "line " + index + "\\n").join("");
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP, response: "", elapsed: 0, isStreaming: true, cliCommand: "check.sh" }, { stepIndex: 0, stepName: "script", key: "bounded" });
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP, response: chunk, elapsed: 0, isStreaming: true }, { stepIndex: 0, stepName: "script", key: "bounded" });
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP, response: chunk, elapsed: 0, isStreaming: false, scriptVerdict: { compareSource: "stdout", actual: "ok", actualSource: "stdout", outcome: "passed", matchRule: "exact", action: "continue", durationMs: 1 } }, { stepIndex: 0, stepName: "script", key: "bounded" });`);

    assert.ok(output.includes("line 199"));
    assert.ok(!output.includes("line 200"));
    assert.ok(output.includes("script output truncated"));
    assert.ok(output.includes("40 more lines"));
  });

  test("does not count single-character chunks as separate script lines", () => {
    const output = runFormatterScript(`
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP, response: "", elapsed: 0, isStreaming: true }, { stepIndex: 0, stepName: "script", key: "single-char" });
for (let index = 0; index < 300; index++) {
  CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP, response: ".", elapsed: 0, isStreaming: true }, { stepIndex: 0, stepName: "script", key: "single-char" });
}
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP, response: ".".repeat(300), elapsed: 0, isStreaming: false }, { stepIndex: 0, stepName: "script", key: "single-char" });`);

    assert.ok(output.includes(".".repeat(300)));
    assert.ok(!output.includes("script output truncated"));
  });

  test("counts a line split across chunks once", () => {
    const output = runFormatterScript(`
const firstChunk = Array.from({ length: 199 }, (_, index) => "line " + index + "\\n").join("");
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP, response: "", elapsed: 0, isStreaming: true }, { stepIndex: 0, stepName: "script", key: "split-line" });
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP, response: firstChunk, elapsed: 0, isStreaming: true }, { stepIndex: 0, stepName: "script", key: "split-line" });
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP, response: "split ", elapsed: 0, isStreaming: true }, { stepIndex: 0, stepName: "script", key: "split-line" });
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP, response: "line\\nlast\\n", elapsed: 0, isStreaming: true }, { stepIndex: 0, stepName: "script", key: "split-line" });
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP, response: firstChunk + "split line\\nlast\\n", elapsed: 0, isStreaming: false }, { stepIndex: 0, stepName: "script", key: "split-line" });`);

    assert.ok(output.includes("split line"));
    assert.ok(output.includes("script output truncated: 1 more lines"));
    assert.ok(!output.includes("script output truncated: 2 more lines"));
  });

  test("labels condition, worktree-setup, and ordinary script headers", () => {
    const output = runFormatterScript(`
const verdict = { compareSource: "exitCode", actual: "0", actualSource: "exitCode", outcome: "passed", matchRule: "exitCode", action: "continue", durationMs: 1 };
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.PRE_CONDITION, response: "ok", elapsed: 0, isStreaming: false, scriptVerdict: verdict }, { stepIndex: 0, stepName: "build", key: "pre" });
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.END_CONDITION, response: "ok", elapsed: 0, isStreaming: false, attemptIndex: 1, scriptVerdict: verdict }, { stepIndex: 0, stepName: "build", key: "end" });
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.WORKTREE_SETUP, response: "ok", elapsed: 0, isStreaming: false, scriptVerdict: verdict }, { stepIndex: 0, stepName: "setup", key: "setup" });
CliTerminalFormatter.renderScriptOutput({ source: SCRIPT_OUTPUT_SOURCES.SCRIPT_STEP, response: "ok", elapsed: 0, isStreaming: false, scriptVerdict: verdict }, { stepIndex: 0, stepName: "script", key: "script" });`);

    assert.ok(output.includes("[Pre-condition] build"));
    assert.ok(output.includes("[End condition retry 2] build"));
    assert.ok(output.includes("[Worktree setup] setup"));
    assert.ok(output.includes("[Script step] script"));
  });

  test("labels final-step loop iterations", () => {
    const output = runFormatterScript(
      `CliTerminalFormatter.renderFinalStepLabel(2);`
    );

    assert.ok(output.includes("Final Step Loop 3"));
  });

  test("shows per-attempt harness and model with a bounded prompt preview", () => {
    const output = runFormatterScript(`
const prompt = Array.from({ length: 25 }, (_, index) => "prompt line " + index).join("\\n");
CliTerminalFormatter.renderPromptHeader({ stepIndex: 0, totalSteps: 1, stepName: "override", promptText: prompt, attemptIndex: 1, runIndex: 0, harness: "claude-cli", model: "claude-sonnet-4.5" });`);

    assert.ok(output.includes("Harness: claude-cli"));
    assert.ok(output.includes("Model: claude-sonnet-4.5"));
    assert.ok(output.includes("prompt line 19"));
    assert.ok(!output.includes("prompt line 20"));
    assert.ok(
      output.includes("… 5 more lines (see .ctrlyoke/.runs/…/events.jsonl)")
    );
  });

  test("adds full-record notices to diff, MCP parameter, and tool-result truncation", () => {
    const output = runFormatterScript(`
CliTerminalFormatter.renderEvent({
  type: CLI_EVENT_TYPES.FILE_EDIT,
  data: { path: "large.ts", status: OPERATION_STATUS.COMPLETED, oldContent: "", newContent: Array.from({ length: 70 }, (_, index) => "added " + index).join("\\n") },
});
const long = "x".repeat(150);
CliTerminalFormatter.renderEvent({ type: CLI_EVENT_TYPES.MCP_TOOL_CALL, data: { server: "queue", tool: "append", parameters: { value: long } } });
CliTerminalFormatter.renderEvent({ type: CLI_EVENT_TYPES.TOOL_RESULT, data: { result: { success: true, output: long } } });`);

    assert.ok(
      output.includes("… 10 more lines (see .ctrlyoke/.runs/…/events.jsonl)")
    );
    assert.ok(
      (output.match(/more characters \(see \.ctrlyoke/g) ?? []).length >= 2
    );
  });

  test("renders parallel-group tally transitions, including a failed branch", () => {
    const output = runFormatterScript(`
CliTerminalFormatter.renderParallelGroupHeader({ id: "research", startIndex: 0, endIndex: 1, failFast: false }, 2);
CliTerminalFormatter.renderParallelGroupProgress("research", 1, 0, 0);
CliTerminalFormatter.renderParallelGroupProgress("research", 1, 1, 0);
CliTerminalFormatter.renderParallelGroupProgress("research", 0, 1, 1);`);

    assert.ok(output.includes("Parallel group research — 2 member(s)"));
    assert.ok(
      output.includes("Parallel group research: 1 running · 0 done · 0 failed")
    );
    assert.ok(
      output.includes("Parallel group research: 1 running · 1 done · 0 failed")
    );
    assert.ok(
      output.includes("Parallel group research: 0 running · 1 done · 1 failed")
    );
  });

  test("renders the closing retry-attempt aggregate", () => {
    const output = runFormatterScript(
      `CliTerminalFormatter.renderAttemptGroupSummary("compile", 3, 12.75);`
    );

    assert.ok(output.includes("↻ compile: 3 attempts · 12.75s total"));
  });

  test("keeps a single non-parallel, non-retried prompt byte-for-byte unchanged", () => {
    const output = runFormatterScript(`
CliTerminalFormatter.renderPromptHeader({ stepIndex: 0, totalSteps: 1, stepName: "single", promptText: "do work", attemptIndex: 0, runIndex: 0 });
CliTerminalFormatter.renderPromptHeader({ stepIndex: 0, totalSteps: 1, stepName: "single", promptText: "do work", attemptIndex: 0, runIndex: 0, cliCommand: "harness run" });`);

    assert.strictEqual(
      output,
      [
        "",
        "─".repeat(52),
        "│ Step 1/1 — single",
        "│ do work",
        "",
        "│ $ harness run",
        "",
        "",
      ].join("\n")
    );
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

  test("renders parallel group headings and indents members", () => {
    const preview = previewFixture();
    preview.workflow.stepCount = 2;
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
    preview.steps.push({
      ...preview.steps[0],
      stepIndex: 1,
      parallelGroupId: "group",
    });

    const lines: string[] = [];
    CliTerminalFormatter.renderExecutionPreview(preview, (line) =>
      lines.push(line)
    );

    assert.ok(lines.includes("Parallel steps 1–2 (failFast)"));
    assert.ok(lines.includes("  runs sequentially"));
    assert.ok(lines.some((line) => line.startsWith("  Step 1")));
    assert.ok(lines.some((line) => line.startsWith("  Step 2")));
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
