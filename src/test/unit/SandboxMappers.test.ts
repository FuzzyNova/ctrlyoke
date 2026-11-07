import * as assert from "assert";
import { suite, test } from "mocha";
import { ClaudeSandboxMapper } from "../../core/harness/claude/ClaudeSandboxMapper";
import { CodexSandboxMapper } from "../../core/harness/codex/CodexSandboxMapper";
import { CopilotCliProvider } from "../../core/harness/copilot/CopilotCliProvider";
import { QwenCliProvider } from "../../core/harness/qwen/QwenCliProvider";
import { AntigravityCliProvider } from "../../core/harness/antigravity/AntigravityCliProvider";
import { OpenCodeCliProvider } from "../../core/harness/opencode/OpenCodeCliProvider";
import type { SandboxContext } from "../../core/harness/shared/interfaces/ISandboxMapper";
import {
  COMPATIBILITY_DIAGNOSTIC_CODES,
  getCompatibilityCaveatMessage,
  SANDBOX_CAVEAT_CODE,
} from "../../types/CompatibilityTypes";
import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  EFFECTIVE_SANDBOX_KINDS,
  SANDBOX_MODES,
} from "../../types/DashboardConstants";
import { getCliFlagValues, hasCliFlag } from "../../utils/CliArgParser";

const context: SandboxContext = {
  isInteractive: true,
  writableRoots: ["/workspace", "/approved"],
  sandboxMode: SANDBOX_MODES.WORKSPACE_WRITE,
  requestFromDefaults: false,
};

