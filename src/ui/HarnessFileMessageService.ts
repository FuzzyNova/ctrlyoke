import * as fs from "fs";
import * as path from "path";
import type { DashboardHostActions } from "../core/HostPorts";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  DASHBOARD_ACTION_RESULT_STATUSES,
  DATA_SOURCES,
  HARNESS_FILE_TYPES,
  MESSAGE_TYPES,
  type HarnessFileType,
} from "../types/DashboardConstants";
import {
  HarnessFileManager,
  readSkillOrigin,
} from "../utils/HarnessFileManager";
import { Log } from "../utils/Log";
import {
  SkillsShRegistryClient,
  checkSkillUpdatesBatch,
  fetchSkillAuditsBatch,
  type SkillsRegistry,
} from "../utils/SkillsRegistryClient";
import type {
  ManagedFile,
  ManagedTargetDirectory,
  RequestHarnessFilesMessage,
  ExportToHarnessMessage,
  ImportToCtrlYokeMessage,
  DeleteFromHarnessMessage,
  SyncAllToHarnessMessage,
  DeleteAllFromHarnessMessage,
  OpenHarnessDirMessage,
  RequestSkillsRegistrySearchMessage,
  RequestSkillsRegistryAuditsMessage,
  RequestRegistrySkillLocationMessage,
  InstallRegistrySkillMessage,
  SkillUpdateCheckResult,
} from "../types/WebviewMessageTypes";
import type { WebviewClientContext } from "./WebviewClientContext";

/** How many skills one audits request may name (one search page and then some). */
const MAX_AUDIT_BATCH = 25;

/**
 * Agent/skill file-manager message handlers (the dashboard's "Agents & Skills"
 * settings section): enumerate every on-disk location, copy files into or out of
 * a harness directory, reveal a target directory in the OS file explorer, and
 * search and install skills from the skills.sh registry.
 *
 * These handlers need nothing from `WebviewMessageRouter` beyond the workspace
 * root and "which client am I" (supplied per call as a
 * {@link WebviewClientContext}). The dispatch table itself stays in the router;
 * entries there are thin delegations to this service.
 */
export class HarnessFileMessageService {
  constructor(
    private readonly getWorkspaceRoot: () => string,
    private readonly hostActions: Pick<DashboardHostActions, "revealInOs">,
    private readonly onFilesChanged: () => Promise<void> = async () => {},
    private readonly skillsRegistry: SkillsRegistry = new SkillsShRegistryClient()
  ) {}

  /**
   * Every mutating file op shares one shape: run the op, then re-enumerate and
   * hand the client a fresh view of the world. `targetDirectories` is a pure
   * function of (workspaceRoot, fileType) rather than of what is on disk, but it
   * ships alongside `files` on every success so a client that somehow missed the
   * initial `HARNESS_FILES_RESULT` still gets one. The op also changes what the
   * dashboard's agent/skill pickers can offer, so `onFilesChanged` refreshes
   * those too.
   */
  private async runFileOp(
    ctx: WebviewClientContext,
    fileType: HarnessFileType,
    op: (workspaceRoot: string) => Promise<void>
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    try {
      await op(workspaceRoot);
      ctx.emit({
        type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
        success: true,
        ...(await this.resolveFileView(workspaceRoot, fileType)),
      });
      await this.onFilesChanged();
    } catch (error) {
      ctx.emit({
        type: MESSAGE_TYPES.HARNESS_FILE_OP_RESULT,
        success: false,
        error: getErrorMessage(error),
      });
    }
  }

  private async resolveFileView(
    workspaceRoot: string,
    fileType: HarnessFileType
  ): Promise<{
    files: ManagedFile[];
    targetDirectories: ManagedTargetDirectory[];
  }> {
    return {
      files: await HarnessFileManager.resolveAllLocations(
        workspaceRoot,
        fileType
      ),
      targetDirectories: HarnessFileManager.resolveTargetDirectories(
        workspaceRoot,
        fileType
      ),
    };
  }

  async handleRequestHarnessFiles(
    ctx: WebviewClientContext,
    message: RequestHarnessFilesMessage
  ): Promise<void> {
    ctx.emit({
      type: MESSAGE_TYPES.HARNESS_FILES_RESULT,
      ...(await this.resolveFileView(
        this.getWorkspaceRoot(),
        message.fileType
      )),
    });
  }

