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
  INLINE_CONFIG_SUITE_REFERENCE,
  type PermissionCapabilityDescriptor,
} from "../../../types/CompatibilityTypes";
import {
  HARNESS_IDS,
  MCP_SERVER_IDS,
  PERMISSION_MODES,
} from "../../../types/DashboardConstants";
import { foldMcpToolDenialsIntoServers } from "../../../utils/ToolPermissionUtils";

const CODEX_PERMISSION_VERIFICATION = capabilitySuiteVerification([
  ">=0.129.0",
]);
const CODEX_AUTO_MODE_MIN_VERSION = ">=0.167.2";

export const CODEX_PERMISSION_CAPABILITIES: PermissionCapabilityDescriptor = {
  autoMode: {
    fidelity: "exact",
    mechanism: "native",
    autoModeMinimumVersion: CODEX_AUTO_MODE_MIN_VERSION,
    verification: capabilitySuiteVerification(
      [CODEX_AUTO_MODE_MIN_VERSION],
      INLINE_CONFIG_SUITE_REFERENCE
    ),
  },
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
 * Codex CLI Tool Permission Mapper
 *
 * Converts ctrlyoke's permission mode into Codex's approval flag. Containment
 * (`-s`) is a separate axis owned by `CodexSandboxMapper`.
 *
 * | Mode                | Interactive                 | Headless |
 * | ------------------- | --------------------------- | -------- |
 * | allowAll            | `-a on-request`             | `never` |
 * | dangerouslyAllowAll | `-a never`                  | `never` |
 * | custom              | `-a on-request`             | `never`, or `on-request` for headless `ask` |
 * | auto                | `-a on-request` + reviewer  | reviewer config |
 * | none / null         | nothing                     | `never` |
 *
 * The legacy `codex exec` path has no `-a` flag and defaults to `never`.
 * Headless app-server receives an equivalent `approval_policy` config override;
 * it can surface supported requests through ctrlyoke's shared approval policy.
 *
 * Codex does not expose ctrlyoke's general tool-pattern contract. Denied
 * `mcp__<server>__<tool>` patterns for servers the workflow attaches become
 * that server's `disabled_tools` (folded in by CodexHarnessAdapter); every other
 * pattern, including a bare `write` or `shell`, is reported as not enforced.
 */
export class CodexToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  readonly capabilities = CODEX_PERMISSION_CAPABILITIES;

  async prepare(
    config: ToolPermissionConfig,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    const fallback = await this.prepareAutoModeFallback(
      config,
      context,
      HARNESS_IDS.CODEX_CLI
    );
    if (fallback) return fallback;
    return {
      cliArgs: this.buildCodexSpecificArgs(config, context.isInteractive),
      // CodexHarnessAdapter folds MCP tool denials into the attached servers'
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
   * Codex's approval flag for a permission mode. `-a` is interactive-only;
   * it is omitted only when `isInteractive` is explicitly false (headless).
   */
  buildCodexSpecificArgs(
    config: ToolPermissionConfig,
    isInteractive?: boolean
  ): string[] {
    if (config.mode === PERMISSION_MODES.AUTO) {
      return isInteractive === false
        ? [
            "-c",
            "approvals_reviewer=auto_review",
            "-c",
            "approval_policy=on-request",
          ]
        : ["-a", "on-request", "-c", "approvals_reviewer=auto_review"];
    }
    if (isInteractive === false) return [];
    switch (config.mode) {
      case PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL:
        return ["-a", "never"];
      case PERMISSION_MODES.ALLOW_ALL:
      case PERMISSION_MODES.CUSTOM:
        return ["-a", "on-request"];
      default:
        return [];
    }
  }
}
