import * as assert from "assert";
import { suite, test } from "mocha";
import {
  CliToolPermissionMapper,
  COPILOT_TO_CLAUDE_MAP,
} from "../../core/harness/shared/CliToolPermissionMapper";
import { CopilotToolPermissionMapper } from "../../core/harness/copilot/CopilotToolPermissionMapper";
import { ClaudeToolPermissionMapper } from "../../core/harness/claude/ClaudeToolPermissionMapper";
import { PERMISSION_MODES } from "../../types/DashboardConstants";
import { inspectToolPatternSyntax } from "../../utils/ToolPatternSyntax";

suite("CliToolPermissionMapper", () => {
  suite("harness-specific pattern conversion", () => {
    test("converts Copilot patterns through Claude prepare", async () => {
      const application = await new ClaudeToolPermissionMapper().prepare(
        {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: [
            "shell",
            "bash",
            "write",
            "read",
            "edit",
            "multiedit",
            "glob",
            "grep",
            "ls",
            "webfetch",
            "todowrite",
            "shell(git:*)",
            "github(search)",
            "unknown_tool",
          ],
          deniedTools: [],
        },
        {}
      );

      assert.deepStrictEqual(application.cliArgs, [
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        "Bash",
        "Write",
        "Read",
        "Edit",
        "MultiEdit",
        "Glob",
        "Grep",
        "LS",
        "WebFetch",
        "TodoWrite",
        "Bash(git:*)",
        "github(search)",
        "unknown_tool",
      ]);
    });

    test("filters read-only patterns through Copilot prepare", async () => {
      const application = await new CopilotToolPermissionMapper().prepare(
        {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: ["Read", "Edit", "mcp__github__search"],
          deniedTools: [],
        },
        {}
      );

      assert.deepStrictEqual(application.cliArgs, [
        "--allow-tool",
        "Edit",
        "github(search)",
      ]);
    });
  });

  suite("shared webview pattern inspection", () => {
    test("reports malformed wildcard and parenthesis syntax", () => {
      assert.deepStrictEqual(inspectToolPatternSyntax("shell*"), {
        doesNotMatchPattern: true,
        hasWildcardOutsideParentheses: true,
        hasUnclosedParentheses: false,
        hasOpeningParenthesis: false,
      });
      assert.deepStrictEqual(inspectToolPatternSyntax("shell(git:*"), {
        doesNotMatchPattern: true,
        hasWildcardOutsideParentheses: false,
        hasUnclosedParentheses: true,
        hasOpeningParenthesis: true,
      });
    });

    test("accepts well-formed patterns", () => {
      assert.deepStrictEqual(inspectToolPatternSyntax("shell(git:*)"), {
        doesNotMatchPattern: false,
        hasWildcardOutsideParentheses: false,
        hasUnclosedParentheses: false,
        hasOpeningParenthesis: true,
      });
    });
  });

  suite("permission preparation contract", () => {
    test("returns arguments and diagnostics through prepare()", async () => {
      const application = await new CopilotToolPermissionMapper().prepare(
        {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: ["write"],
          deniedTools: [],
        },
        {}
      );

      assert.deepStrictEqual(application.cliArgs, ["--allow-tool", "write"]);
      assert.deepStrictEqual(application.diagnostics, []);
      assert.strictEqual(application.workspaceMutation, undefined);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("parsePattern", () => {
    test("parses simple tool name", () => {
      const result = CliToolPermissionMapper.parsePattern("shell");
      assert.ok(result);
      assert.strictEqual(result![0], "shell");
      assert.strictEqual(result![1], "");
    });

    test("parses tool name with arguments", () => {
      const result = CliToolPermissionMapper.parsePattern("shell(git:*)");
      assert.ok(result);
      assert.strictEqual(result![0], "shell");
      assert.strictEqual(result![1], "(git:*)");
    });

    test("parses capitalized tool name", () => {
      const result = CliToolPermissionMapper.parsePattern("Write");
      assert.ok(result);
      assert.strictEqual(result![0], "Write");
      assert.strictEqual(result![1], "");
    });

    test("parses MCP-style pattern with parentheses", () => {
      const result = CliToolPermissionMapper.parsePattern("github(search)");
      assert.ok(result);
      assert.strictEqual(result![0], "github");
      assert.strictEqual(result![1], "(search)");
    });

    test("returns null for empty string", () => {
      const result = CliToolPermissionMapper.parsePattern("");
      assert.strictEqual(result, null);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("COPILOT_TO_CLAUDE_MAP", () => {
    test("exported map contains shell → Bash", () => {
      assert.strictEqual(COPILOT_TO_CLAUDE_MAP["shell"], "Bash");
    });

    test("exported map contains write → Write", () => {
      assert.strictEqual(COPILOT_TO_CLAUDE_MAP["write"], "Write");
    });

    test("exported map contains read → Read", () => {
      assert.strictEqual(COPILOT_TO_CLAUDE_MAP["read"], "Read");
    });
  });
});
