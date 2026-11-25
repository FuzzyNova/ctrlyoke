import { MESSAGE_TYPES } from "../types/DashboardConstants";
import type {
  CommunityTemplateEntry,
  InstallCommunityTemplateMessage,
  RequestCommunityTemplateIndexMessage,
  SettingWriteScope,
  UninstallCommunityTemplateMessage,
} from "../types/WebviewMessageTypes";
import {
  buildCustomTemplateId,
  getCommunityInstallFileName,
  type WorkflowFileFormat,
} from "../types/DashboardConstants";
import {
  CommunityTemplateClient,
  getCommunityTemplateFormat,
} from "../utils/CommunityTemplateClient";
import { getErrorMessage } from "../utils/ErrorUtils";
import { Log } from "../utils/Log";
import type { DashboardClientContext } from "./DashboardClientContext";

/** What the service needs from the template library to install and uninstall. */
export interface CommunityTemplateInstaller {
  installTemplateContent(
    templateName: string,
    scope: SettingWriteScope,
    format: WorkflowFileFormat,
    content: string,
    communityInstallFile: string
  ): Promise<{ path: string; templateId: string }>;
  /** Delete an installed template from one scope; returns the deleted path. */
  uninstallTemplate(
    templateName: string,
    scope: SettingWriteScope
  ): Promise<string>;
  /** Clear a template's saved variable values and send refreshed settings. */
  clearSavedValues(
    templateId: string,
    ctx: DashboardClientContext
  ): Promise<void>;
  /** Send the client the refreshed template catalog after an install. */
  refreshTemplateCatalog(ctx: DashboardClientContext): Promise<void>;
}

/**
 * Community template handlers for Settings → Templates: list the library's
 * `index.json`, install one template into a custom-template scope, and
 * uninstall it again. The index is kept for the session once read; errors are not, so a
 * retry downloads again.
 */
export class CommunityTemplateService {
  private index: Promise<CommunityTemplateEntry[]> | undefined;

  constructor(
    private readonly installer: CommunityTemplateInstaller,
    private readonly client: CommunityTemplateClient = new CommunityTemplateClient()
  ) {}

  private getIndex(refresh = false): Promise<CommunityTemplateEntry[]> {
    if (refresh || !this.index) {
      const request = this.client.fetchIndex();
      this.index = request;
      request.catch(() => {
        if (this.index === request) this.index = undefined;
      });
    }
    return this.index;
  }

  async handleRequestIndex(
    ctx: DashboardClientContext,
    message: RequestCommunityTemplateIndexMessage
  ): Promise<void> {
    try {
      const templates = await this.getIndex(message.refresh === true);
      ctx.emit({
        type: MESSAGE_TYPES.COMMUNITY_TEMPLATE_INDEX_RESULT,
        templates,
      });
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.warn("[CommunityTemplates] index fetch failed:", msg);
      ctx.emit({
        type: MESSAGE_TYPES.COMMUNITY_TEMPLATE_INDEX_RESULT,
        templates: [],
        error: msg,
      });
    }
  }

  async handleInstall(
    ctx: DashboardClientContext,
    message: InstallCommunityTemplateMessage
  ): Promise<void> {
    const { id, scope } = message;
    try {
      // Only an id the index lists can be installed, so the webview can never
      // name an arbitrary file to download.
      const entry = (await this.getIndex()).find(
        (candidate) => candidate.id === id
      );
      if (!entry) {
        throw new Error(
          `"${id}" is not in the community template index; refresh the list and try again`
        );
      }
      const format = getCommunityTemplateFormat(entry.id, entry.file);
      if (!format) {
        throw new Error(`The community template "${id}" names an invalid file`);
      }
      const content = await this.client.fetchTemplate(entry);
      const installed = await this.installer.installTemplateContent(
        entry.id,
        scope,
        format,
        content,
        getCommunityInstallFileName(entry.id, entry.file)
      );
      Log.info(
        `[CommunityTemplates] installed "${entry.id}" to ${installed.path}`
      );
      ctx.emit({
        type: MESSAGE_TYPES.COMMUNITY_TEMPLATE_INSTALL_RESULT,
        id,
        scope,
        success: true,
        localTemplateId: installed.templateId,
      });
      await this.installer.refreshTemplateCatalog(ctx);
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.warn(`[CommunityTemplates] installing "${id}" failed:`, msg);
      ctx.emit({
        type: MESSAGE_TYPES.COMMUNITY_TEMPLATE_INSTALL_RESULT,
        id,
        scope,
        success: false,
        error: msg,
      });
    }
  }

  /**
   * Delete an installed community template from one scope, and optionally its
   * saved variable values. Unlike install, the index is not consulted: the
   * template manager only deletes the file of that name in the scope's
   * templates folder, and a template that has left the library can still go.
   */
  async handleUninstall(
    ctx: DashboardClientContext,
    message: UninstallCommunityTemplateMessage
  ): Promise<void> {
    const { id, scope, clearSavedValues } = message;
    try {
      const removed = await this.installer.uninstallTemplate(id, scope);
      Log.info(`[CommunityTemplates] uninstalled "${id}" from ${removed}`);
      if (clearSavedValues) {
        await this.installer.clearSavedValues(
          buildCustomTemplateId(scope, id),
          ctx
        );
      }
      ctx.emit({
        type: MESSAGE_TYPES.COMMUNITY_TEMPLATE_UNINSTALL_RESULT,
        id,
        scope,
        success: true,
      });
      await this.installer.refreshTemplateCatalog(ctx);
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.warn(`[CommunityTemplates] uninstalling "${id}" failed:`, msg);
      ctx.emit({
        type: MESSAGE_TYPES.COMMUNITY_TEMPLATE_UNINSTALL_RESULT,
        id,
        scope,
        success: false,
        error: msg,
      });
    }
  }
}
