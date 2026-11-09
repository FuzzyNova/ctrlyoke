import * as assert from "assert";
import * as path from "path";
import { formatCliRunHeaderLabel } from "../../cli/CliRunHeader";

suite("CLI run header label", () => {
  test("uses the bound workflow name and run reference for addressed operations", () => {
    assert.strictEqual(
      formatCliRunHeaderLabel({
        addressed: true,
        workflowName: "g",
        workflowKey: "workflow-key",
        runRef: "run-2026-11-09T06-16-25-776Z",
        inlinePrompt: false,
        fileBasename: path.basename,
      }),
      "g (run-2026-11-09T06-16-25-776Z)"
    );
  });

  test("falls back to the workflow key for addressed operations", () => {
    assert.strictEqual(
      formatCliRunHeaderLabel({
        addressed: true,
        workflowKey: "workflow-key",
        inlinePrompt: false,
        fileBasename: path.basename,
      }),
      "workflow-key"
    );
  });

  test("keeps file runs and inline prompt runs distinct", () => {
    assert.strictEqual(
      formatCliRunHeaderLabel({
        addressed: false,
        resolvedFile: "/workspace/g.ctrlyoke.yaml",
        inlinePrompt: false,
        fileBasename: path.basename,
      }),
      "g.ctrlyoke.yaml"
    );
    assert.strictEqual(
      formatCliRunHeaderLabel({
        addressed: false,
        inlinePrompt: true,
        fileBasename: path.basename,
      }),
      "<inline prompt>"
    );
  });
});
