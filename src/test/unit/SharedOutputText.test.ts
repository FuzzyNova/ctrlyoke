import * as assert from "assert";
import { suite, test } from "mocha";
import { formatMcpToolLabel } from "../../utils/formatMcpToolLabel";
import { getToolResultText } from "../../utils/toolResultText";

suite("shared output text helpers", () => {
  test("gets result text with failure errors taking precedence", () => {
    assert.strictEqual(
      getToolResultText({ success: false, error: "failed", output: "ignored" }),
      "failed"
    );
    assert.strictEqual(
      getToolResultText({ success: true, output: "done" }),
      "done"
    );
    assert.strictEqual(getToolResultText({ success: true }), "Success");
    assert.strictEqual(getToolResultText({ success: false }), "Failed");
    assert.strictEqual(getToolResultText(undefined), "");
  });

  test("formats MCP labels consistently", () => {
    assert.strictEqual(
      formatMcpToolLabel("ctrlyoke", "append_step"),
      "MCP: ctrlyoke.append_step"
    );
  });
});
