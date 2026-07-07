import {
  IToolPermissionMapper,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
} from "../shared/interfaces/IToolPermissionMapper";
import { PERMISSION_MODES } from "../../../types/DashboardConstants";

export class AntigravityToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
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
