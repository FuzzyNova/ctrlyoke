import * as assert from "assert";
import { suite, test } from "mocha";
import {
  McpToolSkillGenerator,
  MCP_COMMIT_MESSAGE_SKILL_TOOL_NAMES,
} from "../../utils/McpToolSkillGenerator";
import {
  MCP_COMMIT_MESSAGE_DENIED_TOOL_NAMES,
  MCP_QUEUE_TOOL_NAMES,
  MCP_SUBMIT_COMMIT_MESSAGE_TOOL_NAME,
  MCP_TOOL_DEFINITIONS,
} from "../../utils/McpToolDefinitions";

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
    assert.ok(reference.includes("- `steps` (required, array of object)"));
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
      ...MCP_QUEUE_TOOL_NAMES,
    ]);

    assert.ok(reference.includes("### edit_step"));
    assert.ok(reference.includes("### remove_step"));
    assert.ok(reference.includes("### reorder_steps"));
    assert.ok(reference.includes("zero-based step index"));
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
