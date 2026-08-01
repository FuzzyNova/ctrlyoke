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
  ToolPermissionConfig,
} from "../../core/harness/shared/interfaces/IToolPermissionMapper";
import { PERMISSION_MODES } from "../../types/DashboardConstants";
import { COMPATIBILITY_DIAGNOSTIC_CODES } from "../../types/CompatibilityTypes";

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
  config: ToolPermissionConfig
): Promise<string[]> {
  return (await mapper.prepare(config, {})).cliArgs;
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

    suite("prepare", () => {
      test("dangerouslyAllowAll returns --yolo only", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, ["--yolo"]);
      });

      test("dangerouslyAllowAll suppresses deny list", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write", "shell"])
        );
        assert.ok(args.includes("--yolo"));
        assert.ok(
          !args.includes("--deny-tool"),
          "deny list ignored in dangerouslyAllowAll"
        );
      });

      test("allowAll returns --allow-all-tools with no deny-tool when deny list empty", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, ["--allow-all-tools"]);
      });

      test("allowAll includes --deny-tool for denied tools", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.ALLOW_ALL, [], ["write"])
        );
        assert.ok(args.includes("--allow-all-tools"));
        assert.ok(args.includes("--deny-tool"));
        assert.ok(args.includes("write"));
      });

      test("custom mode with allowed tools produces --allow-tool", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], [])
        );
        assert.ok(args.includes("--allow-tool"));
        assert.ok(!args.includes("--allow-all-tools"));
      });

      test("custom mode with no tools produces no flags", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], [])
        );
        assert.deepStrictEqual(args, []);
      });

      test("custom mode filters out read-only tools (grep, read, read_file, list_files, search_files)", async () => {
        const readOnlyTools = [
          "grep",
          "list_files",
          "read",
          "read_file",
          "search_files",
        ];
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, readOnlyTools, [])
        );
        assert.ok(
          !args.includes("--allow-tool"),
          "all tools filtered → no --allow-tool"
        );
      });

      test("custom mode keeps non-read-only tools alongside filtered ones", async () => {
        const args = await mapperArgs(
          mapper,
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

      test("custom mode with denied tools produces --deny-tool", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], ["shell"])
        );
        assert.ok(args.includes("--deny-tool"));
      });

      test("custom mode deduplicates allowed tool entries", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write", "write", "shell"], [])
        );
        const allowValues = argsAfterFlag(args, "--allow-tool");
        const writeCount = allowValues.filter((v) =>
          v.includes("write")
        ).length;
        assert.strictEqual(writeCount, 1, "write should appear exactly once");
      });

      test("MCP-style tool patterns pass through in custom mode", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["github(search_repositories)"], [])
        );
        assert.ok(args.includes("--allow-tool"));
        const allowValues = argsAfterFlag(args, "--allow-tool");
        assert.ok(allowValues.includes("github(search_repositories)"));
      });
    });

    suite("hasFullPermissions", () => {
      test("dangerouslyAllowAll with empty deny list → true", async () => {
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

      test("allowAll with empty deny list → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.ALLOW_ALL)),
          true
        );
      });

      test("allowAll with deny list → true", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.ALLOW_ALL, [], ["shell"])
          ),
          true
        );
      });

      test("custom mode → false even with many allowed tools", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], [])
          ),
          false
        );
      });

      test("none mode → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.NONE)),
          false
        );
      });
    });
  });

  suite("AntigravityToolPermissionMapper", () => {
    const mapper = new AntigravityToolPermissionMapper();

    suite("prepare", () => {
      test("dangerouslyAllowAll returns the Antigravity bypass flag", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("allowAll returns the Antigravity bypass flag", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("custom mode uses Antigravity sandbox and ignores allow and deny lists", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"])
        );
        assert.deepStrictEqual(args, ["--sandbox"]);
      });

      test("none mode returns no permission flags", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.NONE));
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

      test("none mode → false", async () => {
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

    suite("prepare", () => {
      test("dangerouslyAllowAll → exactly ['--dangerously-skip-permissions']", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("dangerouslyAllowAll ignores allow and deny lists", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, ["write"], ["shell"])
        );
        assert.deepStrictEqual(args, ["--dangerously-skip-permissions"]);
      });

      test("allowAll → --permission-mode bypassPermissions --tools default", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, [
          "--permission-mode",
          "bypassPermissions",
          "--tools",
          "default",
        ]);
      });

      test("allowAll with denied tools appends --disallowedTools", async () => {
        const args = await mapperArgs(
          mapper,
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

      test("deny patterns with spaces are passed as single raw args without embedded quotes", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.ALLOW_ALL, [], ["shell(git checkout:*)"])
        );
        const disallowedValues = argsAfterFlag(args, "--disallowedTools");
        assert.deepStrictEqual(disallowedValues, ["Bash(git checkout:*)"]);
        assert.ok(
          !disallowedValues[0].includes('"'),
          "tool arg should not contain literal quote characters"
        );
      });

      test("custom mode with allowed tools converts Copilot names to Claude names", async () => {
        const args = await mapperArgs(
          mapper,
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

      test("custom mode with no tools → only --permission-mode bypassPermissions", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], [])
        );
        assert.deepStrictEqual(args, [
          "--permission-mode",
          "bypassPermissions",
        ]);
      });

      test("custom mode deduplicates converted tool names", async () => {
        // "shell" and "bash" both map to "Bash"
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["shell", "bash"], [])
        );
        const allowedValues = argsAfterFlag(args, "--allowedTools");
        const bashCount = allowedValues.filter((v) =>
          v.includes("Bash")
        ).length;
        assert.strictEqual(bashCount, 1, "Bash should appear once");
      });

      test("MCP tool patterns pass through unchanged in custom mode", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["github(search)"], [])
        );
        assert.ok(args.includes("--allowedTools"));
        const allowedValues = argsAfterFlag(args, "--allowedTools");
        assert.ok(allowedValues.some((v) => v.includes("github(search)")));
      });

      test("custom mode with both allowed and denied tools", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"])
        );
        assert.ok(args.includes("--allowedTools"));
        assert.ok(args.includes("--disallowedTools"));
        const allowedValues = argsAfterFlag(args, "--allowedTools");
        assert.ok(allowedValues.some((v) => v.includes("Write")));
      });

      test("allowed patterns with spaces are passed as single raw args without embedded quotes", async () => {
        const args = await mapperArgs(
          mapper,
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
      test("dangerouslyAllowAll → true regardless of deny list", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, [], ["write"])
          ),
          true
        );
      });

      test("allowAll with empty deny list → true", async () => {
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

      test("custom with empty deny list → false", async () => {
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
            cfg(PERMISSION_MODES.CUSTOM, [], ["shell"])
          ),
          false
        );
      });

      test("none with empty deny list → false", async () => {
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

      test("custom with no sandbox/approval → fallback to explicit Auto preset flags", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.CUSTOM));
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });

      test("custom with tool patterns still falls back to Auto preset flags (Codex ignores patterns)", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], ["edit"])
        );
        assert.deepStrictEqual(args, [
          "--sandbox",
          "workspace-write",
          "--ask-for-approval",
          "on-request",
        ]);
      });

      test("none mode returns no permission flags", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.NONE));
        assert.deepStrictEqual(args, []);
      });
    });

    suite("buildCodexSpecificArgs", () => {
      test("dangerouslyAllowAll ignores sandbox/approval overrides", async () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL),
          "read-only",
          "on-request"
        );
        assert.deepStrictEqual(args, [
          "--dangerously-bypass-approvals-and-sandbox",
        ]);
      });

      test("allowAll ignores sandbox/approval overrides → explicit Auto preset flags", async () => {
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

      test("custom with sandbox=workspace-write, approval=on-request → -s workspace-write -a on-request", async () => {
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

      test("custom with sandbox=read-only, approval=untrusted → -s read-only -a untrusted", async () => {
        const args = mapper.buildCodexSpecificArgs(
          cfg(PERMISSION_MODES.CUSTOM),
          "read-only",
          "untrusted"
        );
        assert.deepStrictEqual(args, ["-s", "read-only", "-a", "untrusted"]);
      });

      test("custom with sandbox=danger-full-access, approval=never → -s danger-full-access -a never", async () => {
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

      test("custom with only sandboxMode (no approvalPolicy) → fallback to explicit Auto preset flags", async () => {
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

      test("custom with only approvalPolicy (no sandboxMode) → fallback to explicit Auto preset flags", async () => {
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
        test("dangerouslyAllowAll → bypass flag (unchanged in headless)", async () => {
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

        test("allowAll → --sandbox workspace-write only (no --ask-for-approval)", async () => {
          const args = mapper.buildCodexSpecificArgs(
            cfg(PERMISSION_MODES.ALLOW_ALL),
            undefined,
            undefined,
            false
          );
          assert.deepStrictEqual(args, ["--sandbox", "workspace-write"]);
        });

        test("custom with sandbox+approval → -s only (no -a)", async () => {
          const args = mapper.buildCodexSpecificArgs(
            cfg(PERMISSION_MODES.CUSTOM),
            "workspace-write",
            "on-request",
            false
          );
          assert.deepStrictEqual(args, ["-s", "workspace-write"]);
        });

        test("custom with read-only sandbox+approval → -s read-only only (no -a)", async () => {
          const args = mapper.buildCodexSpecificArgs(
            cfg(PERMISSION_MODES.CUSTOM),
            "read-only",
            "untrusted",
            false
          );
          assert.deepStrictEqual(args, ["-s", "read-only"]);
        });

        test("custom missing sandbox/approval → fallback without --ask-for-approval", async () => {
          const args = mapper.buildCodexSpecificArgs(
            cfg(PERMISSION_MODES.CUSTOM),
            undefined,
            undefined,
            false
          );
          assert.deepStrictEqual(args, ["--sandbox", "workspace-write"]);
        });

        test("none mode → no flags (unchanged)", async () => {
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
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM)),
          false
        );
      });

      test("none → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.NONE)),
          false
        );
      });
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  // QWEN
  // ──────────────────────────────────────────────────────────────────────────
  suite("QwenToolPermissionMapper", () => {
    const mapper = new QwenToolPermissionMapper();

    suite("prepare", () => {
      test("dangerouslyAllowAll → [-y]", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
        );
        assert.deepStrictEqual(args, ["-y"]);
      });

      test("allowAll → --approval-mode auto-edit", async () => {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.deepStrictEqual(args, ["--approval-mode", "auto-edit"]);
      });

      test("custom with no tools → --approval-mode default only", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], [])
        );
        assert.deepStrictEqual(args, ["--approval-mode", "default"]);
      });

      test("custom with allowed tools → --allowed-tools with comma-separated list", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], [])
        );
        assert.ok(args.includes("--approval-mode"));
        assert.ok(args.includes("default"));
        assert.ok(args.includes("--allowed-tools"));
        const toolsIdx = args.indexOf("--allowed-tools");
        const toolsArg = args[toolsIdx + 1];
        assert.ok(toolsArg.includes("WriteFile"), "write → WriteFile");
        assert.ok(toolsArg.includes("ShellTool"), "shell → ShellTool");
      });

      test("custom with denied tools → --exclude-tools with comma-separated list", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], ["write", "shell"])
        );
        assert.ok(args.includes("--exclude-tools"));
        const toolsIdx = args.indexOf("--exclude-tools");
        const toolsArg = args[toolsIdx + 1];
        assert.ok(toolsArg.includes("WriteFile"), "write → WriteFile");
        assert.ok(toolsArg.includes("ShellTool"), "shell → ShellTool");
      });

      test("custom with both allowed and denied tools → both flags present", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"])
        );
        assert.ok(args.includes("--allowed-tools"));
        assert.ok(args.includes("--exclude-tools"));
      });

      test("tool conversion: edit → Edit", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["edit"], [])
        );
        const toolsIdx = args.indexOf("--allowed-tools");
        const toolsArg = args[toolsIdx + 1];
        assert.ok(toolsArg.includes("Edit"));
      });

      test("tool conversion: read → Read", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["read"], [])
        );
        const toolsIdx = args.indexOf("--allowed-tools");
        const toolsArg = args[toolsIdx + 1];
        assert.ok(toolsArg.includes("Read"));
      });

      test("unknown tools pass through as-is", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["myCustomTool"], [])
        );
        const toolsIdx = args.indexOf("--allowed-tools");
        const toolsArg = args[toolsIdx + 1];
        assert.ok(toolsArg.includes("myCustomTool"));
      });

      test("delete/remove patterns have no Qwen equivalent and are skipped, not emitted as a dead 'Delete' specifier", async () => {
        const allowArgs = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["delete", "remove"], [])
        );
        assert.ok(
          !allowArgs.includes("--allowed-tools"),
          "no allowed-tools flag when only unmappable delete/remove patterns are given"
        );

        const denyArgs = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, [], ["delete", "remove"])
        );
        assert.ok(
          !denyArgs.includes("--exclude-tools"),
          "no exclude-tools flag when only unmappable delete/remove patterns are given"
        );

        const mixedArgs = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.CUSTOM, ["delete", "write"], [])
        );
        const toolsIdx = mixedArgs.indexOf("--allowed-tools");
        const toolsArg = mixedArgs[toolsIdx + 1];
        assert.ok(
          !toolsArg.includes("Delete"),
          "no phantom 'Delete' specifier"
        );
        assert.ok(
          toolsArg.includes("WriteFile"),
          "other patterns still convert"
        );
      });

      test("dangerouslyAllowAll does not include approval-mode or tool lists", async () => {
        const args = await mapperArgs(
          mapper,
          cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL, ["write"], ["shell"])
        );
        assert.deepStrictEqual(args, ["-y"]);
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
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM)),
          false
        );
      });

      test("custom with tools → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, ["write"], [])
          ),
          false
        );
      });

      test("none → false", async () => {
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

    suite("prepare", () => {
      test("dangerouslyAllowAll → empty array", async () => {
        assert.deepStrictEqual(
          await mapperArgs(mapper, cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)),
          []
        );
      });

      test("allowAll → empty array", async () => {
        assert.deepStrictEqual(
          await mapperArgs(mapper, cfg(PERMISSION_MODES.ALLOW_ALL)),
          []
        );
      });

      test("custom → empty array", async () => {
        assert.deepStrictEqual(
          await mapperArgs(mapper, cfg(PERMISSION_MODES.CUSTOM)),
          []
        );
      });

      test("custom with allowed and denied tools → still empty array", async () => {
        assert.deepStrictEqual(
          await mapperArgs(
            mapper,
            cfg(PERMISSION_MODES.CUSTOM, ["write", "shell"], ["edit"])
          ),
          []
        );
      });

      test("none → empty array", async () => {
        assert.deepStrictEqual(
          await mapperArgs(mapper, cfg(PERMISSION_MODES.NONE)),
          []
        );
      });

      test("always returns empty array regardless of config", async () => {
        for (const mode of [
          PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
          PERMISSION_MODES.ALLOW_ALL,
          PERMISSION_MODES.CUSTOM,
          PERMISSION_MODES.NONE,
        ] as const) {
          assert.deepStrictEqual(
            await mapperArgs(mapper, cfg(mode, ["write"], ["shell"])),
            [],
            `mode ${mode} should produce empty array`
          );
        }
      });
    });

    suite("buildPermissionPolicy", () => {
      test("none and dangerouslyAllowAll do not mutate opencode.json", async () => {
        assert.strictEqual(
          mapper.buildPermissionPolicy(cfg(PERMISSION_MODES.NONE)),
          undefined
        );
        assert.strictEqual(
          mapper.buildPermissionPolicy(
            cfg(PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL)
          ),
          undefined
        );
      });

      test("allowAll allows by default and applies deny overrides", async () => {
        assert.deepStrictEqual(
          mapper.buildPermissionPolicy(
            cfg(PERMISSION_MODES.ALLOW_ALL, ["write"], ["write", "shell(rm:*)"])
          ),
          {
            "*": "allow",
            edit: "deny",
            bash: { "rm *": "deny" },
          }
        );
      });

      test("custom asks by default, translates tools, and applies deny rules last", async () => {
        assert.deepStrictEqual(
          mapper.buildPermissionPolicy(
            cfg(
              PERMISSION_MODES.CUSTOM,
              ["write", "shell(git:*)", "shell(rm:*)"],
              ["shell(rm:*)", "web_search"]
            )
          ),
          {
            "*": "ask",
            edit: "allow",
            bash: {
              "git *": "allow",
              "rm *": "deny",
            },
            websearch: "deny",
          }
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
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.CUSTOM)),
          false
        );
      });

      test("custom with tools → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, ["write"], [])
          ),
          false
        );
      });

      test("none → false", async () => {
        assert.strictEqual(
          mapper.hasFullPermissions(cfg(PERMISSION_MODES.NONE)),
          false
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
      antigravity: new AntigravityToolPermissionMapper(),
      qwen: new QwenToolPermissionMapper(),
      opencode: new OpenCodeToolPermissionMapper(),
    };

    test("all mappers return string arrays from prepare", async () => {
      for (const [name, mapper] of Object.entries(mappers)) {
        const args = await mapperArgs(mapper, cfg(PERMISSION_MODES.ALLOW_ALL));
        assert.ok(
          Array.isArray(args),
          `${name}.prepare should return an array`
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

    test("all mappers return boolean from hasFullPermissions", async () => {
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

    test("dangerouslyAllowAll grants full permissions for all mappers", async () => {
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

    test("custom mode with deny list is limited for every mapper", async () => {
      for (const [name, mapper] of Object.entries(mappers)) {
        assert.strictEqual(
          mapper.hasFullPermissions(
            cfg(PERMISSION_MODES.CUSTOM, [], ["write"])
          ),
          false,
          `${name}: custom with deny list should not report full permissions`
        );
      }
    });

    test("prepare surfaces lossy granular translations as diagnostics", async () => {
      const codex = await new CodexToolPermissionMapper().prepare(
        cfg(PERMISSION_MODES.CUSTOM, ["write"], ["shell"]),
        {}
      );
      assert.deepStrictEqual(
        codex.diagnostics.map((diagnostic) => diagnostic.code),
        [
          COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_NOT_ENFORCED,
          COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_NOT_ENFORCED,
        ]
      );

      const qwen = await new QwenToolPermissionMapper().prepare(
        cfg(PERMISSION_MODES.CUSTOM, [], ["delete"]),
        {}
      );
      assert.strictEqual(qwen.diagnostics.length, 1);
      assert.strictEqual(
        qwen.diagnostics[0].code,
        COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_TRANSLATION_LOSSY
      );
    });
  });
});
