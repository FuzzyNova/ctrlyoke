import * as assert from "assert";
import { Uri, workspace } from "../../platform/vscode-shim";

suite("vscode shim", () => {
  test("returns no workspace folder in standalone CLI mode", () => {
    assert.strictEqual(
      workspace.getWorkspaceFolder(
        Uri.file("/workspace/workflow.ctrlyoke.yaml")
      ),
      undefined
    );
  });
});
