import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
  ToolPermissionApplication,
} from "../shared/interfaces/IToolPermissionMapper";
import {
  PERMISSION_CAVEAT_CODES,
  capabilitySuiteVerification,
  type PermissionCapabilityDescriptor,
} from "../../../types/CompatibilityTypes";
import { Log } from "../../../utils/Log";
import {
  HARNESS_IDS,
  MCP_SERVER_IDS,
  PERMISSION_MODES,
} from "../../../types/DashboardConstants";
import { foldMcpToolDenialsIntoServers } from "../../../types/ToolPermissionUtils";
import { compareVersions } from "../../../utils/CtrlyokeInstallations";

const CODEX_PERMISSION_VERIFICATION = capabilitySuiteVerification([
  ">=0.129.0",
]);

export const CODEX_PERMISSION_CAPABILITIES: PermissionCapabilityDescriptor = {
  mode: {
    fidelity: "exact",
    mechanism: "native",
    verification: CODEX_PERMISSION_VERIFICATION,
  },
  allowedTools: {
    fidelity: "unsupported",
    mechanism: "none",
    verification: CODEX_PERMISSION_VERIFICATION,
    caveatCode: PERMISSION_CAVEAT_CODES.SANDBOX_APPROVAL_MODES,
  },
  deniedTools: {
    fidelity: "partial",
    mechanism: "native",
    verification: CODEX_PERMISSION_VERIFICATION,
    caveatCode: PERMISSION_CAVEAT_CODES.MCP_TOOL_DENIALS_ONLY,
  },
};

/**
 * Servers whose `mcp__<server>__<tool>` denials are not folded into Codex
 * `disabled_tools`: the ctrlyoke server enforces its own denials.
 */
export const CODEX_FOLD_EXCLUDED_SERVER_IDS: ReadonlySet<string> = new Set([
  MCP_SERVER_IDS.CTRLYOKE,
]);

/**
 * Bare tool names whose denial Codex can only express as a read-only sandbox.
 * A scoped pattern such as `shell(rm:*)` does not count: Codex cannot narrow
 * a sandbox to one command, and clamping the whole run for it would be broader
 * than the user asked for.
 */
const CODEX_WRITE_CAPABLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "write",
  "edit",
  "multiedit",
  "shell",
]);

const CODEX_UNTRUSTED_APPROVAL_REMOVED_VERSION = "0.149.0";

function deniesWriteCapableTool(config: ToolPermissionConfig): boolean {
  return config.deniedTools.some((tool) =>
    CODEX_WRITE_CAPABLE_TOOL_NAMES.has(tool.trim().toLowerCase())
  );
}

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
 * Note: Codex does not expose ctrlyoke's general tool-pattern contract.
 * Denied `mcp__<server>__<tool>` patterns for servers the workflow attaches
 * become that server's `disabled_tools` (folded in by CodexCliProvider).
 * Codex command rules and permission profiles load only from config files,
 * so other patterns are not enforced.
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
 * If allowedTools or deniedTools are configured, the shared compatibility
 * diagnostics report that Codex does not enforce them.
 */
export class CodexToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  readonly capabilities = CODEX_PERMISSION_CAPABILITIES;

  /**
   * Resolve the sandbox once for both permission args and --add-dir handling.
   * Codex rejects extra writable roots in a read-only sandbox.
   */
  static resolveSandboxMode(
    config: ToolPermissionConfig,
    sandboxMode?: string
  ): string | undefined {
    switch (config.mode) {
      case PERMISSION_MODES.CUSTOM:
        return deniesWriteCapableTool(config) ? "read-only" : sandboxMode;
      case PERMISSION_MODES.ALLOW_ALL:
        return "workspace-write";
      case PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL:
        return "danger-full-access";
      default:
        return undefined;
    }
  }

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
        context.isInteractive,
        context.cliVersion
      ),
      // CodexCliProvider folds MCP tool denials into the attached servers'
      // `disabled_tools`; only the rest of the deny list goes unenforced.
      diagnostics: this.getToolTranslationDiagnostics(
        {
          ...config,
          deniedTools: [
            ...foldMcpToolDenialsIntoServers(
              config,
              context.mcpServers,
              CODEX_FOLD_EXCLUDED_SERVER_IDS
            ).unfolded,
          ],
        },
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
    isInteractive?: boolean,
    cliVersion?: string
  ): string[] {
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
        // Codex cannot enforce ctrlyoke's per-tool patterns. A config that
        // denies a whole write-capable tool can only be honoured by the
        // read-only sandbox, so fail closed instead of inheriting the user's
        // broader Codex sandbox setting.
        const resolvedSandboxMode = CodexToolPermissionMapper.resolveSandboxMode(
          config,
          sandboxMode
        );
        if (deniesWriteCapableTool(config)) {
          return ["--sandbox", resolvedSandboxMode ?? "read-only"];
        }
        // Otherwise use Codex-specific sandbox and approval settings.
        // -a / --ask-for-approval is interactive-only; omit for headless exec.
        if (resolvedSandboxMode && approvalPolicy) {
          // Codex 0.149.0 removed `untrusted`; retain its original behavior on
          // supported older CLIs and map it to the nearest current policy after.
          const resolvedApprovalPolicy =
            approvalPolicy === "untrusted" &&
            (!cliVersion ||
              compareVersions(
                cliVersion,
                CODEX_UNTRUSTED_APPROVAL_REMOVED_VERSION
              ) >= 0)
              ? "on-request"
              : approvalPolicy;
          if (includeApprovalFlag) {
            return ["-s", resolvedSandboxMode, "-a", resolvedApprovalPolicy];
          }
          return ["-s", resolvedSandboxMode];
        }
        Log.warn(
          "[CodexToolPermissionMapper] Custom mode requires sandboxMode and approvalPolicy for Codex. Falling back to the Auto preset."
        );
        if (includeApprovalFlag) {
          return [...this.AUTO_PRESET_ARGS];
        }
        return ["--sandbox", "workspace-write"];

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
