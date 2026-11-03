import * as assert from "assert";
import { suite, test } from "mocha";
import { ClaudeSandboxMapper } from "../../core/harness/claude/ClaudeSandboxMapper";
import { CodexSandboxMapper } from "../../core/harness/codex/CodexSandboxMapper";
import { COMPATIBILITY_DIAGNOSTIC_CODES } from "../../types/CompatibilityTypes";
import {
  CODEX_SANDBOX_MODES,
  EFFECTIVE_SANDBOX_KINDS,
  PERMISSION_MODES,
} from "../../types/DashboardConstants";
import { hasCliFlag } from "../../utils/CliArgParser";

const context = {
  toolPermissions: null,
  isInteractive: true,
  writableRoots: ["/workspace", "/approved"],
};

suite("sandbox mappers", () => {
  test("Claude contributes containment settings without adding another CLI flag", async () => {
    const result = await new ClaudeSandboxMapper().prepare(true, context);
    assert.deepStrictEqual(result.cliArgs, []);
    assert.deepStrictEqual(result.diagnostics, []);
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

  test("Claude contributes nothing for inherit or false", async () => {
    for (const request of [undefined, false]) {
      const result = await new ClaudeSandboxMapper().prepare(request, context);
      assert.strictEqual(result.settings, undefined);
      assert.deepStrictEqual(result.cliArgs, []);
    }
  });

  test("Claude reports an error when additionalArgs passes its own --settings", async () => {
    for (const additionalArgs of [
      "--settings user.json",
      "--settings=a.json",
    ]) {
      const result = await new ClaudeSandboxMapper().prepare(true, {
        ...context,
        additionalArgs,
      });
      assert.strictEqual(
        result.diagnostics[0]?.code,
        COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_SETTINGS_OVERRIDDEN,
        additionalArgs
      );
    }
    // Without sandbox: true the user's --settings is none of our business.
    const inherit = await new ClaudeSandboxMapper().prepare(undefined, {
      ...context,
      additionalArgs: "--settings user.json",
    });
    assert.deepStrictEqual(inherit.diagnostics, []);
  });

  test("Codex only claims a closed network for a contained mode", async () => {
    const mapper = new CodexSandboxMapper();
    const contained = await mapper.prepare(true, context);
    assert.strictEqual(contained.effective.kind, EFFECTIVE_SANDBOX_KINDS.ON);
    assert.strictEqual(
      contained.effective.detail,
      "Codex workspace-write, network off"
    );
    const off = await mapper.prepare(false, {
      ...context,
      toolPermissions: {
        mode: PERMISSION_MODES.ALLOW_ALL,
        allowedTools: [],
        deniedTools: [],
      },
      codexSandboxMode: CODEX_SANDBOX_MODES.WORKSPACE_WRITE,
    });
    assert.deepStrictEqual(off.cliArgs, ["-s", "danger-full-access"]);
    assert.strictEqual(off.effective.detail, "Codex danger-full-access");
  });

  test("hasCliFlag matches separate and inline flag forms only", () => {
    assert.ok(hasCliFlag("--settings x.json", ["--settings"]));
    assert.ok(hasCliFlag("--model m --settings=x.json", ["--settings"]));
    assert.ok(!hasCliFlag("--settings-file x", ["--settings"]));
    assert.ok(!hasCliFlag('"--settings is text"', ["--settings"]));
    assert.ok(!hasCliFlag("", ["--settings"]));
  });
});
