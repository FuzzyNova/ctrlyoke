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
    if (config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      return ["--dangerously-skip-permissions"];
    }

    return [];
  }

  override hasFullPermissions(config: ToolPermissionConfig): boolean {
    return (
      config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL ||
      config.mode === PERMISSION_MODES.ALLOW_ALL
    );
  }
}
