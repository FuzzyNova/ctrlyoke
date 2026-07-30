import {
  IToolPermissionMapper,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
} from "../shared/interfaces/IToolPermissionMapper";
import { Log } from "../../../utils/Log";
import { PERMISSION_MODES } from "../../../types/DashboardConstants";
import type {
  SettingsJsonPermissionDecision,
  SettingsJsonPermissionPolicy,
} from "../shared/SettingsJsonMcpTracker";

const OPENCODE_TOOL_ALIASES: Readonly<Record<string, string>> = {
  shell: "bash",
  bash: "bash",
  run_shell_command: "bash",
  write: "edit",
  create: "edit",
  edit: "edit",
  multiedit: "edit",
  multi_edit: "edit",
  patch: "edit",
  str_replace: "edit",
  read: "read",
  glob: "glob",
  ls: "glob",
  list: "glob",
  list_directory: "glob",
  grep: "grep",
  task: "task",
  agent: "task",
  skill: "skill",
  lsp: "lsp",
  question: "question",
  webfetch: "webfetch",
  web_fetch: "webfetch",
  websearch: "websearch",
  web_search: "websearch",
};

/**
 * OpenCode CLI Tool Permission Mapper
 *
 * OpenCode uses config-file-driven permissions, not CLI flags.
 * Default behavior: all operations are allowed without approval.
 *
 * Permission overrides are translated here and written to the workspace-root
 * opencode.json by OpenCodeCliProvider through the shared config tracker.
 *
 * - dangerouslyAllowAll / none: no ctrlyoke permission block
 * - allowAll: `"*": "allow"` plus deny overrides
 * - custom: `"*": "ask"` plus allow overrides, then deny overrides
 */
export class OpenCodeToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  /**
   * Build CLI arguments for tool permissions.
   *
   * OpenCode has no CLI flags for tool permissions — always returns empty array.
   * Permission config is written to opencode.json project config file instead.
   *
   * @param config Tool permission configuration
   * @returns Empty array (no CLI arguments needed)
   */
  buildArgs(config: ToolPermissionConfig): string[] {
    if (
      config.mode === PERMISSION_MODES.CUSTOM &&
      (config.allowedTools.length > 0 || config.deniedTools.length > 0)
    ) {
      Log.debug(
        "OpenCode: custom tool permissions are config-file driven, not via CLI flags"
      );
    }
    return [];
  }

  /**
   * Build the OpenCode `permission` block owned by ctrlyoke for this run.
   *
   * OpenCode evaluates matching patterns in insertion order with the final
   * match winning, so allow rules are inserted before deny rules. A bare tool
   * rule becomes the nested `"*"` rule when granular rules for the same tool
   * are also present.
   */
  buildPermissionPolicy(
    config: ToolPermissionConfig
  ): SettingsJsonPermissionPolicy | undefined {
    if (
      config.mode === PERMISSION_MODES.NONE ||
      config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL
    ) {
      return undefined;
    }

    const policy: SettingsJsonPermissionPolicy = {
      "*": config.mode === PERMISSION_MODES.ALLOW_ALL ? "allow" : "ask",
    };

    if (config.mode === PERMISSION_MODES.CUSTOM) {
      this.appendRules(policy, config.allowedTools, "allow");
    }
    this.appendRules(policy, config.deniedTools, "deny");
    return policy;
  }

  private appendRules(
    policy: SettingsJsonPermissionPolicy,
    patterns: string[],
    decision: SettingsJsonPermissionDecision
  ): void {
    for (const sourcePattern of patterns) {
      const parsed = this.parsePattern(sourcePattern);
      if (!parsed) {
        Log.warn(
          `[OpenCodePermissionMapper] Invalid tool pattern: ${sourcePattern}, skipping`
        );
        continue;
      }

      const [sourceTool, sourceArgs] = parsed;
      const tool =
        OPENCODE_TOOL_ALIASES[sourceTool.toLowerCase()] ?? sourceTool;
      const argumentPattern = this.convertArgumentPattern(tool, sourceArgs);
      this.appendRule(policy, tool, argumentPattern, decision);
    }
  }

  private appendRule(
    policy: SettingsJsonPermissionPolicy,
    tool: string,
    argumentPattern: string | undefined,
    decision: SettingsJsonPermissionDecision
  ): void {
    const current = policy[tool];

    if (argumentPattern === undefined) {
      if (current && typeof current === "object") {
        delete current["*"];
        current["*"] = decision;
      } else {
        delete policy[tool];
        policy[tool] = decision;
      }
      return;
    }

    const rules: Record<string, SettingsJsonPermissionDecision> =
      current && typeof current === "object"
        ? current
        : current
          ? { "*": current }
          : {};
    delete rules[argumentPattern];
    rules[argumentPattern] = decision;
    delete policy[tool];
    policy[tool] = rules;
  }

  private convertArgumentPattern(
    tool: string,
    sourceArgs: string
  ): string | undefined {
    if (!sourceArgs) {
      return undefined;
    }

    const inner = sourceArgs.slice(1, -1);
    if (!inner || inner === "*" || inner === "*:*") {
      return undefined;
    }
    if (tool !== "bash") {
      return inner;
    }

    const separator = inner.indexOf(":");
    if (separator === -1) {
      return inner;
    }
    const command = inner.slice(0, separator).trim();
    const argumentsPattern = inner.slice(separator + 1).trim();
    return argumentsPattern ? `${command} ${argumentsPattern}` : command;
  }
}
