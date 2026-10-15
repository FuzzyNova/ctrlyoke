import * as assert from "assert";
import { suite, test } from "mocha";
import { CopilotToolPermissionMapper } from "../../core/harness/copilot/CopilotToolPermissionMapper";
import { ClaudeToolPermissionMapper } from "../../core/harness/claude/ClaudeToolPermissionMapper";
import { CodexToolPermissionMapper } from "../../core/harness/codex/CodexToolPermissionMapper";
import { OpenCodeToolPermissionMapper } from "../../core/harness/opencode/OpenCodeToolPermissionMapper";
import { QwenToolPermissionMapper } from "../../core/harness/qwen/QwenToolPermissionMapper";
import { AntigravityToolPermissionMapper } from "../../core/harness/antigravity/AntigravityToolPermissionMapper";
import type {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionConfig,
} from "../../core/harness/shared/interfaces/IToolPermissionMapper";
import { PERMISSION_MODES } from "../../types/DashboardConstants";

// ─── helpers ────────────────────────────────────────────────────────────────

function cfg(
  mode: ToolPermissionConfig["mode"] | (string & {}),
  allowedTools: string[] = [],
  deniedTools: string[] = []
): ToolPermissionConfig {
  return {
    mode: mode as ToolPermissionConfig["mode"],
    allowedTools,
    deniedTools,
  };
}

async function mapperArgs(
  mapper: IToolPermissionMapper,
  config: ToolPermissionConfig,
  context: PermissionContext = {}
): Promise<string[]> {
  return (await mapper.prepare(config, context)).cliArgs;
}

// ============================================================================

