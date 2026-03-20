import {
  IToolPermissionMapper,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
} from "../shared/interfaces/IToolPermissionMapper";

/**
 * Gemini CLI Tool Permission Mapper
 */
export class GeminiToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  buildArgs(config: ToolPermissionConfig): string[] {
    if (config.mode === "dangerouslyAllowAll") {
      return ["--approval-mode", "yolo"];
    }

    if (config.mode === "allowAll") {
      return ["--approval-mode", "auto_edit"];
    }

    // Default or custom
    return ["--approval-mode", "default"];
  }

  hasFullPermissions(config: ToolPermissionConfig): boolean {
    return config.mode === "dangerouslyAllowAll";
  }
}
