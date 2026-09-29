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
