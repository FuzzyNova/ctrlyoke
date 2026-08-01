import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
  ToolPermissionApplication,
} from "../shared/interfaces/IToolPermissionMapper";
import {
  PERMISSION_CAVEAT_CODES,
  type PermissionCapabilityDescriptor,
} from "../../../types/CompatibilityTypes";
import {
  HARNESS_IDS,
  PERMISSION_MODES,
} from "../../../types/DashboardConstants";

const ANTIGRAVITY_PERMISSION_VERIFICATION = {
  kind: "manual",
  reference: "dev/backlog/TOOL_PERMISSION_PARITY_PLAN.md#antigravity",
  basis: "cli-version",
  verifiedVersions: ["1.0.16"],
} as const;

export const ANTIGRAVITY_PERMISSION_CAPABILITIES: PermissionCapabilityDescriptor = {
  mode: {
    fidelity: "exact",
    mechanism: "native",
    verification: ANTIGRAVITY_PERMISSION_VERIFICATION,
  },
  allowedTools: {
    fidelity: "unsupported",
    mechanism: "none",
    verification: ANTIGRAVITY_PERMISSION_VERIFICATION,
    caveatCode: PERMISSION_CAVEAT_CODES.COARSE_PERMISSION_MODES,
  },
  deniedTools: {
    fidelity: "unsupported",
    mechanism: "none",
    verification: ANTIGRAVITY_PERMISSION_VERIFICATION,
    caveatCode: PERMISSION_CAVEAT_CODES.COARSE_PERMISSION_MODES,
  },
};

export class AntigravityToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  readonly capabilities = ANTIGRAVITY_PERMISSION_CAPABILITIES;

  async prepare(
    config: ToolPermissionConfig,
    _context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    let cliArgs: string[];
    switch (config.mode) {
      case PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL:
      case PERMISSION_MODES.ALLOW_ALL:
        cliArgs = ["--dangerously-skip-permissions"];
        break;
      case PERMISSION_MODES.CUSTOM:
        cliArgs = ["--sandbox"];
        break;
      case PERMISSION_MODES.NONE:
      default:
        cliArgs = [];
        break;
    }
    return {
      cliArgs,
      diagnostics: this.getToolTranslationDiagnostics(
        config,
        HARNESS_IDS.ANTIGRAVITY_CLI
      ),
    };
  }

  override hasFullPermissions(config: ToolPermissionConfig): boolean {
    return (
      config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL ||
      config.mode === PERMISSION_MODES.ALLOW_ALL
    );
  }
}
