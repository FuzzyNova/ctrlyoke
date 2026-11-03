import * as assert from "assert";
import { suite, test } from "mocha";
import { ClaudeSandboxMapper } from "../../core/harness/claude/ClaudeSandboxMapper";

const context = {
  toolPermissions: null,
  isInteractive: true,
  writableRoots: ["/workspace", "/approved"],
};

suite("sandbox mappers", () => {
  test("Claude contributes containment settings without adding another CLI flag", async () => {
    const result = await new ClaudeSandboxMapper().prepare(true, context);
    assert.deepStrictEqual(result.cliArgs, []);
    assert.deepStrictEqual(result.settings, {
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: false,
        filesystem: { allowWrite: context.writableRoots },
      },
    });
  });
});
