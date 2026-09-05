import * as assert from "assert";
import { suite, test } from "mocha";
import {
  CliEventMapper,
  ToolClassification,
} from "../../core/harness/shared/CliEventMapper";
import { CLI_EVENT_TYPES } from "../../types/DashboardConstants";

suite("CliEventMapper", () => {
  suite("classifyTool", () => {
    // ── BASH_COMMAND ──────────────────────────────────────────────────────────

    test("bash → BASH_COMMAND", () => {
      const result = CliEventMapper.classifyTool("bash");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.BASH_COMMAND);
    });

    test("shell → BASH_COMMAND", () => {
      const result = CliEventMapper.classifyTool("shell");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.BASH_COMMAND);
    });

    test("execute_command → BASH_COMMAND", () => {
      const result = CliEventMapper.classifyTool("execute_command");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.BASH_COMMAND);
    });

    test("run_command → BASH_COMMAND", () => {
      const result = CliEventMapper.classifyTool("run_command");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.BASH_COMMAND);
    });

    test("BASH (uppercase) → BASH_COMMAND (case-insensitive)", () => {
      const result = CliEventMapper.classifyTool("BASH");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.BASH_COMMAND);
    });

    test("Execute_Command (mixed case) → BASH_COMMAND (case-insensitive)", () => {
      const result = CliEventMapper.classifyTool("Execute_Command");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.BASH_COMMAND);
    });

    // ── FILE_READ ─────────────────────────────────────────────────────────────

    test("read_file → FILE_READ", () => {
      const result = CliEventMapper.classifyTool("read_file");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.FILE_READ);
    });

    test("view → FILE_READ", () => {
      const result = CliEventMapper.classifyTool("view");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.FILE_READ);
    });

    test("cat → TOOL_CALL (shell command, not a native harness read tool)", () => {
      const result = CliEventMapper.classifyTool("cat");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.TOOL_CALL);
    });

    // ── FILE_WRITE ────────────────────────────────────────────────────────────

    test("write_file → FILE_WRITE", () => {
      const result = CliEventMapper.classifyTool("write_file");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.FILE_WRITE);
    });

    test("str_replace_editor (not in set) → TOOL_CALL fallback", () => {
      // str_replace_editor is not in the known sets, so it falls through to TOOL_CALL
      const result = CliEventMapper.classifyTool("str_replace_editor");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.TOOL_CALL);
    });

    // ── FILE_EDIT ─────────────────────────────────────────────────────────────

    test("replace_string_in_file → FILE_EDIT", () => {
      const result = CliEventMapper.classifyTool("replace_string_in_file");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.FILE_EDIT);
    });

    test("multiedit → FILE_EDIT", () => {
      const result = CliEventMapper.classifyTool("multiedit");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.FILE_EDIT);
    });

    test("apply_patch → FILE_EDIT", () => {
      const result = CliEventMapper.classifyTool("apply_patch");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.FILE_EDIT);
    });

    test("edit_file → FILE_EDIT", () => {
      const result = CliEventMapper.classifyTool("edit_file");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.FILE_EDIT);
    });

    // ── FILE_DELETE ───────────────────────────────────────────────────────────

    test("delete_file → FILE_DELETE", () => {
      const result = CliEventMapper.classifyTool("delete_file");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.FILE_DELETE);
    });

    test("rm → TOOL_CALL (shell command, not a native harness delete tool)", () => {
      const result = CliEventMapper.classifyTool("rm");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.TOOL_CALL);
    });

    // ── WEB_SEARCH ────────────────────────────────────────────────────────────

    test("web_search → WEB_SEARCH", () => {
      const result = CliEventMapper.classifyTool("web_search");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.WEB_SEARCH);
    });

    test("webfetch → WEB_SEARCH", () => {
      const result = CliEventMapper.classifyTool("webfetch");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.WEB_SEARCH);
    });

    // ── MCP_TOOL_CALL — Copilot paren format ─────────────────────────────────

    test("github(search_repositories) → MCP_TOOL_CALL (Copilot paren format)", () => {
      const result = CliEventMapper.classifyTool("github(search_repositories)");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
      if (result.type === CLI_EVENT_TYPES.MCP_TOOL_CALL) {
        assert.strictEqual(result.server, "github");
        assert.strictEqual(result.tool, "search_repositories");
      }
    });

    test("linear(create_issue) → MCP_TOOL_CALL (Copilot paren format)", () => {
      const result = CliEventMapper.classifyTool("linear(create_issue)");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
      if (result.type === CLI_EVENT_TYPES.MCP_TOOL_CALL) {
        assert.strictEqual(result.server, "linear");
        assert.strictEqual(result.tool, "create_issue");
      }
    });

    // ── MCP_TOOL_CALL — Codex double-underscore format ────────────────────────

    test("mcp_github__search → MCP_TOOL_CALL (Codex double-underscore)", () => {
      const result = CliEventMapper.classifyTool("mcp_github__search");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
    });

    test("server__tool → MCP_TOOL_CALL (double-underscore, server extracted)", () => {
      const result = CliEventMapper.classifyTool("server__tool");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
      if (result.type === CLI_EVENT_TYPES.MCP_TOOL_CALL) {
        assert.strictEqual(result.server, "server");
        assert.strictEqual(result.tool, "tool");
      }
    });

    // ── MCP_TOOL_CALL — standard "mcp__<server>__<tool>" format ─────────────

    test("mcp__ctrlyoke__append_step → MCP_TOOL_CALL (server/tool correctly split)", () => {
      // Regression: the generic "server__tool" branch above would split on the
      // *first* "__", wrongly extracting server="mcp",
      // tool="ctrlyoke__append_step" for this format — used both by
      // Claude Code's native MCP tool names and by Codex's exec-unwrapped
      // ctrlyoke MCP calls.
      const result = CliEventMapper.classifyTool(
        "mcp__ctrlyoke__append_step"
      );
      assert.strictEqual(result.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
      if (result.type === CLI_EVENT_TYPES.MCP_TOOL_CALL) {
        assert.strictEqual(result.server, "ctrlyoke");
        assert.strictEqual(result.tool, "append_step");
      }
    });

    test("mcp__github__search_repositories → MCP_TOOL_CALL (server/tool correctly split)", () => {
      const result = CliEventMapper.classifyTool(
        "mcp__github__search_repositories"
      );
      assert.strictEqual(result.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
      if (result.type === CLI_EVENT_TYPES.MCP_TOOL_CALL) {
        assert.strictEqual(result.server, "github");
        assert.strictEqual(result.tool, "search_repositories");
      }
    });

    // ── MCP_TOOL_CALL — Claude dot format ────────────────────────────────────

    test("github.search → MCP_TOOL_CALL (Claude dot format)", () => {
      const result = CliEventMapper.classifyTool("github.search");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
      if (result.type === CLI_EVENT_TYPES.MCP_TOOL_CALL) {
        assert.strictEqual(result.server, "github");
        assert.strictEqual(result.tool, "search");
      }
    });

    // ── MCP_TOOL_CALL — Claude mcp_ prefix ───────────────────────────────────

    test("mcp_linear → MCP_TOOL_CALL (Claude mcp_ prefix)", () => {
      const result = CliEventMapper.classifyTool("mcp_linear");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
    });

    test("mcp_github → MCP_TOOL_CALL (Claude mcp_ prefix)", () => {
      const result = CliEventMapper.classifyTool("mcp_github");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
    });

    // ── Known tool with dot should NOT be MCP ────────────────────────────────

    test("web_search.v2 should NOT be MCP (known base tool name)", () => {
      // web_search is a known WEB_SEARCH tool, so web_search.v2 should NOT become MCP
      const result = CliEventMapper.classifyTool("web_search.v2");
      // The dot path won't trigger MCP because "web_search" is a known tool name
      // It falls through to the name-based sets (lowercased prefix check)
      assert.notStrictEqual(result.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
    });

    test("read_file.safe should NOT be MCP (known base tool name)", () => {
      const result = CliEventMapper.classifyTool("read_file.safe");
      assert.notStrictEqual(result.type, CLI_EVENT_TYPES.MCP_TOOL_CALL);
    });

    // ── TOOL_CALL fallback ────────────────────────────────────────────────────

    test("unknown_tool → TOOL_CALL (fallback)", () => {
      const result = CliEventMapper.classifyTool("unknown_tool");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.TOOL_CALL);
    });

    test("totally_unknown → TOOL_CALL (fallback)", () => {
      const result = CliEventMapper.classifyTool("totally_unknown");
      assert.strictEqual(result.type, CLI_EVENT_TYPES.TOOL_CALL);
    });
  });

  suite("isMcpToolCall", () => {
    test("returns true for MCP_TOOL_CALL classification", () => {
      const classification: ToolClassification = {
        type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
        server: "github",
        tool: "search",
      };
      assert.strictEqual(CliEventMapper.isMcpToolCall(classification), true);
    });

    test("returns false for BASH_COMMAND classification", () => {
      const classification: ToolClassification = {
        type: CLI_EVENT_TYPES.BASH_COMMAND,
      };
      assert.strictEqual(CliEventMapper.isMcpToolCall(classification), false);
    });

    test("returns false for FILE_READ classification", () => {
      const classification: ToolClassification = {
        type: CLI_EVENT_TYPES.FILE_READ,
      };
      assert.strictEqual(CliEventMapper.isMcpToolCall(classification), false);
    });

    test("returns false for TOOL_CALL (generic) classification", () => {
      const classification: ToolClassification = {
        type: CLI_EVENT_TYPES.TOOL_CALL,
      };
      assert.strictEqual(CliEventMapper.isMcpToolCall(classification), false);
    });

    test("classifyTool + isMcpToolCall integration: MCP format", () => {
      const classification = CliEventMapper.classifyTool(
        "github(search_repos)"
      );
      assert.strictEqual(CliEventMapper.isMcpToolCall(classification), true);
    });

    test("classifyTool + isMcpToolCall integration: non-MCP format", () => {
      const classification = CliEventMapper.classifyTool("bash");
      assert.strictEqual(CliEventMapper.isMcpToolCall(classification), false);
    });
  });
});
