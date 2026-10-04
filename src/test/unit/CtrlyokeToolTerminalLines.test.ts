import * as assert from "assert";
import { suite, test } from "mocha";
import { resolveCtrlYokeToolModel } from "../../utils/ctrlyokeToolViews/registry";
import { TOOL_TERMINAL_TONES } from "../../utils/ctrlyokeToolViews/shared";
import { MCP_SERVER_IDS } from "../../types/DashboardConstants";
import type { McpToolCallData } from "../../types/CliOutputTypes";

function toolCall(
  tool: string,
  parameters: unknown,
  result: unknown
): McpToolCallData {
  return {
    server: MCP_SERVER_IDS.CTRLYOKE,
    tool,
    parameters: parameters as Record<string, unknown>,
    result: { success: true, output: JSON.stringify(result) },
  };
}

const participant = {
  participantId: "agent-1",
  label: "Agent 1",
  attested: true,
  kind: "ctrlyoke-step",
};

const calls: Array<{ name: string; data: McpToolCallData; expected?: string }> =
  [
    {
      name: "post_note",
      data: toolCall("post_note", { text: "hello" }, { text: "hello" }),
      expected: "hello",
    },
    {
      name: "append_step",
      data: toolCall(
        "append_step",
        {
          steps: [
            {
              prompt: "Build feature",
              name: "Build",
              harness: "claude-cli",
              model: "sonnet",
            },
          ],
        },
        {
          success: true,
          stepsAdded: 1,
          insertIndex: 0,
          insertedEndIndex: 0,
          destination: "queue",
          placement: { insertedIndex: 0 },
          parallelGroupsAdded: [],
        }
      ),
      expected: "#1 · Build",
    },
    {
      name: "claim_paths",
      data: toolCall(
        "claim_paths",
        { paths: ["src/a.ts"] },
        {
          granted: ["src/a.ts"],
          denied: [{ path: "src/b.ts", owner: participant }],
        }
      ),
      expected: "denied to",
    },
    {
      name: "release_paths",
      data: toolCall(
        "release_paths",
        { paths: ["src/a.ts"] },
        { released: ["src/a.ts"], notHeld: [] }
      ),
      expected: "src/a.ts",
    },
    {
      name: "read_notes",
      data: toolCall(
        "read_notes",
        {},
        {
          entries: [
            {
              seq: 1,
              at: "now",
              via: "mcp",
              kind: "note",
              from: participant,
              text: "untrusted note",
            },
          ],
        }
      ),
      expected: "untrusted note",
    },
    {
      name: "workflow_status",
      data: toolCall(
        "workflow_status",
        {},
        {
          workflowKey: "wf",
          runRef: "run",
          metadata: {
            currentIndex: 0,
            totalSteps: 1,
            completedSteps: 0,
            executionState: "running",
            harness: "claude-cli",
            model: null,
          },
          steps: [
            { index: 0, name: "Build", prompt: "Build", status: "running" },
          ],
          schemaWarnings: [],
        }
      ),
      expected: "1 · running · Build",
    },
    {
      name: "global_status",
      data: toolCall(
        "global_status",
        {},
        {
          workflowCount: 1,
          workflows: [
            {
              workflowKey: "wf",
              runRef: "run",
              workflowName: "Workflow",
              executionState: "running",
              harness: "claude-cli",
              model: null,
              currentStep: 1,
              totalSteps: 2,
              completedSteps: 0,
            },
          ],
          truncated: false,
          omittedCount: 0,
        }
      ),
      expected: "Workflow · running ·",
    },
    {
      name: "read_output",
      data: toolCall(
        "read_output",
        { indices: [0] },
        {
          workflowKey: "wf",
          runRef: "run",
          outputs: [
            {
              index: 0,
              prompt: "Build",
              status: "completed",
              responseText: "Built it",
            },
          ],
        }
      ),
      expected: "Built it",
    },
    {
      name: "list_harnesses",
      data: toolCall(
        "list_harnesses",
        {},
        {
          harnesses: [
            {
              id: "claude-cli",
              displayName: "Claude",
              available: true,
              models: ["sonnet"],
            },
          ],
        }
      ),
      expected: "Claude · available · sonnet",
    },
    {
      name: "edit_step",
      data: toolCall(
        "edit_step",
        { index: 0, updates: { name: "Build", prompt: "New prompt" } },
        { success: true, changed: true, clearProperties: [] }
      ),
      expected: "name: Build",
    },
    {
      name: "remove_step",
      data: toolCall(
        "remove_step",
        { index: 0, name: "Build" },
        { success: true, changed: true }
      ),
    },
    {
      name: "reorder_steps",
      data: toolCall(
        "reorder_steps",
        { indices: [1, 0] },
        { success: true, changed: true, indices: [1, 0] }
      ),
      expected: "#2 → #1",
    },
    {
      name: "submit_commit_message",
      data: toolCall(
        "submit_commit_message",
        { message: "feat: add terminal output\n\nDetails" },
        { success: true }
      ),
      expected: "feat: add terminal output",
    },
  ];

suite("ctrlyoke tool terminal lines", () => {
  test("provides a purpose-built summary and body for every registered tool", () => {
    for (const { name, data, expected } of calls) {
      const resolved = resolveCtrlYokeToolModel(data);
      assert.ok(resolved, `${name} should resolve`);
      assert.ok(resolved.summary.length > 0, `${name} should have a summary`);
      if (expected) {
        assert.ok(
          resolved.terminalLines.some((line) => line.text.includes(expected)),
          `${name} body should contain ${expected}`
        );
      }
    }
  });

  test("marks coordination content untrusted and claim denials as warnings", () => {
    const note = resolveCtrlYokeToolModel(
      calls.find(({ name }) => name === "post_note")!.data
    );
    const claim = resolveCtrlYokeToolModel(
      calls.find(({ name }) => name === "claim_paths")!.data
    );
    assert.strictEqual(
      note?.terminalLines[0]?.tone,
      TOOL_TERMINAL_TONES.untrusted
    );
    assert.strictEqual(
      claim?.terminalLines[1]?.tone,
      TOOL_TERMINAL_TONES.warning
    );
    assert.strictEqual(claim?.warning, true);
  });
});
