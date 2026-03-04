import {
  IToolPermissionMapper,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
} from "../shared/interfaces/IToolPermissionMapper";
import { Log } from "../../../utils/Log";

/**
 * Codex CLI Tool Permission Mapper
 *
 * Converts FlightPath's unified permission configuration into Codex CLI arguments.
 *
 * Codex CLI uses mode-based permissions (no granular tool patterns):
 * - dangerouslyAllowAll → --dangerously-bypass-approvals-and-sandbox
 * - allowAll → --full-auto
 * - custom → --sandbox <mode> --approval <policy>
 *
 * Note: Codex does NOT support granular tool patterns like Copilot/Claude.
 * Tool permissions are controlled via sandbox modes and approval policies.
 *
 * Sandbox modes:
 * - "none": No restrictions
 * - "filesystem": Restrict filesystem access to workspace
 * - "network": Restrict network access
 *
 * Approval policies:
 * - "auto": Auto-approve all actions
 * - "interactive": Require user approval
 * - "deny": Deny all actions
 *
 * If allowedTools or deniedTools are configured, a warning is logged
 * since Codex doesn't support them.
 */
export class CodexToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
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
   * Check if full permissions are granted (no prompts will occur)
   *
   * Full permissions only with dangerouslyAllowAll mode.
   * allowAll mode still respects deny list (if Codex supported it).
   *
   * @param config Tool permission configuration
   * @returns True if all permissions auto-granted
   */
  hasFullPermissions(config: ToolPermissionConfig): boolean {
    return config.mode === "dangerouslyAllowAll";
  }

  /**
   * Build Codex-specific permission arguments with sandbox/approval settings
   *
   * This is a Codex-specific method for advanced permission control.
   * Use this when you need fine-grained control over sandbox and approval.
   *
   * @param config Tool permission configuration
   * @param sandboxMode Codex sandbox mode ("none" | "filesystem" | "network")
   * @param approvalPolicy Codex approval policy ("auto" | "interactive" | "deny")
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
      case "dangerouslyAllowAll":
        // Bypass ALL checks (dangerous!)
        return ["--dangerously-bypass-approvals-and-sandbox"];

      case "allowAll":
        // Safe automation: auto-grant all but respect deny list
        return ["--full-auto"];

      case "custom":
        // Use Codex-specific sandbox and approval settings
        // Note: --add-dir is handled elsewhere, not here
        if (sandboxMode && approvalPolicy) {
          return ["-s", sandboxMode, "-a", approvalPolicy];
        } else {
          Log.warn(
            "⚠️ Custom mode requires sandboxMode and approvalPolicy for Codex. Falling back to --full-auto."
          );
          return ["--full-auto"];
        }

      default:
        return ["--full-auto"];
    }
  }
}
