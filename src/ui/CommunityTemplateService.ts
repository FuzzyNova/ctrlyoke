import { MESSAGE_TYPES } from "../types/DashboardConstants";
import type {
  CommunityTemplateEntry,
  InstallCommunityTemplateMessage,
  RequestCommunityTemplateIndexMessage,
  SettingWriteScope,
} from "../types/WebviewMessageTypes";
import type { WorkflowFileFormat } from "../types/DashboardConstants";
import {
  CommunityTemplateClient,
  getCommunityTemplateFormat,
} from "../utils/CommunityTemplateClient";
import { getErrorMessage } from "../utils/ErrorUtils";
import { Log } from "../utils/Log";
import type { DashboardClientContext } from "./DashboardClientContext";

/** What the service needs from the template library to install a download. */
export interface CommunityTemplateInstaller {
  installTemplateContent(
    templateName: string,
    scope: SettingWriteScope,
    format: WorkflowFileFormat,
    content: string
  ): Promise<{ path: string; templateId: string }>;
  /** Send the client the refreshed template catalog after an install. */
  refreshTemplateCatalog(ctx: DashboardClientContext): Promise<void>;
}

/**
 * Community template handlers for the Templates tab's Discover page: list the
 * library's `index.json` and install one template into a custom-template
 * scope. The index is kept for the session once read; errors are not, so a
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
        content
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
}
