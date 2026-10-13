import * as assert from "assert";
import { suite, test } from "mocha";
import type { CliEvent } from "../../types/CliOutputTypes";
import {
  CLI_EVENT_TYPES,
  OPERATION_STATUS,
  PRIOR_CONTEXT_LIMITS,
  PRIOR_CONTEXT_TRANSCRIPT_ENTRY_KINDS as KINDS,
} from "../../types/DashboardConstants";
import {
  boundPriorContextText,
  projectPriorContextTranscript,
} from "../../core/PriorContextTranscript";

function event(
  type: CliEvent["type"],
  data: unknown,
  extra: Partial<CliEvent> = {}
): CliEvent {
  return { type, data: data as CliEvent["data"], ...extra };
}

suite("PriorContextTranscript", () => {
  test("projects terminal tails with their failure reason", () => {
    assert.deepStrictEqual(
      projectPriorContextTranscript([
        event(CLI_EVENT_TYPES.TERMINAL_OUTPUT, {
          text: "process crashed",
          reason: "exit code 1",
        }),
      ]),
      [
        {
          kind: KINDS.TERMINAL_OUTPUT,
          text: "process crashed",
          reason: "exit code 1",
        },
      ]
    );
  });

  test("projects every transcript event kind and drops display-only event kinds", () => {
    const entries = projectPriorContextTranscript([
      event(CLI_EVENT_TYPES.TEXT, { text: "answer" }),
      event(CLI_EVENT_TYPES.THINKING, { text: "reason" }),
      event(CLI_EVENT_TYPES.FILE_EDIT, {
        path: "edit.ts",
        structuredPatch: [
          {
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            lines: ["-a", "+b"],
          },
        ],
      }),
      event(CLI_EVENT_TYPES.FILE_WRITE, {
        path: "new.ts",
        content: "one\ntwo",
      }),
      event(CLI_EVENT_TYPES.FILE_DELETE, { path: "old.ts" }),
      event(CLI_EVENT_TYPES.BASH_COMMAND, {
        command: "npm test",
        exitCode: 0,
        output: "passed",
      }),
      event(CLI_EVENT_TYPES.FILE_READ, {
        path: "read.ts",
        lineStart: 4,
        lineEnd: 9,
        content: "secret",
      }),
      event(CLI_EVENT_TYPES.TOOL_CALL, {
        name: "lookup",
        parameters: { query: "value" },
        result: { success: true, output: "found" },
      }),
      event(CLI_EVENT_TYPES.MCP_TOOL_CALL, {
        server: "docs",
        tool: "search",
        parameters: { query: "api" },
        result: { success: true, output: "page" },
      }),
      event(CLI_EVENT_TYPES.WEB_SEARCH, {
        query: "topic",
        results: [{ title: "Page", url: "https://example.test" }],
      }),
      event(CLI_EVENT_TYPES.ASK_USER_QUESTION, {
        questions: [{ question: "Proceed?", options: [], answer: "Yes" }],
      }),
      event(CLI_EVENT_TYPES.USER_STEER, { text: "Keep going" }),
      event(CLI_EVENT_TYPES.COMPACTION, { trigger: "auto" }),
      event(CLI_EVENT_TYPES.FOLLOW_UP_RESUMED, { resumedAt: 1 }),
      event(CLI_EVENT_TYPES.BACKGROUND_WORK_HOLD, {
        heldAt: 1,
        pendingTasks: [],
        awaitingResumedTurn: false,
      }),
      event(CLI_EVENT_TYPES.CONTEXT_WINDOW_SYNC, { used: 1, size: 2 }),
      event(CLI_EVENT_TYPES.TOOL_RESULT, {
        toolCallId: "x",
        result: { success: true },
      }),
    ]);

    assert.deepStrictEqual(
      entries.map(({ kind }) => kind),
      [
        KINDS.TEXT,
        KINDS.THINKING,
        KINDS.EDIT,
        KINDS.CREATE,
        KINDS.DELETE,
        KINDS.COMMAND,
        KINDS.READ,
        KINDS.TOOL,
        KINDS.TOOL,
        KINDS.SEARCH,
        KINDS.QUESTION,
        KINDS.USER_STEER,
      ]
    );
    assert.deepStrictEqual(
      entries.find((entry) => entry.kind === KINDS.READ),
      {
        kind: KINDS.READ,
        path: "read.ts",
        lineStart: 4,
        lineEnd: 9,
      }
    );
  });

  test("normalizes id-less harness command twins and keeps merged output", () => {
    // Codex, OpenCode, and Antigravity report completion by command text; Qwen
    // supplies stdout only after the normalizer folds in TOOL_RESULT.
    const forHarness = (output?: string): CliEvent[] => [
      event(CLI_EVENT_TYPES.BASH_COMMAND, {
        command: "npm test",
        status: OPERATION_STATUS.INITIATED,
      }),
      ...(output
        ? [
            event(CLI_EVENT_TYPES.TOOL_RESULT, {
              result: { success: true, output },
            }),
          ]
        : [
            event(CLI_EVENT_TYPES.BASH_COMMAND, {
              command: "npm test",
              status: OPERATION_STATUS.COMPLETED,
              output: "passed",
            }),
          ]),
    ];

    for (const harness of ["codex", "opencode", "antigravity"]) {
      const projected = projectPriorContextTranscript(forHarness());
      assert.strictEqual(
        projected.filter((entry) => entry.kind === KINDS.COMMAND).length,
        1,
        harness
      );
      assert.strictEqual(
        projected[0].kind === KINDS.COMMAND && projected[0].output.text,
        "passed",
        harness
      );
    }
    const qwen = projectPriorContextTranscript(forHarness("qwen output"));
    assert.strictEqual(qwen.length, 1);
    assert.strictEqual(
      qwen[0].kind === KINDS.COMMAND && qwen[0].output.text,
      "qwen output"
    );
  });

  test("drops Claude bash_progress text marked by the parser", () => {
    const entries = projectPriorContextTranscript([
      event(
        CLI_EVENT_TYPES.TEXT,
        { text: "command progress" },
        { priorContextExcluded: true }
      ),
      event(CLI_EVENT_TYPES.TEXT, { text: "model response" }),
    ]);
    assert.deepStrictEqual(entries, [
      { kind: KINDS.TEXT, text: "model response" },
    ]);
  });

  test("caps command, tool arguments, tool results, and diffs with direction markers", () => {
    const entries = projectPriorContextTranscript([
      event(CLI_EVENT_TYPES.BASH_COMMAND, {
        command: "npm test",
        output: `${"x\n".repeat(1300)}FINAL\n`,
      }),
      event(CLI_EVENT_TYPES.TOOL_CALL, {
        name: "tool",
        parameters: { data: "x".repeat(800) },
        result: { success: true, output: `${"old\n".repeat(400)}END` },
      }),
      event(CLI_EVENT_TYPES.FILE_EDIT, {
        path: "large.ts",
        oldContent: "",
        newContent: `${"line\n".repeat(15000)}end`,
      }),
    ]);
    const command = entries[0];
    assert.strictEqual(command.kind, KINDS.COMMAND);
    if (command.kind === KINDS.COMMAND) {
      assert.ok(
        Buffer.byteLength(command.output.text) <=
          PRIOR_CONTEXT_LIMITS.COMMAND_OUTPUT_TAIL_BYTES
      );
      assert.strictEqual(command.output.omitted, "start");
      assert.ok(command.output.text.includes("FINAL"));
    }
    const tool = entries[1];
    assert.strictEqual(tool.kind, KINDS.TOOL);
    if (tool.kind === KINDS.TOOL) {
      assert.ok(
        Buffer.byteLength(tool.arguments.text) <=
          PRIOR_CONTEXT_LIMITS.TOOL_ARGUMENTS_HEAD_BYTES
      );
      assert.strictEqual(tool.arguments.omitted, "end");
      assert.ok(
        Buffer.byteLength(tool.result.text) <=
          PRIOR_CONTEXT_LIMITS.TOOL_RESULT_TAIL_BYTES
      );
      assert.strictEqual(tool.result.omitted, "start");
      assert.ok(tool.result.text.endsWith("END"));
    }
    const edit = entries[2];
    assert.strictEqual(edit.kind, KINDS.EDIT);
    if (edit.kind === KINDS.EDIT) {
      assert.ok(
        Buffer.byteLength(edit.diff?.text ?? "") <=
          PRIOR_CONTEXT_LIMITS.DIFF_BYTES
      );
      assert.strictEqual(edit.diff?.omitted, "end");
      assert.ok(edit.added > 0);
    }
  });

  test("prefers line boundaries while respecting UTF-8 code point boundaries", () => {
    const lineBounded = boundPriorContextText("one\nββ\nend", 5, "tail");
    assert.deepStrictEqual(lineBounded, {
      text: "\nend",
      omitted: "start",
      omittedBytes: 8,
    });

    const longCodePointLine = boundPriorContextText("a😀b", 5, "tail");
    assert.strictEqual(longCodePointLine.text, "😀b");
    assert.strictEqual(Buffer.byteLength(longCodePointLine.text), 5);
    assert.strictEqual(longCodePointLine.omittedBytes, 1);
  });

  test("marks failed operations and suppresses failed edit diffs", () => {
    const entries = projectPriorContextTranscript([
      event(CLI_EVENT_TYPES.FILE_EDIT, {
        path: "failed.ts",
        status: OPERATION_STATUS.FAILED,
        oldContent: "old",
        newContent: "new",
      }),
      event(CLI_EVENT_TYPES.FILE_DELETE, {
        path: "missing.ts",
        success: false,
      }),
      event(CLI_EVENT_TYPES.BASH_COMMAND, {
        command: "false",
        exitCode: 1,
        error: "failure",
      }),
      event(CLI_EVENT_TYPES.ASK_USER_QUESTION, {
        status: OPERATION_STATUS.FAILED,
        questions: [{ question: "Proceed?", options: [] }],
      }),
    ]);
    assert.strictEqual(
      entries.every((entry) => entry.failed),
      true
    );
    assert.strictEqual(
      entries[0].kind === KINDS.EDIT && entries[0].diff,
      undefined
    );
  });
});
