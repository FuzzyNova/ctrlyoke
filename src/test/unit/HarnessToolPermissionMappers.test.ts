import * as assert from "assert";
import { suite, test } from "mocha";
import { CopilotToolPermissionMapper } from "../../core/harness/copilot/CopilotToolPermissionMapper";
import { ClaudeToolPermissionMapper } from "../../core/harness/claude/ClaudeToolPermissionMapper";
import { CodexToolPermissionMapper } from "../../core/harness/codex/CodexToolPermissionMapper";
import { OpenCodeToolPermissionMapper } from "../../core/harness/opencode/OpenCodeToolPermissionMapper";
import { QwenToolPermissionMapper } from "../../core/harness/qwen/QwenToolPermissionMapper";
import { GeminiToolPermissionMapper } from "../../core/harness/gemini/GeminiToolPermissionMapper";
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

/** Return all args after the first occurrence of `flag` */
function argsAfterFlag(args: string[], flag: string): string[] {
  const idx = args.indexOf(flag);
  if (idx === -1) {
    return [];
  }
  // Collect values until the next flag (starts with --)
  const values: string[] = [];
  for (let i = idx + 1; i < args.length; i++) {
    if (args[i].startsWith("--") || args[i].startsWith("-")) {
      break;
    }
    values.push(args[i]);
  }
  return values;
}

// ============================================================================

