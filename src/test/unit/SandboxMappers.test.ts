import * as assert from "assert";
import { suite, test } from "mocha";
import { AntigravitySandboxMapper } from "../../core/harness/antigravity/AntigravitySandboxMapper";
import { ClaudeSandboxMapper } from "../../core/harness/claude/ClaudeSandboxMapper";
import { CopilotSandboxMapper } from "../../core/harness/copilot/CopilotSandboxMapper";

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

  test("Copilot and Antigravity emit the native sandbox flag only when requested", async () => {
    for (const mapper of [
      new CopilotSandboxMapper(),
      new AntigravitySandboxMapper(),
    ]) {
      assert.deepStrictEqual((await mapper.prepare(true, context)).cliArgs, [
        "--sandbox",
      ]);
      assert.deepStrictEqual(
        (await mapper.prepare(false, context)).cliArgs,
        []
      );
      assert.deepStrictEqual(
        (await mapper.prepare(undefined, context)).cliArgs,
        []
      );
    }
  });
});