  async handleExportToHarness(
    ctx: WebviewClientContext,
    message: ExportToHarnessMessage
  ): Promise<void> {
    await this.runFileOp(ctx, message.fileType, (workspaceRoot) =>
      HarnessFileManager.exportToHarness(
        message.sourcePath,
        message.harnessId,
        workspaceRoot,
        message.fileType,
        message.overwrite ?? false,
        message.scope ?? "workspace"
      )
    );
  }

  async handleImportToCtrlYoke(
    ctx: WebviewClientContext,
    message: ImportToCtrlYokeMessage
  ): Promise<void> {
    await this.runFileOp(ctx, message.fileType, (workspaceRoot) =>
      HarnessFileManager.importToCtrlYoke(
        message.sourcePath,
        workspaceRoot,
        message.fileType,
        message.overwrite ?? false
      )
    );
  }

  async handleDeleteFromHarness(
    ctx: WebviewClientContext,
    message: DeleteFromHarnessMessage
  ): Promise<void> {
    await this.runFileOp(ctx, message.fileType, (workspaceRoot) =>
      HarnessFileManager.deleteFromHarness(
        message.name,
        message.harnessId,
        workspaceRoot,
        message.fileType,
        message.scope ?? "workspace"
      )
    );
  }

  async handleSyncAllToHarness(
    ctx: WebviewClientContext,
    message: SyncAllToHarnessMessage
  ): Promise<void> {
    await this.runFileOp(ctx, message.fileType, async (workspaceRoot) => {
      for (const { sourcePath } of message.files ?? []) {
        await HarnessFileManager.exportToHarness(
          sourcePath,
          message.targetHarnessId,
          workspaceRoot,
          message.fileType,
          true,
          message.scope ?? "workspace"
        );
      }
    });
  }

  async handleDeleteAllFromHarness(
    ctx: WebviewClientContext,
    message: DeleteAllFromHarnessMessage
  ): Promise<void> {
    await this.runFileOp(ctx, message.fileType, (workspaceRoot) =>
      HarnessFileManager.deleteAllFromHarness(
        message.harnessId,
        workspaceRoot,
        message.fileType,
        message.scope ?? "workspace"
      )
    );
  }

  async handleSkillsRegistrySearch(
    ctx: WebviewClientContext,
    message: RequestSkillsRegistrySearchMessage
  ): Promise<void> {
    try {
      const skills = await this.skillsRegistry.searchSkills(message.query);
      ctx.emit({
        type: MESSAGE_TYPES.SKILLS_REGISTRY_SEARCH_RESULT,
        requestId: message.requestId,
        skills,
      });
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.warn(
        `[SkillsRegistry] ${DATA_SOURCES.SKILLS_SH.label} search failed:`,
        msg
      );
      ctx.emit({
        type: MESSAGE_TYPES.SKILLS_REGISTRY_SEARCH_RESULT,
        requestId: message.requestId,
        skills: [],
        error: msg,
      });
    }
  }

  async handleSkillsRegistryAudits(
    ctx: WebviewClientContext,
    message: RequestSkillsRegistryAuditsMessage
  ): Promise<void> {
    const skills = (message.skills ?? []).slice(0, MAX_AUDIT_BATCH);
    ctx.emit({
      type: MESSAGE_TYPES.SKILLS_REGISTRY_AUDITS_RESULT,
      results: await fetchSkillAuditsBatch(this.skillsRegistry, skills),
    });
  }

  async handleRegistrySkillLocation(
    ctx: WebviewClientContext,
    message: RequestRegistrySkillLocationMessage
  ): Promise<void> {
    const { source, slug } = message;
    try {
      ctx.emit({
        type: MESSAGE_TYPES.REGISTRY_SKILL_LOCATION_RESULT,
        source,
        slug,
        location: await this.skillsRegistry.resolveSkill(source, slug),
      });
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.warn(`[SkillsRegistry] resolving ${source}/${slug} failed:`, msg);
      ctx.emit({
        type: MESSAGE_TYPES.REGISTRY_SKILL_LOCATION_RESULT,
        source,
        slug,
        error: msg,
      });
    }
  }

