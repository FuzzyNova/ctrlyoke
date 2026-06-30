import {
  IToolPermissionMapper,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
} from "../shared/interfaces/IToolPermissionMapper";
import { Log } from "../../../utils/Log";
import { PERMISSION_MODES } from "../../../types/DashboardConstants";

/**
 * OpenCode CLI Tool Permission Mapper
 *
 * OpenCode uses config-file-driven permissions, not CLI flags.
 * Default behavior: all operations are allowed without approval.
 *
 * Permission overrides (for 'custom' mode) are written to opencode.json
 * as a side effect of getMcpConfigArgs() in OpenCodeCliProvider — not via
 * CLI arguments returned here.
 *
 * For dangerouslyAllowAll and allowAll modes: return [] (default allows all).
 * For custom mode: return [] (permission config is in opencode.json file).
 */
export class OpenCodeToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  /**
   * Build CLI arguments for tool permissions.
   *
   * OpenCode has no CLI flags for tool permissions — always returns empty array.
   * Permission config is written to opencode.json project config file instead.
   *
   * @param config Tool permission configuration
   * @returns Empty array (no CLI arguments needed)
   */
  buildArgs(config: ToolPermissionConfig): string[] {
    if (
      config.mode === PERMISSION_MODES.CUSTOM &&
      (config.allowedTools.length > 0 || config.deniedTools.length > 0)
    ) {
      Log.debug(
        "OpenCode: custom tool permissions are config-file driven, not via CLI flags"
      );
    }
    return [];
  }

  /**
   * OpenCode does not currently expose an interactive permission mode through
   * ctrlyoke, so headless execution should not warn for limited permissions.
   */
  hasFullPermissions(_config: ToolPermissionConfig): boolean {
    return true;
  }
}
