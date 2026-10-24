import * as assert from "assert";
import { suite, test } from "mocha";
import { mapOpenCodeToolPartToCliEvent } from "../../core/harness/opencode/OpenCodeEventMapper";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";

suite("OpenCodeEventMapper MCP tool names", () => {
  const part = (tool: string) => ({
    tool,
    callID: "call_opencode_mcp",
    state: {
      status: "completed",
      input: { paths: ["src/a.ts"] },
      output: "ok",
    },
  });

  test("resolves ctrlyoke_claim_paths against the attached server id", () => {
    const event = mapOpenCodeToolPartToCliEvent(
      1000,
      part("ctrlyoke_claim_paths"),
      new Set(["ctrlyoke"])
    );

    assert.strictEqual(event?.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
    assert.deepStrictEqual(event?.data, {
      server: "ctrlyoke",
      tool: "claim_paths",
      toolCallId: "call_opencode_mcp",
      parameters: { paths: ["src/a.ts"] },
      result: { success: true, output: "ok" },
    });
  });

  test("uses the longest matching attached id in the raw OpenCode name", () => {
    const ids = new Set(["ctrlyoke", "ctrlyoke-commit"]);
    const hyphenated = mapOpenCodeToolPartToCliEvent(
      1000,
      part("ctrlyoke-commit_global_status"),
      ids
    );
    const ctrlyoke = mapOpenCodeToolPartToCliEvent(
      1000,
      part("ctrlyoke_claim_paths"),
      ids
    );

    assert.strictEqual(hyphenated?.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
    assert.deepStrictEqual(hyphenated?.data, {
      server: "ctrlyoke-commit",
      tool: "global_status",
      toolCallId: "call_opencode_mcp",
      parameters: { paths: ["src/a.ts"] },
      result: { success: true, output: "ok" },
    });
    assert.strictEqual(ctrlyoke?.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
    assert.deepStrictEqual(ctrlyoke?.data, {
      server: "ctrlyoke",
      tool: "claim_paths",
      toolCallId: "call_opencode_mcp",
      parameters: { paths: ["src/a.ts"] },
      result: { success: true, output: "ok" },
    });
  });

  test("leaves unmatched names generic when servers are attached", () => {
    const event = mapOpenCodeToolPartToCliEvent(
      1000,
      part("other_claim_paths"),
      new Set(["ctrlyoke"])
    );

    assert.strictEqual(event?.type, CLI_EVENT_TYPES.TOOL_CALL);
  });

  test("leaves MCP-looking names generic without an attached server set", () => {
    const event = mapOpenCodeToolPartToCliEvent(
      1000,
      part("ctrlyoke_claim_paths")
    );

    assert.strictEqual(event?.type, CLI_EVENT_TYPES.TOOL_CALL);
  });
});

suite("OpenCodeEventMapper websearch", () => {
  // Output shape captured from `opencode run` with the websearch tool.
  const searchOutput = JSON.stringify({
    search_id: "search_1",
    results: [
      {
        url: "https://vitest.dev/blog/vitest-5.html",
        title: "Vitest 5.0 is out!",
        publish_date: null,
        excerpts: ["  Vitest 5 has several breaking changes.  ", "more"],
      },
      { url: "https://releases.sh/vitest", title: "Overview", excerpts: [] },
      { title: "no url" },
    ],
  });

  test("maps a completed websearch to a web search with its sources", () => {
    const event = mapOpenCodeToolPartToCliEvent(1000, {
      tool: "websearch",
      callID: "call_ws",
      state: {
        status: "completed",
        input: { query: "vitest latest release version" },
        output: searchOutput,
      },
    });

    assert.strictEqual(event?.type, CLI_EVENT_TYPES.WEB_SEARCH);
    assert.deepStrictEqual(event?.data, {
      query: "vitest latest release version",
      toolCallId: "call_ws",
      results: [
        {
          title: "Vitest 5.0 is out!",
          url: "https://vitest.dev/blog/vitest-5.html",
          snippet: "Vitest 5 has several breaking changes.",
        },
        { title: "Overview", url: "https://releases.sh/vitest" },
      ],
      success: true,
    });
  });

  test("keeps unparseable output as text and leaves a running search pending", () => {
    const completed = mapOpenCodeToolPartToCliEvent(1000, {
      tool: "websearch",
      callID: "call_ws",
      state: {
        status: "completed",
        input: { query: "q" },
        output: "plain text answer",
      },
    });
    const running = mapOpenCodeToolPartToCliEvent(1000, {
      tool: "websearch",
      callID: "call_ws",
      state: { status: "running", input: { query: "q" } },
    });

    assert.deepStrictEqual(completed?.data, {
      query: "q",
      toolCallId: "call_ws",
      output: "plain text answer",
      success: true,
    });
    assert.deepStrictEqual(running?.data, {
      query: "q",
      toolCallId: "call_ws",
    });
  });
});
