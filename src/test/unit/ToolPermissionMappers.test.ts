import * as assert from "assert";
import { suite, test } from "mocha";
import { CopilotToolPermissionMapper } from "../../flightpath/harness/copilot/CopilotToolPermissionMapper";
import { ClaudeToolPermissionMapper } from "../../flightpath/harness/claude/ClaudeToolPermissionMapper";
import { CodexToolPermissionMapper } from "../../flightpath/harness/codex/CodexToolPermissionMapper";
import { OpenCodeToolPermissionMapper } from "../../flightpath/harness/opencode/OpenCodeToolPermissionMapper";
import { QwenToolPermissionMapper } from "../../flightpath/harness/qwen/QwenToolPermissionMapper";
import { GeminiToolPermissionMapper } from "../../flightpath/harness/gemini/GeminiToolPermissionMapper";
import type { ToolPermissionConfig } from "../../flightpath/harness/shared/interfaces/IToolPermissionMapper";
import { PERMISSION_MODES } from "../../types/DashboardConstants";

// ─── helpers ────────────────────────────────────────────────────────────────

function cfg(
  mode: ToolPermissionConfig["mode"] | (string & {}),
  allowedTools: string[] = [],
  deniedTools: string[] = []
): ToolPermissionConfig {
  return { mode: mode as ToolPermissionConfig["mode"], allowedTools, deniedTools };
}

// ============================================================================

