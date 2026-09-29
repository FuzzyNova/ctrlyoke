import * as assert from "assert";
import { recognizeMcpSkillCommand } from "../../utils/McpSkillCommandRecognizer";

suite("McpSkillCommandRecognizer", () => {
  test("recognizes the POSIX skill command with single-quoted JSON", () => {
    assert.deepStrictEqual(
      recognizeMcpSkillCommand(
        `node "/work/ctrlyoke/out/mcp-server.js" --tool post_note --args '{"text":"hello world"}' --workspace "/repo"`
      ),
      { tool: "post_note", parameters: { text: "hello world" } }
    );
  });

  test("recognizes Windows paths and escaped double-quoted JSON", () => {
    assert.deepStrictEqual(
      recognizeMcpSkillCommand(
        String.raw`node "C:\dev\ctrlyoke\out\mcp-server.js" --tool "post_note" --args "{\"text\":\"hello world\"}" --workspace "C:\repo"`
      ),
      { tool: "post_note", parameters: { text: "hello world" } }
    );
  });

  test("recognizes a relative script path", () => {
    assert.deepStrictEqual(
      recognizeMcpSkillCommand(
        `node ./out/mcp-server.js --tool workflow_status --args '{}'`
      ),
      { tool: "workflow_status", parameters: {} }
    );
  });

  test("leaves malformed JSON and missing tool names unrecognized", () => {
    assert.strictEqual(
      recognizeMcpSkillCommand(
        `node out/mcp-server.js --tool post_note --args '{broken}'`
      ),
      undefined
    );
    assert.strictEqual(
      recognizeMcpSkillCommand(`node out/mcp-server.js --args '{}'`),
      undefined
    );
  });

  test("does not classify another node script that happens to use --tool", () => {
    assert.strictEqual(
      recognizeMcpSkillCommand(`node foo.js --tool x --args '{}'`),
      undefined
    );
  });
});
