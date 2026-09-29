import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { AntigravityLogParser } from "../../../core/harness/antigravity/AntigravityLogParser";
import { AntigravityTranscriptReader } from "../../../core/harness/antigravity/AntigravityTranscriptReader";
import { ClaudeLogParser } from "../../../core/harness/claude/ClaudeLogParser";
import { CopilotLogParser } from "../../../core/harness/copilot/CopilotLogParser";
import { CodexLogParser } from "../../../core/harness/codex/CodexLogParser";
import { OpenCodeLogParser } from "../../../core/harness/opencode/OpenCodeLogParser";
import { QwenLogParser } from "../../../core/harness/qwen/QwenLogParser";
import type { BaseCliEvent } from "../../../core/harness/shared/interfaces/ILogParser";
import type { CliEvent, McpToolCallData } from "../../../types/CliOutputTypes";
import { CLI_EVENT_TYPES } from "../../../types/DashboardConstants";
import { normalizeCliEvents } from "../../../utils/CliEventNormalizer";
import { MCP_PROBE_CALLS } from "../../harness/mcpProbeContract";

const PROBE_HARNESSES = [
  "claude-cli",
  "codex-cli",
  "qwen-cli",
  "antigravity-cli",
] as const;

function fixturePath(...parts: string[]): string {
  return path.resolve(__dirname, "../../../../src/test/fixtures", ...parts);
}

function readJsonLines(filePath: string): BaseCliEvent[] {
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as BaseCliEvent);
}

function assertProbeContract(
  harness: string,
  events: readonly CliEvent[],
  expectedCalls: readonly {
    tool: string;
    parameters?: unknown;
  }[] = MCP_PROBE_CALLS
): void {
  const normalized = normalizeCliEvents(events);
  const mcpCalls = normalized.filter(
    (event) => event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL
  );
  assert.deepStrictEqual(
    mcpCalls.map((event) => (event.data as McpToolCallData).tool),
    expectedCalls.map((call) => call.tool),
    `${harness}: MCP tools emitted from captured vendor records`
  );

  for (const [index, event] of mcpCalls.entries()) {
    const data = event.data as McpToolCallData;
    const expected = expectedCalls[index];
    assert.strictEqual(data.server, "ctrlyoke", `${harness}: server`);
    assert.ok(data.toolCallId, `${harness}: ${data.tool} id`);
    assert.ok(data.result?.output, `${harness}: ${data.tool} result`);
    if (expected && "parameters" in expected) {
      const actualParameters = data.parameters as
        Record<string, unknown> | undefined;
      assert.ok(actualParameters, `${harness}: ${data.tool} parameters`);
      const expectedParameters = expected.parameters as Record<string, unknown>;
      for (const [key, value] of Object.entries(expectedParameters)) {
        assert.deepStrictEqual(actualParameters?.[key], value);
      }
    }
  }

  assert.ok(
    !normalized.some((event) => event.type === CLI_EVENT_TYPES.TOOL_CALL),
    `${harness}: no generic tool row should replace an MCP call`
  );
}

suite("MCP probe raw vendor parser contract fixtures", () => {
  for (const harness of PROBE_HARNESSES) {
    test(`${harness}: raw vendor records normalize to four paired MCP calls`, async () => {
      let events: CliEvent[];
      const filePath = fixturePath("mcp-probe", `${harness}.jsonl`);

      if (harness === "claude-cli") {
        events = new ClaudeLogParser().extractResponse(
          readJsonLines(filePath)
        ).events;
      } else if (harness === "codex-cli") {
        events = new CodexLogParser().extractResponse(
          readJsonLines(filePath)
        ).events;
      } else if (harness === "qwen-cli") {
        events = new QwenLogParser().extractResponse(
          readJsonLines(filePath)
        ).events;
      } else {
        const reader = new AntigravityTranscriptReader();
        const records = await reader.readRecords(filePath);
        const parser = new AntigravityLogParser();
        const transcriptEvents = parser.parseTranscriptRecords(
          records,
          "mcp-probe-fixture-session"
        );
        events = parser.extractResponse(transcriptEvents).events;
      }

      assertProbeContract(harness, events);
    });
  }

  test("Codex code-mode tool aliases retain each nested call", () => {
    const events = new CodexLogParser().extractResponse(
      readJsonLines(fixturePath("mcp-probe", "codex-cli-dynamic.jsonl"))
    ).events;
    assertProbeContract("codex-cli", events);
  });

  test("Copilot structured MCP identity fixture passes through its log parser", () => {
    const parser = new CopilotLogParser();
    const events = readJsonLines(
      fixturePath("copilot", "mcp-tool-call.jsonl")
    ).flatMap((event) => parser.extractStructuredEventsFromEvent(event));
    assertProbeContract("copilot-cli", events, [
      {
        tool: "claim_paths",
        parameters: { paths: ["a.txt"], reason: "probe" },
      },
    ]);
  });

  test("OpenCode attached-server fixture passes through its log parser", () => {
    const parser = new OpenCodeLogParser();
    parser.setAttachedMcpServerIds(new Set(["ctrlyoke", "ctrlyoke-commit"]));
    const events = parser.extractResponse(
      readJsonLines(
        fixturePath("opencode", "hyphenated-mcp-server.stdout.jsonl")
      )
    ).events;
    const normalized = normalizeCliEvents(events);
    const mcpCalls = normalized.filter(
      (event) => event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL
    );
    assert.strictEqual(mcpCalls.length, 1);
    const data = mcpCalls[0].data as McpToolCallData;
    assert.strictEqual(data.server, "ctrlyoke-commit");
    assert.strictEqual(data.tool, "global_status");
    assert.strictEqual(data.toolCallId, "call_opencode_global_status_1");
    assert.deepStrictEqual(data.parameters, {});
    assert.strictEqual(data.result?.success, true);
    assert.ok(data.result?.output?.includes('"workspaceRoot": "<workspace>"'));
  });
});
