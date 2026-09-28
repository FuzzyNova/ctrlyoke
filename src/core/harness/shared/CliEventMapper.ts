import { CLI_EVENT_TYPES } from "../../../types/DashboardConstants";

/**
 * Semantic event type classification result
 *
 * Returned by `classifyTool()` to indicate which CLI_EVENT_TYPE a tool name maps to.
 */
export type ToolClassification =
  | { type: typeof CLI_EVENT_TYPES.BASH_COMMAND }
  | { type: typeof CLI_EVENT_TYPES.FILE_READ }
  | { type: typeof CLI_EVENT_TYPES.FILE_WRITE }
  | { type: typeof CLI_EVENT_TYPES.FILE_EDIT }
  | { type: typeof CLI_EVENT_TYPES.FILE_DELETE }
  | { type: typeof CLI_EVENT_TYPES.WEB_SEARCH }
  | { type: typeof CLI_EVENT_TYPES.MCP_TOOL_CALL; server: string; tool: string }
  | { type: typeof CLI_EVENT_TYPES.TOOL_CALL };

/**
 * Shared CLI Event Mapper — single source of truth for tool name → semantic event classification
 *
 * All CLI harnesses (Copilot, Claude, Codex) map tool names to semantic event types
 * using the same categories (BASH_COMMAND, FILE_READ, FILE_WRITE, etc.). This utility
 * centralizes that classification to avoid ~500 lines of duplicated switch/if-else chains
 * across CopilotLogParser, ClaudeLogParser, and CodexLogParser.
 *
 * **Harness-specific tool name variations handled:**
 * - Bash/shell: `bash`, `shell`, `powershell`, `command`, `execute_command`, `run_command`, `shell_command`
 * - File read: `read`, `read_file`, `view` (native harness read tools only; `cat`, `ls`, etc. are shell commands → TOOL_CALL)
 * - File write: `write`, `write_file`, `create`, `create_file`
 * - File edit: `edit`, `edit_file`, `modify_file`, `replace_string_in_file`, `multiedit`, `apply_patch`
 * - File delete: `delete`, `delete_file`, `remove_file` (`rm` is a shell command → TOOL_CALL)
 * - Web search: `web_search`, `search`, `webfetch`
 * - MCP tools: `server(tool)` (Copilot), `server.tool` / `mcp_*` (Claude), `server__tool` (Codex)
 *
 * @example
 * ```typescript
 * const classification = CliEventMapper.classifyTool("bash");
 * // { type: "BASH_COMMAND" }
 *
 * const mcpClassification = CliEventMapper.classifyTool("github(search_repos)");
 * // { type: "MCP_TOOL_CALL", server: "github", tool: "search_repos" }
 * ```
 */
export class CliEventMapper {
  // ========================================================================
  // Tool Name Sets (case-insensitive matching via lowercased lookup)
  // ========================================================================

  /** Tool names that map to BASH_COMMAND */
  private static readonly BASH_TOOLS = new Set([
    "bash",
    "shell",
    "powershell",
    "command",
    "execute_command",
    "run_command",
    "shell_command",
    "run_shell_command",
  ]);

  /** Tool names that map to FILE_READ (native harness built-in read tools only) */
  private static readonly FILE_READ_TOOLS = new Set([
    "read",
    "read_file",
    "view",
  ]);

  /** Tool names that map to FILE_WRITE */
  private static readonly FILE_WRITE_TOOLS = new Set([
    "write",
    "write_file",
    "create",
    "create_file",
  ]);

  /** Tool names that map to FILE_EDIT */
  private static readonly FILE_EDIT_TOOLS = new Set([
    "edit",
    "edit_file",
    "modify_file",
    "replace_string_in_file",
    "multiedit",
    "apply_patch",
    "replace",
  ]);

  /** Tool names that map to FILE_DELETE (native harness built-in delete tools only) */
  private static readonly FILE_DELETE_TOOLS = new Set([
    "delete",
    "delete_file",
    "remove_file",
  ]);

  /** Tool names that map to WEB_SEARCH */
  private static readonly WEB_SEARCH_TOOLS = new Set([
    "web_search",
    "search",
    "webfetch",
    "google_web_search",
    "web_fetch",
  ]);