  /**
   * Install the exact commit the user reviewed into the scope's ctrlyoke
   * skills directory. The client re-requests its file list on success, for
   * whichever type it is showing by then.
   */
  async handleInstallRegistrySkill(
    ctx: WebviewClientContext,
    message: InstallRegistrySkillMessage
  ): Promise<void> {
    const { location } = message;
    const workspaceRoot = this.getWorkspaceRoot();
    try {
      const files = await this.skillsRegistry.downloadSkill(location);
      await HarnessFileManager.installSkillFiles(
        location.slug,
        files,
        {
          registry: DATA_SOURCES.SKILLS_SH.host,
          source: location.source,
          slug: location.slug,
          commitSha: location.commitSha,
          skillMdPath: location.skillMdPath,
        },
        workspaceRoot,
        message.scope ?? "workspace",
        message.replace === true
      );
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.warn(
        `[SkillsRegistry] installing ${location?.source}/${location?.slug} failed:`,
        msg
      );
      ctx.emit({
        type: MESSAGE_TYPES.REGISTRY_SKILL_INSTALL_RESULT,
        source: location?.source ?? "",
        slug: location?.slug ?? "",
        success: false,
        error: msg,
      });
      return;
    }
    ctx.emit({
      type: MESSAGE_TYPES.REGISTRY_SKILL_INSTALL_RESULT,
      source: location.source,
      slug: location.slug,
      success: true,
    });
    await this.onFilesChanged();
  }

  /**
   * Check every skills.sh skill installed in either ctrlyoke scope against
   * its GitHub repository, and list the files edited locally since install
   * (which an update would replace). Always answers, one result per skill.
   */
  async handleSkillsRegistryUpdateCheck(
    ctx: WebviewClientContext
  ): Promise<void> {
    let results: SkillUpdateCheckResult[] = [];
    try {
      const files = await HarnessFileManager.resolveAllLocations(
        this.getWorkspaceRoot(),
        HARNESS_FILE_TYPES.SKILL
      );
      const installed = (
        await Promise.all(
          files
            .flatMap((file) => file.locations)
            .filter(
              (location) =>
                location.origin?.registry === DATA_SOURCES.SKILLS_SH.host
            )
            .map(async (location) => ({
              location,
              record: await readSkillOrigin(location.path),
            }))
        )
      ).flatMap(({ location, record }) =>
        record ? [{ location, record }] : []
      );
      const outcomes = await checkSkillUpdatesBatch(
        this.skillsRegistry,
        installed.map(({ record }) => record)
      );
      results = await Promise.all(
        installed.map(async ({ location, record }, index) => {
          const outcome = outcomes[index]!;
          return {
            path: location.path,
            scope: location.scope,
            source: record.source,
            slug: record.slug,
            status: outcome.status,
            ...("latestCommitSha" in outcome
              ? { latestCommitSha: outcome.latestCommitSha }
              : { error: outcome.error }),
            localChanges: await HarnessFileManager.findLocalSkillChanges(
              location.path,
              record.files
            ).catch(() => []),
          };
        })
      );
    } catch (error) {
      Log.warn(`[SkillsRegistry] update check failed:`, getErrorMessage(error));
    }
    ctx.emit({
      type: MESSAGE_TYPES.SKILLS_REGISTRY_UPDATE_CHECK_RESULT,
      results,
    });
  }

  async handleOpenHarnessDir(
    ctx: WebviewClientContext,
    message: OpenHarnessDirMessage
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    try {
      const dirPath = HarnessFileManager.getTargetDir(
        message.harnessId,
        workspaceRoot,
        message.fileType,
        message.scope ?? "workspace"
      );
      if (!fs.existsSync(dirPath)) {
        throw new Error(
          `The ${message.scope ?? "workspace"} ${message.fileType} folder does not exist yet: ${dirPath}`
        );
      }

      const result = this.hostActions.revealInOs
        ? await this.hostActions.revealInOs(dirPath)
        : undefined;
      if (result?.status === DASHBOARD_ACTION_RESULT_STATUSES.FAILED) {
        throw new Error(result.message);
      }
      const browserDirectory = path
        .relative(workspaceRoot, dirPath)
        .replace(/\\/g, "/");
      ctx.emit({
        type: MESSAGE_TYPES.OPEN_HARNESS_DIR_RESULT,
        success: true,
        ...(!result ||
        result.status === DASHBOARD_ACTION_RESULT_STATUSES.UNSUPPORTED
          ? { path: browserDirectory || "." }
          : {}),
      });
    } catch (error) {
      ctx.emit({
        type: MESSAGE_TYPES.OPEN_HARNESS_DIR_RESULT,
        success: false,
        error: getErrorMessage(error),
      });
    }
  }
}
