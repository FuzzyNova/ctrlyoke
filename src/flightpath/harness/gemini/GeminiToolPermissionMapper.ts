import {
  IToolPermissionMapper,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
} from "../shared/interfaces/IToolPermissionMapper";
import { PERMISSION_MODES } from "../../../types/DashboardConstants";

/**
 * Gemini CLI Tool Permission Mapper
 */
export class GeminiToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  buildArgs(config: ToolPermissionConfig): string[] {
    if (config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL) {
      return ["--approval-mode", "yolo"];
    }

    if (config.mode === PERMISSION_MODES.ALLOW_ALL) {
      return ["--approval-mode", "auto_edit"];
    }

    // Default or custom
    return ["--approval-mode", "default"];
  }

}
