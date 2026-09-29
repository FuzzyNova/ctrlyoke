import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import type {
  CliEvent,
  McpToolCallData,
  ToolCall,
} from "../../../types/CliOutputTypes";
import { normalizeCliEvents } from "../../../utils/CliEventNormalizer";
import { MCP_SERVER_IDS } from "../../../types/DashboardConstants";
import {
  MCP_PROBE_CALLS,
  MCP_PROBE_TOOLS,
} from "../../harness/mcpProbeContract";

interface McpProbeFixture {
  harness: string;
  source: "events.jsonl";
  events: CliEvent[];
  genericToolCalls: Array<Pick<ToolCall, "name">>;
}

const CAPTURED_TOOLS_BY_HARNESS: Record<string, readonly string[]> = {
  "claude-cli": [
    "workflow_status",
    "post_note",
    "claim_paths",
    "release_paths",
  ],
  "codex-cli": ["workflow_status"],
  "qwen-cli": [
    "workflow_status",
    "post_note",
    "claim_paths",
    "release_paths",
  ],
  "antigravity-cli": ["workflow_status"],
};

suite("MCP probe parser contract fixtures", () => {
  for (const harness of [
    "claude-cli",
    "codex-cli",
    "qwen-cli",
    "antigravity-cli",
  ]) {
    test(`${harness}: captured MCP calls retain identity, args, result, and id`, () => {
      const fixturePath = path.resolve(
        __dirname,
        `../../../../src/test/fixtures/mcp-probe/${harness}.json`
      );
      const fixture = JSON.parse(
        fs.readFileSync(fixturePath, "utf8")
      ) as McpProbeFixture;
      assert.strictEqual(fixture.harness, harness);
      assert.strictEqual(fixture.source, "events.jsonl");

      const normalized = normalizeCliEvents(fixture.events);
      assert.deepStrictEqual(
        normalized.map((event) => (event.data as McpToolCallData).tool),
        CAPTURED_TOOLS_BY_HARNESS[harness]
      );

      for (const event of normalized) {
        const data = event.data as McpToolCallData;
        assert.strictEqual(data.server, MCP_SERVER_IDS.CTRLYOKE);
        assert.ok(
          MCP_PROBE_TOOLS.includes(data.tool as (typeof MCP_PROBE_TOOLS)[number])
        );
        assert.ok(data.toolCallId, `${harness}: ${data.tool} call id missing`);
        assert.ok(data.result, `${harness}: ${data.tool} result missing`);
        const expected = MCP_PROBE_CALLS.find(
          (call) => call.tool === data.tool
        );
        assert.ok(expected, `${harness}: unexpected MCP tool ${data.tool}`);
        if (expected && "parameters" in expected) {
          assert.ok(
            data.parameters && Object.keys(data.parameters).length > 0,
            `${harness}: ${data.tool} parameters missing`
          );
        }
      }

      assert.ok(
        !fixture.genericToolCalls.some((call) =>
          MCP_PROBE_TOOLS.some(
            (tool) =>
              call.name === tool ||
              call.name === `mcp__ctrlyoke__${tool}` ||
              call.name === `ctrlyoke-${tool}`
          )
        ),
        `${harness}: generic tool-call capture names a ctrlyoke MCP tool`
      );
    });
  }
});
