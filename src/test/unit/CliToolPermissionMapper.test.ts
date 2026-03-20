import * as assert from "assert";
import { suite, test } from "mocha";
import {
  CliToolPermissionMapper,
  COPILOT_TO_CLAUDE_MAP,
} from "../../flightpath/harness/shared/CliToolPermissionMapper";

suite("CliToolPermissionMapper", () => {
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
  suite("convertToClaudeFormat", () => {
    test("shell → Bash", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("shell"),
        "Bash"
      );
    });

    test("bash → Bash", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("bash"),
        "Bash"
      );
    });

    test("write → Write", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("write"),
        "Write"
      );
    });

    test("read → Read", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("read"),
        "Read"
      );
    });

    test("edit → Edit", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("edit"),
        "Edit"
      );
    });

    test("multiedit → MultiEdit", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("multiedit"),
        "MultiEdit"
      );
    });

    test("glob → Glob", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("glob"),
        "Glob"
      );
    });

    test("grep → Grep", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("grep"),
        "Grep"
      );
    });

    test("ls → LS", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("ls"),
        "LS"
      );
    });

    test("webfetch → WebFetch", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("webfetch"),
        "WebFetch"
      );
    });

    test("preserves args when converting shell(git:*) → Bash(git:*)", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("shell(git:*)"),
        "Bash(git:*)"
      );
    });

    test("MCP tool passes through unchanged (github(search))", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("github(search)"),
        "github(search)"
      );
    });

    test("unknown tool passes through unchanged", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToClaudeFormat("unknown_tool"),
        "unknown_tool"
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("convertToCopilotFormat", () => {
    test("Bash → shell", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("Bash"),
        "shell"
      );
    });

    test("bash (lowercase) → shell", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("bash"),
        "shell"
      );
    });

    test("Write → write", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("Write"),
        "write"
      );
    });

    test("Edit → write (closest equivalent)", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("Edit"),
        "write"
      );
    });

    test("MultiEdit → write (closest equivalent)", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("MultiEdit"),
        "write"
      );
    });

    test("Read → null (read-only, no Copilot permission needed)", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("Read"),
        null
      );
    });

    test("Glob → null (read-only)", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("Glob"),
        null
      );
    });

    test("Grep → null (read-only)", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("Grep"),
        null
      );
    });

    test("LS → null (read-only)", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("LS"),
        null
      );
    });

    test("WebFetch → null (read-only)", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("WebFetch"),
        null
      );
    });

    test("preserves args when converting Bash(git:*) → shell(git:*)", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("Bash(git:*)"),
        "shell(git:*)"
      );
    });

    test("MCP tool passes through unchanged (github(search))", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("github(search)"),
        "github(search)"
      );
    });

    test("unknown tool passes through unchanged", () => {
      assert.strictEqual(
        CliToolPermissionMapper.convertToCopilotFormat("unknown_mcp_tool"),
        "unknown_mcp_tool"
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  suite("validatePatterns", () => {
    test("returns empty array for valid patterns", () => {
      const warnings = CliToolPermissionMapper.validatePatterns([
        "shell",
        "write",
        "edit",
      ]);
      assert.deepStrictEqual(warnings, []);
    });

    test("returns 0 warnings for wildcard-only pattern (early-continue path)", () => {
      // "shell*" doesn't parse (parsePattern returns null) and has no "(",
      // so it hits the early `continue` and generates no warning.
      const warnings = CliToolPermissionMapper.validatePatterns(["shell*"]);
      assert.strictEqual(warnings.length, 0);
    });

    test("returns warning for unclosed parentheses", () => {
      const warnings = CliToolPermissionMapper.validatePatterns([
        "shell(git:*",
      ]);
      assert.strictEqual(warnings.length, 1);
      assert.ok(warnings[0].includes("unclosed parentheses"));
    });

    test("returns multiple warnings for multiple unclosed-paren patterns", () => {
      // Use two patterns that each have "(" without ")" to get 2 warnings
      const warnings = CliToolPermissionMapper.validatePatterns([
        "shell(git:*",
        "write(",
      ]);
      assert.strictEqual(warnings.length, 2);
    });

    test("returns empty array for empty patterns list", () => {
      const warnings = CliToolPermissionMapper.validatePatterns([]);
      assert.deepStrictEqual(warnings, []);
    });

    test("valid parenthesized pattern does not warn", () => {
      // shell(git:*) is valid; write(src/*)) has matching parens but extra close - let's just check shell(*) is fine
      const shellWarnings = CliToolPermissionMapper.validatePatterns([
        "shell(*)",
        "Bash(git:*)",
      ]);
      assert.deepStrictEqual(shellWarnings, []);
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
