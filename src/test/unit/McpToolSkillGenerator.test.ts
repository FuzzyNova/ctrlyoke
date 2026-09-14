import * as assert from "assert";
import { suite, test } from "mocha";
import {
  McpToolSkillGenerator,
  MCP_COMMIT_MESSAGE_SKILL_TOOL_NAMES,
} from "../../utils/McpToolSkillGenerator";
import {
  MCP_COMMIT_MESSAGE_DENIED_TOOL_NAMES,
  MCP_COORDINATION_TOOL_NAMES,
  MCP_WORKFLOW_TOOL_NAMES,
  MCP_REMOVE_STEP_TOOL_NAME,
  MCP_REORDER_STEPS_TOOL_NAME,
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
  MCP_TOOL_DEFINITIONS,
} from "../../utils/McpToolDefinitions";
import { MCP_SKILL_NAMES } from "../../types/DashboardConstants";
import type { McpToolSkillRunContext } from "../../types/WorkflowContextTypes";

suite("McpToolSkillGenerator", () => {
  test("renders descriptions, parameters, and executable examples", () => {
    const reference = McpToolSkillGenerator.generateToolReference([
      "append_step",
      "workflow_status",
    ]);

    assert.ok(reference.includes("### append_step"));
    assert.ok(
      reference.includes(
        "Add one or more steps to your workflow's queue. This is how you build up or extend the workflow"
      )
    );
    assert.ok(
      reference.includes("- `steps` (required, array of object or object)")
    );
    assert.ok(reference.includes("- `source` (optional, string)"));
    assert.ok(
      reference.includes(
        `node \"<mcp-server.js path>\" --tool append_step --args '{"steps":[{"prompt":"example"}],"position":"next"}' --workspace \"<path>\" --working-file \"<path>\"`
      )
    );
    assert.ok(
      reference.includes(
        `node \"<mcp-server.js path>\" --tool workflow_status --args '{}' --workspace \"<path>\" --working-file \"<path>\"`
      )
    );
  });

  test("substitutes live run paths when context is provided", () => {
    const context: McpToolSkillRunContext = {
      mcpServerPath: "C:/extension/out/mcp-server.js",
      workspaceRoot: "C:/workspace",
      workingFilePath: "C:/state/run.ctrlyoke.json",
    };
    const reference = McpToolSkillGenerator.generateToolReference(
      ["workflow_status"],
      context
    );

    assert.ok(reference.includes('node "C:/extension/out/mcp-server.js"'));
    assert.ok(reference.includes('--workspace "C:/workspace"'));
    assert.ok(
      reference.includes('--working-file "C:/state/run.ctrlyoke.json"')
    );
    assert.ok(!reference.includes("<mcp-server.js path>"));
    assert.ok(!reference.includes("<path>"));
  });

  test("substitutes the commit output path on the commit skill path", () => {
    const reference = McpToolSkillGenerator.generateToolReference(
      [MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME],
      {
        mcpServerPath: "C:/extension/out/mcp-server.js",
        workspaceRoot: "C:/workspace",
        commitOutputPath: "C:/workspace/.ctrlyoke/temp/commit-output.txt",
      }
    );

    assert.ok(
      reference.includes(
        '--commit-output "C:/workspace/.ctrlyoke/temp/commit-output.txt"'
      )
    );
    assert.ok(!reference.includes("<"));
  });

  test("keeps placeholders when no run context is provided", () => {
    const reference = McpToolSkillGenerator.generateToolReference([
      "workflow_status",
    ]);

    assert.ok(reference.includes("<mcp-server.js path>"));
    assert.ok(reference.includes("<path>"));
  });

  test("renders only the requested tools", () => {
    const reference = McpToolSkillGenerator.generateToolReference([
      "workflow_status",
    ]);

    assert.ok(reference.includes("### workflow_status"));
    assert.ok(!reference.includes("### append_step"));
  });

  test("provides a commit-message-only built-in skill subset", () => {
    const reference = McpToolSkillGenerator.generateToolReference([
      ...MCP_COMMIT_MESSAGE_SKILL_TOOL_NAMES,
    ]);

    assert.ok(reference.includes("### submit_commit_message"));
    assert.ok(!reference.includes("### workflow_status"));
    assert.ok(reference.includes("--commit-output"));
  });

  test("includes the step mutation tools in the workflow skill subset", () => {
    const reference = McpToolSkillGenerator.generateToolReference([
      ...MCP_WORKFLOW_TOOL_NAMES,
    ]);

    assert.ok(reference.includes("### edit_step"));
    assert.ok(reference.includes("### remove_step"));
    assert.ok(reference.includes("### reorder_steps"));
    assert.ok(reference.includes("zero-based step index"));
  });

  test("provides a separate coordination skill subset with CLI placeholders", () => {
    const reference = McpToolSkillGenerator.generateToolReference([
      ...MCP_COORDINATION_TOOL_NAMES,
    ]);

    assert.ok(reference.includes("### post_note"));
    assert.ok(reference.includes("### claim_paths"));
    assert.ok(reference.includes('--execution-root "<execution-root path>"'));
    assert.ok(reference.includes('--step-index "<step index>"'));
    assert.ok(reference.includes('--parallel-group-id "<parallel group id>"'));
  });

  test("omits denied tools from a generated built-in skill", () => {
    // In disabled mode the skill is the entire tool listing, so leaving a
    // denied tool documented is the only thing a denial could have prevented.
    const content = McpToolSkillGenerator.generateBuiltInSkillContent(
      MCP_SKILL_NAMES.TOOLS,
      "# Workflow tools",
      {
        mcpServerPath: "C:/extension/out/mcp-server.js",
        workspaceRoot: "C:/state",
        deniedTools: [MCP_REMOVE_STEP_TOOL_NAME, MCP_REORDER_STEPS_TOOL_NAME],
      }
    );

    assert.ok(content !== undefined);
    assert.ok(content.includes("### append_step"));
    assert.ok(!content.includes("### remove_step"));
    assert.ok(!content.includes("### reorder_steps"));
  });

  test("keeps the full listing when no denials are supplied", () => {
    // The export path passes no run context at all, so a snapshot must still
    // document every tool alongside its placeholders.
    const content = McpToolSkillGenerator.generateBuiltInSkillContent(
      MCP_SKILL_NAMES.TOOLS,
      "# Workflow tools"
    );

    assert.ok(content !== undefined);
    for (const toolName of MCP_WORKFLOW_TOOL_NAMES) {
      assert.ok(
        content.includes(`### ${toolName}`),
        `expected ${toolName} in the un-denied listing`
      );
    }
  });

  test("substitutes coordination CLI identity on the execution path", () => {
    const reference = McpToolSkillGenerator.generateToolReference(
      [...MCP_COORDINATION_TOOL_NAMES],
      {
        mcpServerPath: "C:/extension/out/mcp-server.js",
        workspaceRoot: "C:/state",
        executionRoot: "C:/checkout",
        workingFilePath: "C:/state/run.ctrlyoke.json",
        stepIndex: 2,
        parallelGroupId: "api-group",
      }
    );

    assert.ok(reference.includes('--execution-root "C:/checkout"'));
    assert.ok(reference.includes('--step-index "2"'));
    assert.ok(reference.includes('--parallel-group-id "api-group"'));
    assert.ok(!reference.includes("<execution-root path>"));
    assert.ok(!reference.includes("<step index>"));
    assert.ok(!reference.includes("<parallel group id>"));
  });

  test("keeps the commit-run denial list exhaustive", () => {
    assert.deepStrictEqual(
      [
        ...MCP_COMMIT_MESSAGE_DENIED_TOOL_NAMES,
        MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
      ].sort(),
      MCP_TOOL_DEFINITIONS.map((tool) => tool.name).sort()
    );
  });
});