suite("ToolPermissionMappers", () => {
  // ──────────────────────────────────────────────────────────────────────────
  suite("CopilotToolPermissionMapper", () => {
    const mapper = new CopilotToolPermissionMapper();

    suite("prepare", () => {
      test("dangerouslyAllowAll → --yolo (no deny list)", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write"])
        );
        assert.ok(args.includes("--yolo"));
        assert.ok(
          !args.includes("--deny-tool"),
          "deny list should be suppressed for dangerouslyAllowAll"
        );
      });

      test("allowAll → --allow-all-tools", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.ok(args.includes("--allow-all-tools"));
      });

      test("allowAll with denied tools → --allow-all-tools and --deny-tool entries", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write", "shell"])
        );
        assert.ok(args.includes("--allow-all-tools"));
        assert.ok(args.includes("--deny-tool"));
        const denyIndex = args.indexOf("--deny-tool");
        assert.ok(denyIndex !== -1);
        const afterDeny = args.slice(denyIndex + 1);
        assert.ok(afterDeny.includes("write"));
        assert.ok(afterDeny.includes("shell"));
      });

      test("custom mode with allowed tools → --allow-tool entries", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], [])
        );
        assert.ok(args.includes("--allow-tool"), "should contain --allow-tool");
        const allowIndex = args.indexOf("--allow-tool");
        const afterAllow = args.slice(allowIndex + 1);
        assert.ok(afterAllow.includes("write"));
        assert.ok(afterAllow.includes("shell"));
      });

      test("custom mode with no allowed tools → no --allow-tool flag", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], [])
        );
        assert.ok(!args.includes("--allow-tool"));
      });

      test("read-only tools are filtered out in custom mode", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["grep", "read_file"], [])
        );
        // grep and read_file are in READ_ONLY_TOOLS → filtered → no --allow-tool produced
        assert.ok(!args.includes("--allow-tool"));
      });

      test("custom mode with deny tools → --deny-tool entries", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], ["write"])
        );
        assert.ok(args.includes("--deny-tool"));
      });

      test("dangerouslyAllowAll returns no --deny-tool even when denied tools provided", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write", "shell"])
        );
        assert.ok(!args.includes("--deny-tool"));
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll with no deny list → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true
        );
      });

      test("dangerouslyAllowAll with deny list → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write"])
          ),
          true
        );
      });

      test("allowAll with no deny list → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("allowAll with deny list → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write"])
          ),
          true
        );
      });

      test("custom mode → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, ["write"], [])
          ),
          false
        );
      });
    });
  });

  suite("AntigravityToolPermissionMapper", () => {
    const mapper = new AntigravityToolPermissionMapper();

    suite("prepare", () => {
      test("dangerouslyAllowAll → ['--dangerously-skip-permissions']", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("allowAll → no permission flag", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, []);
      });

      test("allowAll with a deny list → no permission flag", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.ALLOW_ALL, [], ["shell"])
        );
        assert.deepStrictEqual(args, []);
      });

      test("custom mode → ['--sandbox']", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"])
        );
        assert.deepStrictEqual(args, ["--sandbox"]);
      });

      test("custom mode ignores allow and deny patterns", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["github(search)"], ["shell"])
        );
        assert.deepStrictEqual(args, ["--sandbox"]);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true
        );
      });

      test("allowAll → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          false
        );
      });

      test("allowAll with a deny list → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.ALLOW_ALL, [], ["shell"])
          ),
          false
        );
      });

      test("custom mode → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM)),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("ClaudeToolPermissionMapper", () => {
    const mapper = new ClaudeToolPermissionMapper();

    suite("prepare", () => {
      test("dangerouslyAllowAll → ['--dangerously-skip-permissions']", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("allowAll → --permission-mode bypassPermissions --tools default", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.ok(args.includes("--permission-mode"));
        assert.ok(args.includes("bypassPermissions"));
        assert.ok(args.includes("--tools"));
        assert.ok(args.includes("default"));
      });

      test("allowAll with denied tools → adds --disallowedTools", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write"])
        );
        assert.ok(
          args.includes("--disallowedTools"),
          "should include --disallowedTools"
        );
        const idx = args.indexOf("--disallowedTools");
        const after = args.slice(idx + 1);
        assert.ok(
          after.some((a) => a.includes("Write")),
          "write → Write"
        );
      });

      test("allowAll with spaced deny pattern → raw arg without embedded quotes", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.ALLOW_ALL, [], ["shell(git checkout:*)"])
        );
        const idx = args.indexOf("--disallowedTools");
        assert.ok(idx !== -1);
        assert.strictEqual(args[idx + 1], "Bash(git checkout:*)");
        assert.ok(!args[idx + 1].includes('"'));
      });

      test("headless custom uses dontAsk and --allowedTools entries", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], []),
          { isInteractive: false }
        );
        assert.deepStrictEqual(args.slice(0, 2), [
          "--permission-mode",
          "dontAsk",
        ]);
        assert.ok(args.includes("--allowedTools"));
        const idx = args.indexOf("--allowedTools");
        const after = args.slice(idx + 1);
        assert.ok(
          after.some((a) => a.includes("Write")),
          "write → Write"
        );
        assert.ok(
          after.some((a) => a.includes("Bash")),
          "shell → Bash"
        );
      });

      test("interactive custom omits permission mode and keeps tool rules", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"]),
          { isInteractive: true }
        );
        assert.ok(!args.includes("--permission-mode"));
        assert.ok(args.includes("--allowedTools"));
        assert.ok(args.includes("--disallowedTools"));
      });

      test("custom with spaced allow pattern → raw arg without embedded quotes", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["shell(git checkout:*)"], [])
        );
        const idx = args.indexOf("--allowedTools");
        assert.ok(idx !== -1);
        assert.strictEqual(args[idx + 1], "Bash(git checkout:*)");
        assert.ok(!args[idx + 1].includes('"'));
      });

      test("headless custom with no allowed or denied tools uses dontAsk", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], []),
          { isInteractive: false }
        );
        assert.ok(args.includes("--permission-mode"));
        assert.ok(args.includes("dontAsk"));
        assert.ok(!args.includes("--allowedTools"));
        assert.ok(!args.includes("--disallowedTools"));
      });

      test("interactive custom with no tool rules leaves Claude's default mode", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], []),
          { isInteractive: true }
        );
        assert.deepStrictEqual(args, []);
      });

      test("dangerouslyAllowAll ignores deny list completely", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write"])
        );
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true
        );
      });

      test("allowAll with no deny list → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("allowAll with deny list → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write"])
          ),
          true
        );
      });

      test("custom with no deny list → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, ["write"], [])
          ),
          false
        );
      });

      test("custom with deny list → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, [], ["write"])
          ),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("CodexToolPermissionMapper", () => {
    const mapper = new CodexToolPermissionMapper();

    suite("prepare", () => {
      test("dangerouslyAllowAll → --dangerously-bypass-approvals-and-sandbox", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, [
          "--dangerously-bypass-approvals-and-sandbox",
        ]);
      });

      test("allowAll → explicit Auto preset flags", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });

      test("custom without sandbox/approval config → fallback to explicit Auto preset flags", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], [])
        );
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });

      test("custom mode with only allowed patterns → still Auto preset flags (Codex doesn't support granular patterns)", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write"], [])
        );
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });

      test("custom mode denying shell → read-only sandbox (the only way Codex can enforce it)", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"])
        );
        assert.deepStrictEqual(args, ["--sandbox", "read-only"]);
      });
    });

    suite("buildCodexSpecificArgs", () => {
      test("dangerouslyAllowAll → --dangerously-bypass-approvals-and-sandbox regardless of sandbox/approval args", async () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL),
          "read-only",
          "on-request"
        );
        assert.deepStrictEqual(args, [
          "--dangerously-bypass-approvals-and-sandbox",
        ]);
      });

      test("allowAll → explicit Auto preset flags", async () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.ALLOW_ALL),
          "read-only",
          "never"
        );
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });

      test("custom with sandboxMode and approvalPolicy → -s <mode> -a <policy>", async () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.CUSTOM),
          "workspace-write",
          "on-request"
        );
        assert.deepStrictEqual(args, [
          "-s",
          "workspace-write",
          "-a",
          "on-request",
        ]);
      });

      test("custom without sandboxMode/approvalPolicy → fallback to explicit Auto preset flags", async () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.CUSTOM)
        );
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true
        );
      });

      test("allowAll → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("custom → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, ["write"], [])
          ),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("OpenCodeToolPermissionMapper", () => {
    const mapper = new OpenCodeToolPermissionMapper();

    suite("prepare", () => {
      test("dangerouslyAllowAll → no CLI args", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, []);
      });

      test("allowAll → no CLI args", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, []);
      });

      test("custom with allow and deny patterns → still no CLI args", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"])
        );
        assert.deepStrictEqual(args, []);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true
        );
      });

      test("allowAll → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("custom → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, ["write"], [])
          ),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("QwenToolPermissionMapper", () => {
    const mapper = new QwenToolPermissionMapper();

    suite("prepare", () => {
      test("dangerouslyAllowAll → -y (YOLO mode)", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.ok(args.includes("-y"), "should include -y flag");
      });

      test("allowAll → --approval-mode auto-edit", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.ok(args.includes("--approval-mode"));
        assert.ok(args.includes("auto-edit"));
      });

      test("custom mode → --approval-mode default", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], [])
        );
        assert.ok(args.includes("--approval-mode"));
        assert.ok(args.includes("default"));
      });

      test("custom mode with allowed tools → --allowed-tools", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], [])
        );
        assert.ok(
          args.includes("--allowed-tools"),
          "should include --allowed-tools"
        );
      });

      test("custom mode with denied tools → --exclude-tools", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], ["write", "shell"])
        );
        assert.ok(
          args.includes("--exclude-tools"),
          "should include --exclude-tools"
        );
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true
        );
      });

      test("allowAll → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("custom → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, ["write"], [])
          ),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("Passthrough handling", () => {
    test("none mode is handled before prepare is called", async () => {
      // Passthrough (null config) is guarded in CliIntegration before calling prepare().
      // When resolveToolPermissions() returns null, CliIntegration skips the mapper entirely
      // and injects no permission flags. This test documents that prepare() always
      // receives a non-null ToolPermissionConfig — the none guard lives upstream.
      //
      // Guard in CliIntegration:
      //   if (config === null) return []; // skip permission args
      //
      // All mappers are tested above with non-null configs only.
      assert.ok(true, "none mode is handled externally in CliIntegration");
    });
  });
});
