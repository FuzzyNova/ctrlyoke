import * as assert from "assert";
import { suite, test } from "mocha";
import { CodexResponseParser } from "../../core/harness/codex/CodexResponseParser";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";
import { TextData } from "../../types/CliOutputTypes";

function getTextEvents(
  output: ReturnType<CodexResponseParser["parse"]>
): string[] {
  return output.events
    .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
    .map((event) => (event.data as TextData).text);
}

suite("CodexResponseParser", () => {
  test("should not duplicate agent text when item.started and item.completed contain the same message", () => {
    const parser = new CodexResponseParser();
    const stdout = [
      JSON.stringify({
        type: "thread.started",
        thread_id: "thread_abc123",
      }),
      JSON.stringify({
        type: "item.started",
        item: {
          type: "agent_message",
          text: "I'm loading the handoff skill instructions now and will follow them for this turn.",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "I'm loading the handoff skill instructions now and will follow them for this turn.",
        },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
      }),
    ].join("\n");

    const output = parser.parse(stdout, "", 0);
    const textEvents = getTextEvents(output);

    assert.deepStrictEqual(textEvents, [
      "I'm loading the handoff skill instructions now and will follow them for this turn.",
    ]);
    assert.strictEqual(output.metadata.sessionId, "thread_abc123");
    assert.strictEqual(output.metadata.usage?.inputTokens, 10);
    assert.strictEqual(output.metadata.usage?.outputTokens, 5);
  });

  test("should stream completed agent text once even if item.started carried the same text", () => {
    const parser = new CodexResponseParser();
    const streamState = new Map<string, unknown>();
    const chunk = [
      JSON.stringify({
        type: "item.started",
        item: {
          type: "agent_message",
          text: "duplicate candidate",
        },
      }),
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "duplicate candidate",
        },
      }),
      "",
    ].join("\n");

    const events = parser.processStreamingChunk(chunk, streamState) || [];
    const textEvents = events
      .filter((event) => event.type === CLI_EVENT_TYPES.TEXT)
      .map((event) => (event.data as TextData).text);

    assert.deepStrictEqual(textEvents, ["duplicate candidate"]);
  });
  test("should use the resolved Codex 5.6 model for context window fallback", () => {
    const parser = new CodexResponseParser();
    parser.setCurrentModel?.("gpt-5.6-sol");

    const stdout = [
      JSON.stringify({
        type: "thread.started",
        thread_id: "thread_5_6",
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          output_tokens: 25,
        },
      }),
    ].join("\n");

    const output = parser.parse(stdout, "", 0);

    assert.strictEqual(output.metadata.model, "gpt-5.6-sol");
    assert.strictEqual(output.metadata.usage?.contextWindowSize, 1_050_000);
  });

  suite("file_change classification", () => {
    /** A started/completed pair for one `file_change` item, as Codex emits it. */
    function fileChangeLines(id: string, kind: string): string[] {
      const changes = [{ path: "src/temp.txt", kind }];
      return [
        JSON.stringify({
          type: "item.started",
          item: { id, type: "file_change", changes, status: "in_progress" },
        }),
        JSON.stringify({
          type: "item.completed",
          item: { id, type: "file_change", changes, status: "completed" },
        }),
      ];
    }

    function fileEventTypes(stdout: string): string[] {
      const parser = new CodexResponseParser();
      return parser
        .parse(stdout, "", 0)
        .events.filter((event) =>
          [
            CLI_EVENT_TYPES.FILE_WRITE,
            CLI_EVENT_TYPES.FILE_EDIT,
            CLI_EVENT_TYPES.FILE_DELETE,
          ].includes(
            event.type as
              | typeof CLI_EVENT_TYPES.FILE_WRITE
              | typeof CLI_EVENT_TYPES.FILE_EDIT
              | typeof CLI_EVENT_TYPES.FILE_DELETE
          )
        )
        .map((event) => event.type);
    }

    test("maps kind add/update/delete to write/edit/delete events", () => {
      // Codex reports all three through one `file_change` item type; only
      // `update` is a genuine edit.
      const stdout = [
        ...fileChangeLines("item_4", "add"),
        ...fileChangeLines("item_6", "update"),
        ...fileChangeLines("item_8", "delete"),
      ].join("\n");

      assert.deepStrictEqual(fileEventTypes(stdout), [
        CLI_EVENT_TYPES.FILE_WRITE,
        CLI_EVENT_TYPES.FILE_WRITE,
        CLI_EVENT_TYPES.FILE_EDIT,
        CLI_EVENT_TYPES.FILE_EDIT,
        CLI_EVENT_TYPES.FILE_DELETE,
        CLI_EVENT_TYPES.FILE_DELETE,
      ]);
    });

    test("carries path and lifecycle status through both phases", () => {
      const parser = new CodexResponseParser();
      const output = parser.parse(
        fileChangeLines("item_4", "add").join("\n"),
        "",
        0
      );

      const [initiated, completed] = output.events;
      assert.deepStrictEqual(initiated.data, {
        path: "src/temp.txt",
        status: "initiated",
        content: "",
      });
      assert.deepStrictEqual(completed.data, {
        path: "src/temp.txt",
        status: "completed",
        success: true,
        content: "",
      });
    });

    test("marks a failed file_change as failed and unsuccessful", () => {
      const parser = new CodexResponseParser();
      const stdout = JSON.stringify({
        type: "item.completed",
        item: {
          id: "item_4",
          type: "file_change",
          changes: [{ path: "src/temp.txt", kind: "update" }],
          status: "failed",
        },
      });

      const [event] = parser.parse(stdout, "", 0).events;
      assert.strictEqual(event.type, CLI_EVENT_TYPES.FILE_EDIT);
      assert.deepStrictEqual(event.data, {
        path: "src/temp.txt",
        status: "failed",
        success: false,
      });
    });
  });
});
