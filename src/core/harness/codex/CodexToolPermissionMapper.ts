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
import {
  HARNESS_IDS,
  MCP_SERVER_IDS,
  PERMISSION_MODES,
} from "../../../types/DashboardConstants";
import { foldMcpToolDenialsIntoServers } from "../../../utils/ToolPermissionUtils";

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
 * Codex CLI Tool Permission Mapper
 *
 * Converts ctrlyoke's permission mode into Codex's approval flag. Containment
 * (`-s`) is a separate axis owned by `CodexSandboxMapper`.
 *
 * | Mode                | Interactive     | Headless (`codex exec`) |
 * | ------------------- | --------------- | ----------------------- |
 * | allowAll            | `-a on-request` | nothing                 |
 * | dangerouslyAllowAll | `-a never`      | nothing                 |
 * | custom              | `-a on-request` | nothing                 |
 * | none / null         | nothing         | nothing                 |
 *
 * `codex exec` has no `-a` flag and never asks for approval, so headless
 * Codex is governed by its sandbox alone.
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
