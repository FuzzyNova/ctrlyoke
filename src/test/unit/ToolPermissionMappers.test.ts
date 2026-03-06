import * as assert from "assert";
import { suite, test } from "mocha";
import { CopilotToolPermissionMapper } from "../../flightpath/harness/copilot/CopilotToolPermissionMapper";
import { ClaudeToolPermissionMapper } from "../../flightpath/harness/claude/ClaudeToolPermissionMapper";
import { CodexToolPermissionMapper } from "../../flightpath/harness/codex/CodexToolPermissionMapper";
import { OpenCodeToolPermissionMapper } from "../../flightpath/harness/opencode/OpenCodeToolPermissionMapper";
import type { ToolPermissionConfig } from "../../flightpath/harness/shared/interfaces/IToolPermissionMapper";

// ─── helpers ────────────────────────────────────────────────────────────────

function cfg(
  mode: ToolPermissionConfig["mode"],
  allowedTools: string[] = [],
  deniedTools: string[] = []
): ToolPermissionConfig {
  return { mode, allowedTools, deniedTools };
}

// ============================================================================

suite("ToolPermissionMappers", () => {
  // ──────────────────────────────────────────────────────────────────────────
  suite("CopilotToolPermissionMapper", () => {
    const mapper = new CopilotToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → --allow-all-tools (no deny list)", () => {
        const args = mapper.buildArgs(
          cfg("dangerouslyAllowAll", [], ["write"])
        );
        assert.ok(args.includes("--allow-all-tools"));
        assert.ok(
          !args.includes("--deny-tool"),
          "deny list should be suppressed for dangerouslyAllowAll"
        );
      });

      test("allowAll → --allow-all-tools", () => {
        const args = mapper.buildArgs(cfg("allowAll"));
        assert.ok(args.includes("--allow-all-tools"));
      });

      test("allowAll with denied tools → --allow-all-tools and --deny-tool entries", () => {
        const args = mapper.buildArgs(cfg("allowAll", [], ["write", "shell"]));
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
        const args = mapper.buildArgs(cfg("custom", ["write", "shell"], []));
        assert.ok(args.includes("--allow-tool"), "should contain --allow-tool");
        const allowIndex = args.indexOf("--allow-tool");
        const afterAllow = args.slice(allowIndex + 1);
        assert.ok(
          afterAllow.some((a) => a.includes("write") || a.includes("shell"))
        );
      });

      test("custom mode with no allowed tools → no --allow-tool flag", () => {
        const args = mapper.buildArgs(cfg("custom", [], []));
        assert.ok(!args.includes("--allow-tool"));
      });

      test("read-only tools are filtered out in custom mode", () => {
        const args = mapper.buildArgs(cfg("custom", ["grep", "read_file"], []));
        // grep and read_file are in READ_ONLY_TOOLS → filtered → no --allow-tool produced
        assert.ok(!args.includes("--allow-tool"));
      });

      test("custom mode with deny tools → --deny-tool entries", () => {
        const args = mapper.buildArgs(cfg("custom", [], ["write"]));
        assert.ok(args.includes("--deny-tool"));
      });

      test("dangerouslyAllowAll returns no --deny-tool even when denied tools provided", () => {
        const args = mapper.buildArgs(
          cfg("dangerouslyAllowAll", [], ["write", "shell"])
        );
        assert.ok(!args.includes("--deny-tool"));
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll with no deny list → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg("dangerouslyAllowAll")),
          true
        );
      });

      test("dangerouslyAllowAll with deny list → false (Copilot still checks deny list)", () => {
        // Copilot's hasFullPermissions requires deniedTools.length === 0 for all modes
        assert.strictEqual(
          mapper.hasFullPermissions(cfg("dangerouslyAllowAll", [], ["write"])),
          false
        );
      });

      test("allowAll with no deny list → true", () => {
        assert.strictEqual(mapper.hasFullPermissions(cfg("allowAll")), true);
      });

      test("allowAll with deny list → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg("allowAll", [], ["write"])),
          false
        );
      });

      test("custom mode → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg("custom", ["write"], [])),
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
        const args = mapper.buildArgs(cfg("dangerouslyAllowAll"));
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("allowAll → --permission-mode bypassPermissions --tools default", () => {
        const args = mapper.buildArgs(cfg("allowAll"));
        assert.ok(args.includes("--permission-mode"));
        assert.ok(args.includes("bypassPermissions"));
        assert.ok(args.includes("--tools"));
        assert.ok(args.includes("default"));
      });

      test("allowAll with denied tools → adds --disallowedTools", () => {
        const args = mapper.buildArgs(cfg("allowAll", [], ["write"]));
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
        const args = mapper.buildArgs(cfg("custom", ["write", "shell"], []));
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
        const args = mapper.buildArgs(cfg("custom", [], []));
        assert.ok(args.includes("--permission-mode"));
        assert.ok(args.includes("bypassPermissions"));
        assert.ok(!args.includes("--allowedTools"));
        assert.ok(!args.includes("--disallowedTools"));
      });

      test("dangerouslyAllowAll ignores deny list completely", () => {
        const args = mapper.buildArgs(
          cfg("dangerouslyAllowAll", [], ["write"])
        );
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg("dangerouslyAllowAll")),
          true
        );
      });

      test("allowAll with no deny list → true", () => {
        assert.strictEqual(mapper.hasFullPermissions(cfg("allowAll")), true);
      });

      test("allowAll with deny list → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg("allowAll", [], ["write"])),
          false
        );
      });

      test("custom with no deny list → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg("custom", ["write"], [])),
          true
        );
      });

      test("custom with deny list → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg("custom", [], ["write"])),
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
        const args = mapper.buildArgs(cfg("dangerouslyAllowAll"));
        assert.deepStrictEqual(args, [
          "--dangerously-bypass-approvals-and-sandbox",
        ]);
      });

      test("allowAll → --full-auto", () => {
        const args = mapper.buildArgs(cfg("allowAll"));
        assert.deepStrictEqual(args, ["--full-auto"]);
      });

      test("custom without sandbox/approval config → fallback --full-auto", () => {
        const args = mapper.buildArgs(cfg("custom", [], []));
        assert.deepStrictEqual(args, ["--full-auto"]);
      });

      test("custom mode with allowed/denied patterns → still --full-auto (Codex doesn't support granular patterns)", () => {
        const args = mapper.buildArgs(cfg("custom", ["write"], ["shell"]));
        assert.deepStrictEqual(args, ["--full-auto"]);
      });
    });

    suite("buildCodexSpecificArgs", () => {
      test("dangerouslyAllowAll → --dangerously-bypass-approvals-and-sandbox regardless of sandbox/approval args", () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg("dangerouslyAllowAll"),
          "none",
          "auto"
        );
        assert.deepStrictEqual(args, [
          "--dangerously-bypass-approvals-and-sandbox",
        ]);
      });

      test("allowAll → --full-auto", () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg("allowAll"),
          "filesystem",
          "interactive"
        );
        assert.deepStrictEqual(args, ["--full-auto"]);
      });

      test("custom with sandboxMode and approvalPolicy → -s <mode> -a <policy>", () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg("custom"),
          "filesystem",
          "auto"
        );
        assert.deepStrictEqual(args, ["-s", "filesystem", "-a", "auto"]);
      });

      test("custom without sandboxMode/approvalPolicy → fallback --full-auto", () => {
        const args = mapper.buildCodexSpecificArgs(cfg("custom"));
        assert.deepStrictEqual(args, ["--full-auto"]);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg("dangerouslyAllowAll")),
          true
        );
      });

      test("allowAll → false", () => {
        assert.strictEqual(mapper.hasFullPermissions(cfg("allowAll")), false);
      });

      test("custom → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg("custom", ["write"], [])),
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
        const args = mapper.buildArgs(cfg("dangerouslyAllowAll"));
        assert.deepStrictEqual(args, []);
      });

      test("allowAll → no CLI args", () => {
        const args = mapper.buildArgs(cfg("allowAll"));
        assert.deepStrictEqual(args, []);
      });

      test("custom with allow and deny patterns → still no CLI args", () => {
        const args = mapper.buildArgs(cfg("custom", ["write"], ["shell"]));
        assert.deepStrictEqual(args, []);
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg("dangerouslyAllowAll")),
          true
        );
      });

      test("allowAll → true", () => {
        assert.strictEqual(mapper.hasFullPermissions(cfg("allowAll")), true);
      });

      test("custom → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg("custom", ["write"], [])),
          false
        );
      });
    });
  });
});
