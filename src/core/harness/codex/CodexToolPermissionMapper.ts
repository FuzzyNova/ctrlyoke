import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
  ToolPermissionApplication,
} from "../shared/interfaces/IToolPermissionMapper";
import type { PermissionCapabilityDescriptor } from "../../../types/CompatibilityTypes";
import { Log } from "../../../utils/Log";
import {
  HARNESS_IDS,
  PERMISSION_MODES,
} from "../../../types/DashboardConstants";

const CODEX_PERMISSION_VERIFICATION = {
  kind: "manual",
  reference: "dev/backlog/TOOL_PERMISSION_PARITY_PLAN.md#current-baseline",
  basis: "cli-version",
  verifiedVersions: ["0.146.0"],
} as const;

const CODEX_PERMISSION_CAPABILITIES: PermissionCapabilityDescriptor = {
  mode: {
    fidelity: "exact",
    mechanism: "native",
    verification: CODEX_PERMISSION_VERIFICATION,
  },
  allowedTools: {
    fidelity: "unsupported",
    mechanism: "none",
    verification: CODEX_PERMISSION_VERIFICATION,
  },
  deniedTools: {
    fidelity: "unsupported",
    mechanism: "none",
    verification: CODEX_PERMISSION_VERIFICATION,
  },
};

/**
 * Codex CLI Tool Permission Mapper
 *
 * Converts ctrlyoke's unified permission configuration into Codex CLI arguments.
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
  readonly capabilities = CODEX_PERMISSION_CAPABILITIES;

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
  async prepare(
    config: ToolPermissionConfig,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    return {
      cliArgs: this.buildCodexSpecificArgs(
        config,
        context.sandboxMode,
        context.approvalPolicy,
        context.isInteractive
      ),
      diagnostics: this.getToolTranslationDiagnostics(
        config,
        HARNESS_IDS.CODEX_CLI
      ),
    };
  }

  /**
   * Build Codex-specific permission arguments with sandbox/approval settings
   *
   * This is a Codex-specific method for advanced permission control.
   * Use this when you need fine-grained control over sandbox and approval.
   *
   * Note: --ask-for-approval / -a is an interactive-only flag. In headless exec mode
   * (`codex exec`) it is not a recognised argument and will cause an error. When
   * isInteractive is false (or undefined), approval-policy flags are omitted entirely
   * because `codex exec` controls approval through its sandbox mode alone.
   *
   * @param config Tool permission configuration
   * @param sandboxMode Codex sandbox mode ("read-only" | "workspace-write" | "danger-full-access")
   * @param approvalPolicy Codex approval policy ("untrusted" | "on-request" | "never")
   * @param isInteractive Whether running in interactive TUI mode (false → headless exec mode)
   * @returns CLI arguments array
   */
  buildCodexSpecificArgs(
    config: ToolPermissionConfig,
    sandboxMode?: string,
    approvalPolicy?: string,
    isInteractive?: boolean
  ): string[] {
    // Warn if tool patterns are configured (unsupported by Codex)
    if (config.allowedTools.length > 0 || config.deniedTools.length > 0) {
      Log.warn(
        "⚠️ Codex CLI does not support granular tool patterns (cliAllowedTools/cliDeniedTools). Use Codex-specific sandbox/approval settings for custom control."
      );
    }

    // --ask-for-approval / -a is an interactive-only flag: not recognised by `codex exec`.
    // Only suppress it when isInteractive is explicitly false (headless exec mode).
    // When undefined (e.g. tests that don't pass the flag), behave as before.
    const includeApprovalFlag = isInteractive !== false;

    switch (config.mode) {
      case PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL:
        // Bypass ALL checks (dangerous!)
        return ["--dangerously-bypass-approvals-and-sandbox"];

      case PERMISSION_MODES.ALLOW_ALL:
        // Auto preset: workspace-write sandbox + on-request approval.
        // --ask-for-approval is not a valid flag for `codex exec` (headless), so omit it.
        if (includeApprovalFlag) {
          return [...this.AUTO_PRESET_ARGS];
        }
        return ["--sandbox", "workspace-write"];

      case PERMISSION_MODES.CUSTOM:
        // Use Codex-specific sandbox and approval settings.
        // -a / --ask-for-approval is interactive-only; omit for headless exec.
        if (sandboxMode && approvalPolicy) {
          if (includeApprovalFlag) {
            return ["-s", sandboxMode, "-a", approvalPolicy];
          }
          return ["-s", sandboxMode];
        } else {
          Log.warn(
            "⚠️ Custom mode requires sandboxMode and approvalPolicy for Codex. Falling back to the Auto preset."
          );
          if (includeApprovalFlag) {
            return [...this.AUTO_PRESET_ARGS];
          }
          return ["--sandbox", "workspace-write"];
        }

      case PERMISSION_MODES.NONE:
        return [];

      default:
        if (includeApprovalFlag) {
          return [...this.AUTO_PRESET_ARGS];
        }
        return ["--sandbox", "workspace-write"];
    }
  }
}