  /**
   * Classify a tool name into a semantic event type
   *
   * Maps any CLI tool name to the appropriate CLI_EVENT_TYPE. This is the
   * single source of truth for the tool-name-to-event-type mapping that was
   * previously duplicated across 6+ locations.
   *
   * @param toolName - The tool name from the CLI event (case-insensitive)
   * @returns ToolClassification with the semantic event type
   *
   * @remarks
   * **MCP Detection Priority:**
   * MCP tools are detected by format patterns BEFORE name-based classification:
   * - Copilot format: `server(tool)` — parenthesized
   * - Codex format: `server__tool` — double underscore
   * - Claude format: `server.tool` — dot separator (only if not a known tool name)
   * - Claude format: `mcp_*` prefix
   *
   * This ensures MCP tools with names like "search" aren't misclassified as WEB_SEARCH.
   */
  static classifyTool(toolName: string): ToolClassification {
    // 1. Check MCP tool patterns FIRST (before lowercasing, preserves server/tool names)
    const mcpResult = this.classifyMcpTool(toolName);
    if (mcpResult) {
      return mcpResult;
    }

    // 2. Lowercase for case-insensitive name matching
    const lowerName = toolName.toLowerCase();

    // 3. Classify by tool name sets
    if (this.BASH_TOOLS.has(lowerName)) {
      return { type: CLI_EVENT_TYPES.BASH_COMMAND };
    }

    if (this.FILE_READ_TOOLS.has(lowerName)) {
      return { type: CLI_EVENT_TYPES.FILE_READ };
    }

    if (this.FILE_WRITE_TOOLS.has(lowerName)) {
      return { type: CLI_EVENT_TYPES.FILE_WRITE };
    }

    if (this.FILE_EDIT_TOOLS.has(lowerName)) {
      return { type: CLI_EVENT_TYPES.FILE_EDIT };
    }

    if (this.FILE_DELETE_TOOLS.has(lowerName)) {
      return { type: CLI_EVENT_TYPES.FILE_DELETE };
    }

    if (this.WEB_SEARCH_TOOLS.has(lowerName)) {
      return { type: CLI_EVENT_TYPES.WEB_SEARCH };
    }

    // 4. Fallback: generic TOOL_CALL
    return { type: CLI_EVENT_TYPES.TOOL_CALL };
  }

  /**
   * Check if a tool name represents an MCP tool call
   *
   * Detects MCP tool patterns across all harness formats:
   * - Copilot: `server(tool)` — e.g., `github(search_repositories)`
   * - Codex: `server__tool` — e.g., `mcp_github__search`
   * - Claude: `server.tool` or `mcp_*` prefix — e.g., `github.search` or `mcp_github`
   *
   * @param toolName - Original tool name (case-sensitive for server/tool extraction)
   * @returns MCP classification with server and tool names, or null if not MCP
   */
  private static classifyMcpTool(toolName: string): ToolClassification | null {
    // Copilot format: "server(tool)"
    const parenMatch = toolName.match(/^([^(]+)\(([^)]+)\)$/);
    if (parenMatch) {
      return {
        type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
        server: parenMatch[1],
        tool: parenMatch[2],
      };
    }

    // Standard "mcp__<server>__<tool>" format (Claude Code's convention, also
    // used for ctrlyoke's own MCP server and Codex's exec-unwrapped calls).
    // Must be checked before the generic "__" branch below: splitting
    // "mcp__ctrlyoke__append_queue" on the *first* "__" would wrongly extract
    // server="mcp", tool="ctrlyoke__append_queue".
    if (toolName.startsWith("mcp__")) {
      const rest = toolName.slice(5);
      const sepIdx = rest.indexOf("__");
      if (sepIdx > 0) {
        return {
          type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
          server: rest.slice(0, sepIdx) || "unknown",
          tool: rest.slice(sepIdx + 2) || "unknown",
        };
      }
      return {
        type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
        server: "unknown",
        tool: rest || toolName,
      };
    }

    // Codex format: "server__tool" (double underscore)
    if (toolName.includes("__")) {
      const [server, tool] = toolName.split("__", 2);
      return {
        type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
        server: server || "unknown",
        tool: tool || "unknown",
      };
    }

    // Claude format: "mcp_*" prefix
    if (
      toolName.startsWith("mcp_") ||
      toolName.toLowerCase().startsWith("mcp_")
    ) {
      return {
        type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
        server: "unknown",
        tool: toolName,
      };
    }

    // Claude format: "server.tool" (dot separator)
    // Only classify as MCP if the name contains a dot AND is not a known tool
    if (toolName.includes(".") && !this.isKnownToolName(toolName)) {
      const [server, tool] = toolName.split(".", 2);
      return {
        type: CLI_EVENT_TYPES.MCP_TOOL_CALL,
        server: server || "unknown",
        tool: tool || "unknown",
      };
    }

    return null;
  }

  /**
   * Check if a tool name (with dots) is a known non-MCP tool
   *
   * Prevents misclassifying tools like "web_search.v2" as MCP tools.
   */
  private static isKnownToolName(toolName: string): boolean {
    const lowerName = toolName.toLowerCase().split(".")[0];
    return (
      this.BASH_TOOLS.has(lowerName) ||
      this.FILE_READ_TOOLS.has(lowerName) ||
      this.FILE_WRITE_TOOLS.has(lowerName) ||
      this.FILE_EDIT_TOOLS.has(lowerName) ||
      this.FILE_DELETE_TOOLS.has(lowerName) ||
      this.WEB_SEARCH_TOOLS.has(lowerName)
    );
  }
}