suite("HarnessToolPermissionMappers", () => {
  // ──────────────────────────────────────────────────────────────────────────
  // COPILOT
  // ──────────────────────────────────────────────────────────────────────────
  suite("CopilotToolPermissionMapper", () => {
    const mapper = new CopilotToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll returns --yolo only", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, ["--yolo"]);
      });

      test("dangerouslyAllowAll suppresses deny list", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write", "shell"])
        );
        assert.ok(args.includes("--yolo"));
        assert.ok(
          !args.includes("--deny-tool"),
          "deny list ignored in dangerouslyAllowAll"
        );
      });

      test("allowAll returns --allow-all-tools with no deny-tool when deny list empty", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, ["--allow-all-tools"]);
      });

      test("allowAll includes --deny-tool for denied tools", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write"])
        );
        assert.ok(args.includes("--allow-all-tools"));
        assert.ok(args.includes("--deny-tool"));
        assert.ok(args.includes("write"));
      });

      test("custom mode with allowed tools produces --allow-tool", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], [])
        );
        assert.ok(args.includes("--allow-tool"));
        assert.ok(!args.includes("--allow-all-tools"));
      });

      test("custom mode with no tools produces no flags", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, [], []));
        assert.deepStrictEqual(args, []);
      });

      test("custom mode filters out read-only tools (grep, read, read_file, list_files, search_files)", () => {
        const readOnlyTools = [
          "grep",
          "list_files",
          "read",
          "read_file",
          "search_files",
        ];
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, readOnlyTools, [])
        );
        assert.ok(
          !args.includes("--allow-tool"),
          "all tools filtered → no --allow-tool"
        );
      });

      test("custom mode keeps non-read-only tools alongside filtered ones", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["grep", "write", "read"], [])
        );
        assert.ok(
          args.includes("--allow-tool"),
          "write should survive filtering"
        );
        const allowValues = argsAfterFlag(args, "--allow-tool");
        assert.ok(allowValues.includes("write"), "write preserved");
        // read and grep should be filtered
        assert.ok(
          !allowValues.some((v) => v === "read" || v === "grep"),
          "read-only tools removed"
        );
      });

      test("custom mode with denied tools produces --deny-tool", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, [], ["shell"])
        );
        assert.ok(args.includes("--deny-tool"));
      });

      test("custom mode deduplicates allowed tool entries", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write", "write", "shell"], [])
        );
        const allowValues = argsAfterFlag(args, "--allow-tool");
        const writeCount = allowValues.filter((v) =>
          v.includes("write")
        ).length;
        assert.strictEqual(writeCount, 1, "write should appear exactly once");
      });

      test("MCP-style tool patterns pass through in custom mode", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["github(search_repositories)"], [])
        );
        assert.ok(args.includes("--allow-tool"));
        const allowValues = argsAfterFlag(args, "--allow-tool");
        assert.ok(allowValues.includes("github(search_repositories)"));
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll with empty deny list → true", () => {
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

      test("allowAll with empty deny list → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("allowAll with deny list → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.ALLOW_ALL, [], ["shell"])
          ),
          true
        );
      });

      test("custom mode → false even with many allowed tools", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], [])
          ),
          false
        );
      });

      test("none mode → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.NONE)),
          false
        );
      });
    });
  });

  suite("AntigravityToolPermissionMapper", () => {
    const mapper = new AntigravityToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll returns the Antigravity bypass flag", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("allowAll returns no flags because Antigravity has no non-dangerous CLI permission mode", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, []);
      });

      test("custom mode ignores allow and deny lists", () => {
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

      test("none mode → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.NONE)),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // CLAUDE
  // ──────────────────────────────────────────────────────────────────────────
  suite("ClaudeToolPermissionMapper", () => {
    const mapper = new ClaudeToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → exactly ['--dangerously-skip-permissions']", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("dangerouslyAllowAll ignores allow and deny lists", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, ["write"], ["shell"])
        );
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("allowAll → --permission-mode bypassPermissions --tools default", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, [
          "--permission-mode",
          "bypassPermissions",
          "--tools",
          "default",
        ]);
      });

      test("allowAll with denied tools appends --disallowedTools", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write", "shell"])
        );
        assert.ok(args.includes("--disallowedTools"));
        const disallowedValues = argsAfterFlag(args, "--disallowedTools");
        assert.ok(
          disallowedValues.some((v) => v.includes("Write")),
          "write → Write"
        );
        assert.ok(
          disallowedValues.some((v) => v.includes("Bash")),
          "shell → Bash"
        );
      });

      test("deny patterns with spaces are passed as single raw args without embedded quotes", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.ALLOW_ALL, [], ["shell(git checkout:*)"])
        );
        const disallowedValues = argsAfterFlag(args, "--disallowedTools");
        assert.deepStrictEqual(disallowedValues, ["Bash(git checkout:*)"]);
        assert.ok(
          !disallowedValues[0].includes('"'),
          "tool arg should not contain literal quote characters"
        );
      });

      test("custom mode with allowed tools converts Copilot names to Claude names", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["shell", "write", "edit", "glob"], [])
        );
        assert.ok(args.includes("--allowedTools"));
        const allowedValues = argsAfterFlag(args, "--allowedTools");
        assert.ok(
          allowedValues.some((v) => v.includes("Bash")),
          "shell → Bash"
        );
        assert.ok(
          allowedValues.some((v) => v.includes("Write")),
          "write → Write"
        );
        assert.ok(
          allowedValues.some((v) => v.includes("Edit")),
          "edit → Edit"
        );
        assert.ok(
          allowedValues.some((v) => v.includes("Glob")),
          "glob → Glob"
        );
      });

      test("custom mode with no tools → only --permission-mode bypassPermissions", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, [], []));
        assert.deepStrictEqual(args, [
          "--permission-mode",
          "bypassPermissions",
        ]);
      });

      test("custom mode deduplicates converted tool names", () => {
        // "shell" and "bash" both map to "Bash"
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["shell", "bash"], [])
        );
        const allowedValues = argsAfterFlag(args, "--allowedTools");
        const bashCount = allowedValues.filter((v) =>
          v.includes("Bash")
        ).length;
        assert.strictEqual(bashCount, 1, "Bash should appear once");
      });

      test("MCP tool patterns pass through unchanged in custom mode", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["github(search)"], [])
        );
        assert.ok(args.includes("--allowedTools"));
        const allowedValues = argsAfterFlag(args, "--allowedTools");
        assert.ok(allowedValues.some((v) => v.includes("github(search)")));
      });

      test("custom mode with both allowed and denied tools", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"])
        );
        assert.ok(args.includes("--allowedTools"));
        assert.ok(args.includes("--disallowedTools"));
        const allowedValues = argsAfterFlag(args, "--allowedTools");
        assert.ok(allowedValues.some((v) => v.includes("Write")));
      });

      test("allowed patterns with spaces are passed as single raw args without embedded quotes", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["shell(git checkout:*)"], [])
        );
        const allowedValues = argsAfterFlag(args, "--allowedTools");
        assert.deepStrictEqual(allowedValues, ["Bash(git checkout:*)"]);
        assert.ok(
          !allowedValues[0].includes('"'),
          "tool arg should not contain literal quote characters"
        );
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll → true regardless of deny list", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write"])
          ),
          true
        );
      });

      test("allowAll with empty deny list → true", () => {
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

      test("custom with empty deny list → false", () => {
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
            cfg(PERMISSION_MODES.CUSTOM, [], ["shell"])
          ),
          false
        );
      });

      test("none with empty deny list → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.NONE)),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // CODEX
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

      test("custom with no sandbox/approval → fallback to explicit Auto preset flags", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM));
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });

      test("custom with tool patterns still falls back to Auto preset flags (Codex ignores patterns)", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], ["edit"])
        );
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });

      test("none mode returns no permission flags", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.NONE));
        assert.deepStrictEqual(args, []);
      });
    });

    suite("buildCodexSpecificArgs", () => {
      test("dangerouslyAllowAll ignores sandbox/approval overrides", () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL),
          "read-only",
          "on-request"
        );
        assert.deepStrictEqual(args, [
          "--dangerously-bypass-approvals-and-sandbox",
        ]);
      });

      test("allowAll ignores sandbox/approval overrides → explicit Auto preset flags", () => {
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

      test("custom with sandbox=workspace-write, approval=on-request → -s workspace-write -a on-request", () => {
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

      test("custom with sandbox=read-only, approval=untrusted → -s read-only -a untrusted", () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.CUSTOM),
          "read-only",
          "untrusted"
        );
        assert.deepStrictEqual(args, ["-s", "read-only", "-a", "untrusted"]);
      });

      test("custom with sandbox=danger-full-access, approval=never → -s danger-full-access -a never", () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.CUSTOM),
          "danger-full-access",
          "never"
        );
        assert.deepStrictEqual(args, [
          "-s",
          "danger-full-access",
          "-a",
          "never",
        ]);
      });

      test("custom with only sandboxMode (no approvalPolicy) → fallback to explicit Auto preset flags", () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.CUSTOM),
          "workspace-write"
        );
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });

      test("custom with only approvalPolicy (no sandboxMode) → fallback to explicit Auto preset flags", () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.CUSTOM),
          undefined,
          "on-request"
        );
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });
    });

    suite(
      "buildCodexSpecificArgs — headless exec mode (isInteractive: false)",
      () => {
        test("dangerouslyAllowAll → bypass flag (unchanged in headless)", () => {
          const args = mapper.buildCodexSpecificArgs(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL),
            undefined,
            undefined,
            false
          );
          assert.deepStrictEqual(args, [
            "--dangerously-bypass-approvals-and-sandbox",
          ]);
        });

        test("allowAll → --sandbox workspace-write only (no --ask-for-approval)", () => {
          const args = mapper.buildCodexSpecificArgs(
            cfg(PERMISSION_MODES.ALLOW_ALL),
            undefined,
            undefined,
            false
          );
          assert.deepStrictEqual(args, ["--sandbox", "workspace-write"]);
        });

        test("custom with sandbox+approval → -s only (no -a)", () => {
          const args = mapper.buildCodexSpecificArgs(
            cfg(PERMISSION_MODES.CUSTOM),
            "workspace-write",
            "on-request",
            false
          );
          assert.deepStrictEqual(args, ["-s", "workspace-write"]);
        });

        test("custom with read-only sandbox+approval → -s read-only only (no -a)", () => {
          const args = mapper.buildCodexSpecificArgs(
            cfg(PERMISSION_MODES.CUSTOM),
            "read-only",
            "untrusted",
            false
          );
          assert.deepStrictEqual(args, ["-s", "read-only"]);
        });

        test("custom missing sandbox/approval → fallback without --ask-for-approval", () => {
          const args = mapper.buildCodexSpecificArgs(
            cfg(PERMISSION_MODES.CUSTOM),
            undefined,
            undefined,
            false
          );
          assert.deepStrictEqual(args, ["--sandbox", "workspace-write"]);
        });

        test("none mode → no flags (unchanged)", () => {
          const args = mapper.buildCodexSpecificArgs(
            cfg(PERMISSION_MODES.NONE),
            undefined,
            undefined,
            false
          );
          assert.deepStrictEqual(args, []);
        });
      }
    );

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
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM)),
          false
        );
      });

      test("none → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.NONE)),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // GEMINI
  // ──────────────────────────────────────────────────────────────────────────
  suite("GeminiToolPermissionMapper", () => {
    const mapper = new GeminiToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → --approval-mode yolo", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, ["--approval-mode", "yolo"]);
      });

      test("allowAll → --approval-mode auto_edit", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, ["--approval-mode", "auto_edit"]);
      });

      test("custom mode → --approval-mode default", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM));
        assert.deepStrictEqual(args, ["--approval-mode", "default"]);
      });

      test("custom with tool patterns → --approval-mode default (patterns ignored)", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], ["edit"])
        );
        assert.deepStrictEqual(args, ["--approval-mode", "default"]);
      });

      test("none mode → --approval-mode default (falls through to default branch)", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.NONE));
        assert.deepStrictEqual(args, ["--approval-mode", "default"]);
      });

      test("dangerouslyAllowAll ignores allow/deny lists", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, ["write"], ["shell"])
        );
        assert.deepStrictEqual(args, ["--approval-mode", "yolo"]);
      });

      test("always returns exactly 2 args", () => {
        for (const mode of [
          PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
          PERMISSION_MODES.ALLOW_ALL,
          PERMISSION_MODES.CUSTOM,
          PERMISSION_MODES.NONE,
        ] as const) {
          const args = mapper.buildArgs(cfg(mode));
          assert.strictEqual(
            args.length,
            2,
            `mode ${mode} should produce exactly 2 args`
          );
          assert.strictEqual(args[0], "--approval-mode");
        }
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

      test("none → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.NONE)),
          false
        );
      });

      test("dangerouslyAllowAll with deny list → still true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write"])
          ),
          true
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // QWEN
  // ──────────────────────────────────────────────────────────────────────────
  suite("QwenToolPermissionMapper", () => {
    const mapper = new QwenToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → [-y]", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, ["-y"]);
      });

      test("allowAll → --approval-mode auto-edit", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, ["--approval-mode", "auto-edit"]);
      });

      test("custom with no tools → --approval-mode default only", () => {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM, [], []));
        assert.deepStrictEqual(args, ["--approval-mode", "default"]);
      });

      test("custom with allowed tools → --allowed-tools with comma-separated list", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], [])
        );
        assert.ok(args.includes("--approval-mode"));
        assert.ok(args.includes("default"));
        assert.ok(args.includes("--allowed-tools"));
        const toolsIdx = args.indexOf("--allowed-tools");
        const toolsArg = args[toolsIdx + 1];
        assert.ok(toolsArg.includes("Write"), "write → Write");
        assert.ok(toolsArg.includes("Bash"), "shell → Bash");
      });

      test("custom with denied tools → --exclude-tools with comma-separated list", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, [], ["write", "shell"])
        );
        assert.ok(args.includes("--exclude-tools"));
        const toolsIdx = args.indexOf("--exclude-tools");
        const toolsArg = args[toolsIdx + 1];
        assert.ok(toolsArg.includes("Write"), "write → Write");
        assert.ok(toolsArg.includes("Bash"), "shell → Bash");
      });

      test("custom with both allowed and denied tools → both flags present", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"])
        );
        assert.ok(args.includes("--allowed-tools"));
        assert.ok(args.includes("--exclude-tools"));
      });

      test("tool conversion: edit → Edit", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["edit"], [])
        );
        const toolsIdx = args.indexOf("--allowed-tools");
        const toolsArg = args[toolsIdx + 1];
        assert.ok(toolsArg.includes("Edit"));
      });

      test("tool conversion: read → Read", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["read"], [])
        );
        const toolsIdx = args.indexOf("--allowed-tools");
        const toolsArg = args[toolsIdx + 1];
        assert.ok(toolsArg.includes("Read"));
      });

      test("unknown tools pass through as-is", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.CUSTOM, ["myCustomTool"], [])
        );
        const toolsIdx = args.indexOf("--allowed-tools");
        const toolsArg = args[toolsIdx + 1];
        assert.ok(toolsArg.includes("myCustomTool"));
      });

      test("dangerouslyAllowAll does not include approval-mode or tool lists", () => {
        const args = mapper.buildArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, ["write"], ["shell"])
        );
        assert.deepStrictEqual(args, ["-y"]);
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
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM)),
          false
        );
      });

      test("custom with tools → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, ["write"], [])
          ),
          false
        );
      });

      test("none → false", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.NONE)),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // OPENCODE
  // ──────────────────────────────────────────────────────────────────────────
  suite("OpenCodeToolPermissionMapper", () => {
    const mapper = new OpenCodeToolPermissionMapper();

    suite("buildArgs", () => {
      test("dangerouslyAllowAll → empty array", () => {
        assert.deepStrictEqual(
          mapper.buildArgs(cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)),
          []
        );
      });

      test("allowAll → empty array", () => {
        assert.deepStrictEqual(
          mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL)),
          []
        );
      });

      test("custom → empty array", () => {
        assert.deepStrictEqual(
          mapper.buildArgs(cfg(PERMISSION_MODES.CUSTOM)),
          []
        );
      });

      test("custom with allowed and denied tools → still empty array", () => {
        assert.deepStrictEqual(
          mapper.buildArgs(
            cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], ["edit"])
          ),
          []
        );
      });

      test("none → empty array", () => {
        assert.deepStrictEqual(
          mapper.buildArgs(cfg(PERMISSION_MODES.NONE)),
          []
        );
      });

      test("always returns empty array regardless of config", () => {
        for (const mode of [
          PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
          PERMISSION_MODES.ALLOW_ALL,
          PERMISSION_MODES.CUSTOM,
          PERMISSION_MODES.NONE,
        ] as const) {
          assert.deepStrictEqual(
            mapper.buildArgs(cfg(mode, ["write"], ["shell"])),
            [],
            `mode ${mode} should produce empty array`
          );
        }
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

      test("custom → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM)),
          true
        );
      });

      test("custom with tools → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, ["write"], [])
          ),
          true
        );
      });

      test("none → true", () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.NONE)),
          true
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // CROSS-MAPPER CONSISTENCY
  // ──────────────────────────────────────────────────────────────────────────
  suite("Cross-mapper consistency", () => {
    const mappers = {
      copilot: new CopilotToolPermissionMapper(),
      claude: new ClaudeToolPermissionMapper(),
      codex: new CodexToolPermissionMapper(),
      gemini: new GeminiToolPermissionMapper(),
      qwen: new QwenToolPermissionMapper(),
      opencode: new OpenCodeToolPermissionMapper(),
    };

    test("all mappers return string arrays from buildArgs", () => {
      for (const [name, mapper] of Object.entries(mappers)) {
        const args = mapper.buildArgs(cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.ok(
          Array.isArray(args),
          `${name}.buildArgs should return an array`
        );
        for (const arg of args) {
          assert.strictEqual(
            typeof arg,
            "string",
            `${name}: each arg should be a string`
          );
        }
      }
    });

    test("all mappers return boolean from hasFullPermissions", () => {
      for (const [name, mapper] of Object.entries(mappers)) {
        const result = mapper.hasFullPermissions(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.strictEqual(
          typeof result,
          "boolean",
          `${name}.hasFullPermissions should return boolean`
        );
      }
    });

    test("dangerouslyAllowAll grants full permissions for all mappers", () => {
      for (const [name, mapper] of Object.entries(mappers)) {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          true,
          `${name}: dangerouslyAllowAll should grant full permissions`
        );
      }
    });

    test("custom mode with deny list only grants full permissions for OpenCode", () => {
      for (const [name, mapper] of Object.entries(mappers)) {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, [], ["write"])
          ),
          name === "opencode",
          `${name}: custom with deny list should match harness-specific approval behavior`
        );
      }
    });
  });
});