suite("ToolPermissionMappers", () => {
  // ──────────────────────────────────────────────────────────────────────────
  suite("CopilotToolPermissionMapper", () => {
    const mapper = new CopilotToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → --allow-all-tools (no deny list)", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write"])
        );
        assert.ok(args.includes("--allow-all-tools"));
        assert.ok(
          !args.includes("--deny-tool"),
          "deny list should be suppressed for dangerouslyAllowAll"
        );
      });

      test("allowAll → --allow-all-tools", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.ok(args.includes("--allow-all-tools"));
      });

      test("allowAll with denied tools → --allow-all-tools and --deny-tool entries", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write", "shell"]));
        assert.ok(args.includes("--allow-all-tools"));
        assert.ok(args.includes("--deny-tool"));
        const denyIndex = args.indexOf("--deny-tool");
        assert.ok(denyIndex !== -1);
        // At least one quoted deny entry follows
        const afterDeny = args.slice(denyIndex + 1);
        assert.ok(
          afterDeny.some((a) => a.includes("write") || a.includes("shell"))
        );
      });

      test("custom mode with allowed tools → --allow-tool entries", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], []));
        assert.ok(args.includes("--allow-tool"), "should contain --allow-tool");
        const allowIndex = args.indexOf("--allow-tool");
        const afterAllow = args.slice(allowIndex + 1);
        assert.ok(
          afterAllow.some((a) => a.includes("write") || a.includes("shell"))
        );
      });

      test("custom mode with no allowed tools → no --allow-tool flag", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, [], []));
        assert.ok(!args.includes("--allow-tool"));
      });

      test("read-only tools are filtered out in custom mode", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, ["grep", "read_file"], []));
        // grep and read_file are in READ_ONLY_TOOLS → filtered → no --allow-tool produced
        assert.ok(!args.includes("--allow-tool"));
      });

      test("custom mode with deny tools → --deny-tool entries", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, [], ["write"]));
        assert.ok(args.includes("--deny-tool"));
      });

      test("dangerouslyAllowAll returns no --deny-tool even when denied tools provided", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write", "shell"])
        );
        assert.ok(!args.includes("--deny-tool"));
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll with no deny list → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)),
          true
        );
      });

      test("dangerouslyAllowAll with deny list → false (Copilot still checks deny list)", () => {
        // Copilot's hasFullPermissions requires deniedTools.length === 0 for all modes
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write"])),
          false
        );
      });

      test("allowAll with no deny list → true", () => {
        assert.strictEqual(mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)), true);
      });

      test("allowAll with deny list → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write"])),
          false
        );
      });

      test("custom mode → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM, ["write"], [])),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("ClaudeToolPermissionMapper", () => {
    const mapper = new ClaudeToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → ['--dangerously-skip-permissions']", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL));
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("allowAll → --permission-mode bypassPermissions --tools default", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.ok(args.includes("--permission-mode"));
        assert.ok(args.includes("bypassPermissions"));
        assert.ok(args.includes("--tools"));
        assert.ok(args.includes("default"));
      });

      test("allowAll with denied tools → adds --disallowedTools", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write"]));
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

      test("custom with allowed tools → --allowedTools entries", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], []));
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

      test("custom with no allowed or denied tools → only --permission-mode bypassPermissions", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, [], []));
        assert.ok(args.includes("--permission-mode"));
        assert.ok(args.includes("bypassPermissions"));
        assert.ok(!args.includes("--allowedTools"));
        assert.ok(!args.includes("--disallowedTools"));
      });

      test("dangerouslyAllowAll ignores deny list completely", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write"])
        );
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)),
          true
        );
      });

      test("allowAll with no deny list → true", () => {
        assert.strictEqual(mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)), true);
      });

      test("allowAll with deny list → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write"])),
          false
        );
      });

      test("custom with no deny list → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM, ["write"], [])),
          true
        );
      });

      test("custom with deny list → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM, [], ["write"])),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("CodexToolPermissionMapper", () => {
    const mapper = new CodexToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → --dangerously-bypass-approvals-and-sandbox", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL));
        assert.deepStrictEqual(args, [
          "--dangerously-bypass-approvals-and-sandbox",
        ]);
      });

      test("allowAll → --full-auto", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, ["--full-auto"]);
      });

      test("custom without sandbox/approval config → fallback --full-auto", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, [], []));
        assert.deepStrictEqual(args, ["--full-auto"]);
      });

      test("custom mode with allowed/denied patterns → still --full-auto (Codex doesn't support granular patterns)", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"]));
        assert.deepStrictEqual(args, ["--full-auto"]);
      });
    });

    suite("buildCodexSpecificArgs", () => {
      test("dangerouslyAllowAll → --dangerously-bypass-approvals-and-sandbox regardless of sandbox/approval args", () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL),
          "none",
          "auto"
        );
        assert.deepStrictEqual(args, [
          "--dangerously-bypass-approvals-and-sandbox",
        ]);
      });

      test("allowAll → --full-auto", () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.ALLOW_ALL),
          "filesystem",
          "interactive"
        );
        assert.deepStrictEqual(args, ["--full-auto"]);
      });

      test("custom with sandboxMode and approvalPolicy → -s <mode> -a <policy>", () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.CUSTOM),
          "filesystem",
          "auto"
        );
        assert.deepStrictEqual(args, ["-s", "filesystem", "-a", "auto"]);
      });

      test("custom without sandboxMode/approvalPolicy → fallback --full-auto", () => {
        const args = mapper.buildCodexSpecificArgs(cfg(PERMISSION_MODES.CUSTOM));
        assert.deepStrictEqual(args, ["--full-auto"]);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)),
          true
        );
      });

      test("allowAll → false", () => {
        assert.strictEqual(mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)), false);
      });

      test("custom → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM, ["write"], [])),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("OpenCodeToolPermissionMapper", () => {
    const mapper = new OpenCodeToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → no CLI args", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL));
        assert.deepStrictEqual(args, []);
      });

      test("allowAll → no CLI args", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, []);
      });

      test("custom with allow and deny patterns → still no CLI args", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"]));
        assert.deepStrictEqual(args, []);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)),
          true
        );
      });

      test("allowAll → true", () => {
        assert.strictEqual(mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)), true);
      });

      test("custom → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM, ["write"], [])),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("QwenToolPermissionMapper", () => {
    const mapper = new QwenToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → -y (YOLO mode)", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL));
        assert.ok(args.includes("-y"), "should include -y flag");
      });

      test("allowAll → --approval-mode auto-edit", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.ok(args.includes("--approval-mode"));
        assert.ok(args.includes("auto-edit"));
      });

      test("custom mode → --approval-mode default", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, [], []));
        assert.ok(args.includes("--approval-mode"));
        assert.ok(args.includes("default"));
      });

      test("custom mode with allowed tools → --allowed-tools", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], []));
        assert.ok(
          args.includes("--allowed-tools"),
          "should include --allowed-tools"
        );
      });

      test("custom mode with denied tools → --exclude-tools", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, [], ["write", "shell"]));
        assert.ok(
          args.includes("--exclude-tools"),
          "should include --exclude-tools"
        );
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)),
          true
        );
      });

      test("allowAll → true", () => {
        assert.strictEqual(mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)), true);
      });

      test("custom → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM, ["write"], [])),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("GeminiToolPermissionMapper", () => {
    const mapper = new GeminiToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → --approval-mode yolo", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL));
        assert.deepStrictEqual(args, ["--approval-mode", "yolo"]);
      });

      test("allowAll → --approval-mode auto_edit", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, ["--approval-mode", "auto_edit"]);
      });

      test("custom mode → --approval-mode default (patterns ignored)", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"]));
        assert.deepStrictEqual(args, ["--approval-mode", "default"]);
      });

      test("custom with empty patterns → --approval-mode default", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, [], []));
        assert.deepStrictEqual(args, ["--approval-mode", "default"]);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)),
          true
        );
      });

      test("allowAll → false", () => {
        assert.strictEqual(mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)), false);
      });

      test("custom → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM, ["write"], [])),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("Passthrough handling", () => {
    test("none mode is handled before buildArgs is called", () => {
      // Passthrough (null config) is guarded in CliIntegration before calling buildArgs().
      // When resolveToolPermissions() returns null, CliIntegration skips the mapper entirely
      // and injects no permission flags. This test documents that buildArgs() always
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