suite("sandbox mappers", () => {
  test("Codex declares exact terminal containment; Claude records its verified file-tool gap", () => {
    const codex = new CodexSandboxMapper().capabilities.terminal;
    const claude = new ClaudeSandboxMapper().capabilities.terminal;
    assert.strictEqual(codex.fidelity, "exact");
    assert.strictEqual(
      codex.caveatCode,
      SANDBOX_CAVEAT_CODE.NETWORK_FOLLOWS_HARNESS_POLICY
    );
    assert.strictEqual(claude.fidelity, "partial");
    assert.strictEqual(
      claude.caveatCode,
      SANDBOX_CAVEAT_CODE.FILE_TOOLS_BEST_EFFORT
    );
    assert.match(
      claude.verification?.reference ?? "",
      /#claude-file-tool-probe-2026-11-03-macos$/
    );
    assert.match(
      getCompatibilityCaveatMessage(claude.caveatCode) ?? "",
      /Write and Edit tools run outside/
    );
  });

  test("Claude workspace-write allows writes to the workspace roots without another CLI flag", async () => {
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

  test("Claude read-only denies Bash writes to the workspace roots", async () => {
    const result = await new ClaudeSandboxMapper().prepare(true, {
      ...context,
      sandboxMode: SANDBOX_MODES.READ_ONLY,
    });
    const sandbox = (result.settings as { sandbox: Record<string, unknown> })
      .sandbox;
    assert.strictEqual(sandbox.enabled, true);
    assert.deepStrictEqual(sandbox.filesystem, {
      denyWrite: context.writableRoots,
    });
    assert.strictEqual(result.effective.kind, EFFECTIVE_SANDBOX_KINDS.ON);
    assert.match(result.effective.detail ?? "", /read-only/);
  });

  test("Claude Off turns the sandbox off through settings; None contributes nothing", async () => {
    const off = await new ClaudeSandboxMapper().prepare(false, context);
    assert.deepStrictEqual(off.settings, { sandbox: { enabled: false } });
    assert.deepStrictEqual(off.cliArgs, []);
    assert.strictEqual(off.effective.kind, EFFECTIVE_SANDBOX_KINDS.OFF);
    for (const request of [undefined, null]) {
      const none = await new ClaudeSandboxMapper().prepare(request, context);
      assert.strictEqual(none.settings, undefined);
      assert.deepStrictEqual(none.cliArgs, []);
      assert.strictEqual(none.effective.kind, EFFECTIVE_SANDBOX_KINDS.HARNESS);
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
    const none = await new ClaudeSandboxMapper().prepare(null, {
      ...context,
      additionalArgs: "--settings user.json",
    });
    assert.deepStrictEqual(none.diagnostics, []);
  });

  test("Codex maps On to the sandbox mode, Off to danger-full-access and None to nothing", async () => {
    const mapper = new CodexSandboxMapper();
    const contained = await mapper.prepare(true, context);
    assert.deepStrictEqual(contained.cliArgs, ["-s", "workspace-write"]);
    assert.strictEqual(contained.effective.kind, EFFECTIVE_SANDBOX_KINDS.ON);
    // No network claim: config.toml can open it.
    assert.strictEqual(contained.effective.detail, "Codex workspace-write");
    const readOnly = await mapper.prepare(true, {
      ...context,
      sandboxMode: SANDBOX_MODES.READ_ONLY,
    });
    assert.deepStrictEqual(readOnly.cliArgs, ["-s", "read-only"]);
    const off = await mapper.prepare(false, context);
    assert.deepStrictEqual(off.cliArgs, ["-s", "danger-full-access"]);
    assert.strictEqual(off.effective.kind, EFFECTIVE_SANDBOX_KINDS.OFF);
    assert.strictEqual(off.effective.detail, "Codex danger-full-access");
    for (const request of [undefined, null]) {
      const none = await mapper.prepare(request, context);
      assert.deepStrictEqual(none.cliArgs, []);
      assert.strictEqual(none.effective.kind, EFFECTIVE_SANDBOX_KINDS.HARNESS);
    }
  });

  test("Codex reports an error when additionalArgs would replace or widen sandbox true", async () => {
    const mapper = new CodexSandboxMapper();
    for (const [additionalArgs, named] of [
      ["--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass"],
      ["--model m --yolo", "--yolo"],
      ["-s danger-full-access", "-s danger-full-access"],
      ["--sandbox=danger-full-access", "-s danger-full-access"],
      ["-sdanger-full-access", "-s danger-full-access"],
      ['-c sandbox_mode="danger-full-access"', "sandbox_mode"],
      [
        "--config sandbox_workspace_write.network_access=true",
        "network_access",
      ],
      [
        `--config='sandbox_workspace_write.writable_roots=["/"]'`,
        "writable_roots",
      ],
      ["-csandbox_workspace_write.network_access=true", "network_access"],
      [`-c 'sandbox_permissions=["disk-full-read-access"]'`, "sandbox_perm"],
    ] as const) {
      const result = await mapper.prepare(true, { ...context, additionalArgs });
      const diagnostic = result.diagnostics[0];
      assert.strictEqual(
        diagnostic?.code,
        COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_SETTINGS_OVERRIDDEN,
        additionalArgs
      );
      assert.strictEqual(
        diagnostic?.severity,
        COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
      );
      assert.ok(diagnostic?.message.includes(named), diagnostic?.message);
    }
    // Unrelated config and flags, and any request other than true, pass.
    for (const additionalArgs of [
      '-c model="o3" --search',
      "-c shell_environment_policy.inherit=all",
      "-C sub -c sandbox_modes_note=1",
    ]) {
      const ok = await mapper.prepare(true, { ...context, additionalArgs });
      assert.deepStrictEqual(ok.diagnostics, [], additionalArgs);
    }
    for (const request of [false, null]) {
      const other = await mapper.prepare(request, {
        ...context,
        additionalArgs: "--dangerously-bypass-approvals-and-sandbox",
      });
      assert.deepStrictEqual(other.diagnostics, []);
    }
  });

  test("Copilot and Qwen emit their off switches for Off", async () => {
    const copilot = await new CopilotCliProvider().sandboxMapper.prepare(
      false,
      context
    );
    assert.deepStrictEqual(copilot.cliArgs, ["--no-sandbox"]);
    assert.strictEqual(copilot.env, undefined);
    assert.strictEqual(copilot.effective.kind, EFFECTIVE_SANDBOX_KINDS.OFF);

    // QWEN_SANDBOX outranks the flag, so Off sets it too.
    const qwen = await new QwenCliProvider().sandboxMapper.prepare(
      false,
      context
    );
    assert.deepStrictEqual(qwen.cliArgs, ["--sandbox=false"]);
    assert.deepStrictEqual(qwen.env, { QWEN_SANDBOX: "false" });
  });

  test("Antigravity and OpenCode have nothing to turn off", async () => {
    for (const provider of [
      new AntigravityCliProvider(),
      new OpenCodeCliProvider(),
    ]) {
      const off = await provider.sandboxMapper.prepare(false, context);
      assert.deepStrictEqual(off.cliArgs, [], provider.config.harnessId);
      assert.deepStrictEqual(off.diagnostics, []);
      assert.strictEqual(off.effective.kind, EFFECTIVE_SANDBOX_KINDS.OFF);
    }
  });

  test("a harness that can't sandbox refuses an authored true but only warns for defaults.sandbox", async () => {
    for (const provider of [
      new CopilotCliProvider(),
      new QwenCliProvider(),
      new AntigravityCliProvider(),
      new OpenCodeCliProvider(),
    ]) {
      const authored = await provider.sandboxMapper.prepare(true, context);
      assert.strictEqual(
        authored.diagnostics[0]?.code,
        COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_UNSUPPORTED
      );
      assert.strictEqual(
        authored.diagnostics[0]?.severity,
        COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
      );
      const inherited = await provider.sandboxMapper.prepare(true, {
        ...context,
        requestFromDefaults: true,
      });
      assert.strictEqual(
        inherited.diagnostics[0]?.code,
        COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_DEFAULT_SKIPPED
      );
      assert.strictEqual(
        inherited.diagnostics[0]?.severity,
        COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING
      );
      assert.deepStrictEqual(inherited.cliArgs, []);
      assert.strictEqual(
        inherited.effective.kind,
        EFFECTIVE_SANDBOX_KINDS.HARNESS
      );
    }
  });

  test("hasCliFlag matches separate and inline flag forms only", () => {
    assert.ok(hasCliFlag("--settings x.json", ["--settings"]));
    assert.ok(hasCliFlag("--model m --settings=x.json", ["--settings"]));
    assert.ok(!hasCliFlag("--settings-file x", ["--settings"]));
    assert.ok(!hasCliFlag('"--settings is text"', ["--settings"]));
    assert.ok(!hasCliFlag("", ["--settings"]));
  });

  test("getCliFlagValues reads separate, inline and attached short values", () => {
    assert.deepStrictEqual(
      getCliFlagValues('-c a=1 --config=b=2 -cc=3 --config "d = 4" -c', [
        "-c",
        "--config",
      ]),
      ["a=1", "b=2", "c=3", "d = 4"]
    );
    // Attached values are only read for one-letter short flags.
    assert.deepStrictEqual(
      getCliFlagValues("-settingsx --configx", ["-settings", "--config"]),
      []
    );
  });
});
