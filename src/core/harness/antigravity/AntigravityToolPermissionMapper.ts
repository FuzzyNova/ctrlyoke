import {
  IToolPermissionMapper,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
} from "../shared/interfaces/IToolPermissionMapper";
import type { PermissionCapabilityDescriptor } from "../../../types/CompatibilityTypes";
import { PERMISSION_MODES } from "../../../types/DashboardConstants";

const ANTIGRAVITY_PERMISSION_VERIFICATION = {
  kind: "manual",
  reference: "dev/backlog/TOOL_PERMISSION_PARITY_PLAN.md#antigravity",
  basis: "cli-version",
  verifiedVersions: ["1.0.16"],
} as const;

const ANTIGRAVITY_PERMISSION_CAPABILITIES: PermissionCapabilityDescriptor = {
  mode: {
    fidelity: "exact",
    mechanism: "native",
    verification: ANTIGRAVITY_PERMISSION_VERIFICATION,
  },
  allowedTools: {
    fidelity: "unsupported",
    mechanism: "none",
    verification: ANTIGRAVITY_PERMISSION_VERIFICATION,
  },
  deniedTools: {
    fidelity: "unsupported",
    mechanism: "none",
    verification: ANTIGRAVITY_PERMISSION_VERIFICATION,
  },
};

export class AntigravityToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  readonly capabilities = ANTIGRAVITY_PERMISSION_CAPABILITIES;

  buildArgs(config: ToolPermissionConfig): string[] {
    switch (config.mode) {
      case PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL:
      case PERMISSION_MODES.ALLOW_ALL:
        return ["--dangerously-skip-permissions"];
      case PERMISSION_MODES.CUSTOM:
        return ["--sandbox"];
      case PERMISSION_MODES.NONE:
      default:
        return [];
    }
  }

  override hasFullPermissions(config: ToolPermissionConfig): boolean {
    return (
      config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL ||
      config.mode === PERMISSION_MODES.ALLOW_ALL
    );
  }
}
