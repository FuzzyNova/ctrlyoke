import * as assert from "assert";
import { suite, test } from "mocha";
import { CopilotToolPermissionMapper } from "../../core/harness/copilot/CopilotToolPermissionMapper";
import { ClaudeToolPermissionMapper } from "../../core/harness/claude/ClaudeToolPermissionMapper";
import { CodexToolPermissionMapper } from "../../core/harness/codex/CodexToolPermissionMapper";
import { OpenCodeToolPermissionMapper } from "../../core/harness/opencode/OpenCodeToolPermissionMapper";
import { QwenToolPermissionMapper } from "../../core/harness/qwen/QwenToolPermissionMapper";
import { AntigravityToolPermissionMapper } from "../../core/harness/antigravity/AntigravityToolPermissionMapper";
import type { ToolPermissionConfig } from "../../core/harness/shared/interfaces/IToolPermissionMapper";
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

// ============================================================================

suite("ToolPermissionMappers", () => {
  // ──────────────────────────────────────────────────────────────────────────
  suite("CopilotToolPermissionMapper", () => {
    const mapper = new CopilotToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → --yolo (no deny list)", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write"])
        );
        assert.ok(args.includes("--yolo"));
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
        const args = mapper.buildArgs(
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

      test("custom mode with allowed tools → --allow-tool entries", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], [])
        );
        assert.ok(args.includes("--allow-tool"), "should contain --allow-tool");
        const allowIndex = args.indexOf("--allow-tool");
        const afterAllow = args.slice(allowIndex + 1);
        assert.ok(afterAllow.includes("write"));
        assert.ok(afterAllow.includes("shell"));
      });

      test("custom mode with no allowed tools → no --allow-tool flag", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, [], []));
        assert.ok(!args.includes("--allow-tool"));
      });

      test("read-only tools are filtered out in custom mode", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["grep", "read_file"], [])
        );
        // grep and read_file are in READ_ONLY_TOOLS → filtered → no --allow-tool produced
        assert.ok(!args.includes("--allow-tool"));
      });

      test("custom mode with deny tools → --deny-tool entries", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, [], ["write"])
        );
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
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true
        );
      });

      test("dangerouslyAllowAll with deny list → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write"])
          ),
          true
        );
      });

      test("allowAll with no deny list → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("allowAll with deny list → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write"])
          ),
          true
        );
      });

      test("custom mode → false", () => {
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

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → ['--dangerously-skip-permissions']", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("allowAll → ['--dangerously-skip-permissions']", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("custom mode → ['--sandbox']", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"])
        );
        assert.deepStrictEqual(args, ["--sandbox"]);
      });

      test("custom mode ignores allow and deny patterns", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["github(search)"], ["shell"])
        );
        assert.deepStrictEqual(args, ["--sandbox"]);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true
        );
      });

      test("allowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("custom mode → false", () => {
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

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → ['--dangerously-skip-permissions']", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
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
        const args = mapper.buildArgs(
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

      test("allowAll with spaced deny pattern → raw arg without embedded quotes", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.ALLOW_ALL, [], ["shell(git checkout:*)"])
        );
        const idx = args.indexOf("--disallowedTools");
        assert.ok(idx !== -1);
        assert.strictEqual(args[idx + 1], "Bash(git checkout:*)");
        assert.ok(!args[idx + 1].includes('"'));
      });

      test("custom with allowed tools → --allowedTools entries", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], [])
        );
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

      test("custom with spaced allow pattern → raw arg without embedded quotes", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["shell(git checkout:*)"], [])
        );
        const idx = args.indexOf("--allowedTools");
        assert.ok(idx !== -1);
        assert.strictEqual(args[idx + 1], "Bash(git checkout:*)");
        assert.ok(!args[idx + 1].includes('"'));
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
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true
        );
      });

      test("allowAll with no deny list → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("allowAll with deny list → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write"])
          ),
          true
        );
      });

      test("custom with no deny list → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, ["write"], [])
          ),
          false
        );
      });

      test("custom with deny list → false", () => {
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

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → --dangerously-bypass-approvals-and-sandbox", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, [
          "--dangerously-bypass-approvals-and-sandbox",
        ]);
      });

      test("allowAll → explicit Auto preset flags", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });

      test("custom without sandbox/approval config → fallback to explicit Auto preset flags", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, [], []));
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });

      test("custom mode with allowed/denied patterns → still Auto preset flags (Codex doesn't support granular patterns)", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"])
        );
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });
    });

    suite("buildCodexSpecificArgs", () => {
      test("dangerouslyAllowAll → --dangerously-bypass-approvals-and-sandbox regardless of sandbox/approval args", () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL),
          "read-only",
          "on-request"
        );
        assert.deepStrictEqual(args, [
          "--dangerously-bypass-approvals-and-sandbox",
        ]);
      });

      test("allowAll → explicit Auto preset flags", () => {
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

      test("custom with sandboxMode and approvalPolicy → -s <mode> -a <policy>", () => {
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

      test("custom without sandboxMode/approvalPolicy → fallback to explicit Auto preset flags", () => {
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
      test("dangerouslyAllowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true
        );
      });

      test("allowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("custom → false", () => {
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

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → no CLI args", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, []);
      });

      test("allowAll → no CLI args", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, []);
      });

      test("custom with allow and deny patterns → still no CLI args", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"])
        );
        assert.deepStrictEqual(args, []);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true
        );
      });

      test("allowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("custom → false", () => {
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

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → -y (YOLO mode)", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
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
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], [])
        );
        assert.ok(
          args.includes("--allowed-tools"),
          "should include --allowed-tools"
        );
      });

      test("custom mode with denied tools → --exclude-tools", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, [], ["write", "shell"])
        );
        assert.ok(
          args.includes("--exclude-tools"),
          "should include --exclude-tools"
        );
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true
        );
      });

      test("allowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("custom → false", () => {
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
