import {
  IToolPermissionMapper,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
} from "../shared/interfaces/IToolPermissionMapper";
import { Log } from "../../../utils/Log";
import { PERMISSION_MODES } from "../../../types/DashboardConstants";

/**
 * Codex CLI Tool Permission Mapper
 *
 * Converts FlightPath's unified permission configuration into Codex CLI arguments.
 *
 * Codex CLI uses mode-based permissions (no granular tool patterns):
 * - dangerouslyAllowAll → --dangerously-bypass-approvals-and-sandbox
 * - allowAll → Auto preset (= workspace-write sandbox + on-request approval)
 * - custom → -s <sandboxMode> -a <approvalPolicy>
 *
 * Note: Codex does NOT support granular tool patterns like Copilot/Claude.
 * Tool permissions are controlled via sandbox modes and approval policies.
 *
 * Sandbox modes (-s / --sandbox):
 * - "read-only": Read-only filesystem access
 * - "workspace-write": Read + write within workspace (Auto preset)
 * - "danger-full-access": Unrestricted filesystem access (dangerous)
 *
 * Approval policies (-a / --ask-for-approval):
 * - "untrusted": Only run trusted read commands without asking; escalate others
 * - "on-request": Model decides when to ask (Auto preset)
 * - "never": Never ask for approval (dangerous)
 *
 * If allowedTools or deniedTools are configured, a warning is logged
 * since Codex doesn't support them.
 */
export class CodexToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  private readonly AUTO_PRESET_ARGS = [
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "on-request",
  ];

  /**
   * Build CLI arguments for tool permissions
   *
   * Delegates to buildCodexSpecificArgs with no sandbox/approval overrides.
   *
   * @param config Tool permission configuration
   * @returns CLI arguments array
   */
  buildArgs(config: ToolPermissionConfig): string[] {
    return this.buildCodexSpecificArgs(config);
  }

  /**
   * Build Codex-specific permission arguments with sandbox/approval settings
   *
   * This is a Codex-specific method for advanced permission control.
   * Use this when you need fine-grained control over sandbox and approval.
   *
   * @param config Tool permission configuration
   * @param sandboxMode Codex sandbox mode ("read-only" | "workspace-write" | "danger-full-access")
   * @param approvalPolicy Codex approval policy ("untrusted" | "on-request" | "never")
   * @returns CLI arguments array
   */
  buildCodexSpecificArgs(
    config: ToolPermissionConfig,
    sandboxMode?: string,
    approvalPolicy?: string
  ): string[] {
    // Warn if tool patterns are configured (unsupported by Codex)
    if (config.allowedTools.length > 0 || config.deniedTools.length > 0) {
      Log.warn(
        "⚠️ Codex CLI does not support granular tool patterns (cliAllowedTools/cliDeniedTools). Use Codex-specific sandbox/approval settings for custom control."
      );
    }

    switch (config.mode) {
      case PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL:
        // Bypass ALL checks (dangerous!)
        return ["--dangerously-bypass-approvals-and-sandbox"];

      case PERMISSION_MODES.ALLOW_ALL:
        // Use the explicit Auto preset flags instead of deprecated --full-auto.
        return [...this.AUTO_PRESET_ARGS];

      case PERMISSION_MODES.CUSTOM:
        // Use Codex-specific sandbox and approval settings
        // Note: --add-dir is handled elsewhere, not here
        if (sandboxMode && approvalPolicy) {
          return ["-s", sandboxMode, "-a", approvalPolicy];
        } else {
          Log.warn(
            "⚠️ Custom mode requires sandboxMode and approvalPolicy for Codex. Falling back to the Auto preset."
          );
          return [...this.AUTO_PRESET_ARGS];
        }

      case PERMISSION_MODES.NONE:
        return [];

      default:
        return [...this.AUTO_PRESET_ARGS];
    }
  }
}
