import * as path from "path";
import * as fs from "fs/promises";
import * as yaml from "js-yaml";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  WORKFLOW_PROPERTY_KEYS,
  PROMPT_PROPERTIES,
  PANEL_CLIENT_ID,
  CLEAR_HISTORY_CONFIRMATION_PHRASE,
  EMPTY_TRASH_CONFIRMATION_PHRASE,
  HISTORY_TRASH_ACTIONS,
  type HistoryTrashAction,
  WORKFLOW_FILE_FORMATS,
  type WorkflowFileFormat,
  SETTING_SCOPES,
  type SettingWriteScope,
  WORKFLOW_VIEW_ADDRESS_KIND,
  PATH_SELECTION_KINDS,
  DASHBOARD_ACTION_RESULT_STATUSES,
} from "../types/DashboardConstants";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { configService } from "../config/CtrlYokeConfigService";
import { shouldClearTemplateVariableDefaults } from "../utils/TemplateVariableDefaults";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import { Log } from "../utils/Log";
import {
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
} from "../utils/PersistedSchemaGuard";
import { readJsonFile } from "../utils/FileSystemUtils";
import { getErrorMessage } from "../utils/ErrorUtils";
import type {
  TemplateManager,
  TemplateInfo,
  TemplateScope,
} from "../core/TemplateManager";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import { OutputHistoryManager } from "../core/orchestration/OutputHistoryManager";
import { WorkflowLineageRepository } from "../core/orchestration/WorkflowLineageRepository";
import {
  HistoryTrashRepository,
  toHistoryTrashedMessage,
} from "../core/orchestration/HistoryTrashRepository";
import {
  describeRestoreResult,
  TRASH_ENTRY_GONE_MESSAGE,
} from "../utils/HistoryTrashDescriptions";
import {
  getLineageLastModifiedAt,
  stripLegacyWorkingFileLineageMetadata,
} from "../utils/WorkingFileMetadata";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import type { PostMessageFn } from "./WebviewSettingsSync";
import {
  isScriptStep,
  EXECUTION_PROPERTY_KEYS,
  type PromptStep,
  type WorkingFile,
  type WorkflowViewAddress,
  type WorkflowRunNavigationSummary,
  type WorkflowKey,
} from "../types/CtrlYokeTypes";
import { PropertyResolver } from "../utils/PropertyResolver";
import { isUnstartedRunFile } from "../utils/StepStatusDerivation";
import { extractExtensionsFromGlobs } from "../utils/fileFilterUtils";
import { isPathWithinDirectory } from "../utils/PathSecurity";
import { pathsEqual } from "../utils/PathCasing";
import {
  analyzeWorkflowBundle,
  getBundlePlanFingerprint,
  type WorkflowBundleAnalysis,
} from "../utils/WorkflowBundleAnalyzer";
import type { SaveWorkflowBundlePreview } from "../types/WebviewMessageTypes";
import { writeWorkflowBundle } from "../utils/WorkflowBundleWriter";
import { normalizeParallelGroupTopology } from "../core/ParallelGroupTopology";
import type {
  DashboardHostActions,
  KeyValueStore,
  NamedRoot,
} from "../core/HostPorts";

/**
 * WorkflowSerializer
 *
 * Handles all workflow persistence operations:
 * - Save workflow to disk (YAML/JSON)
 * - Export output as markdown
 * - New workflow creation (template modal)
 * - Workflow history (recent workflows, load, clear, remove)
 * - Run history (load, clear)
 * - Workflow name updates
 */
/** workspaceState key for the last directory a durable workflow was exported to (Save As). */
const LAST_EXPORT_DIR_KEY = "ctrlyoke.lastWorkflowExportDir";
/** workspaceState key for the last directory used by a template variable picker. */
const LAST_TEMPLATE_BROWSE_DIR_KEY = "ctrlyoke.lastTemplateBrowseDir";

const NO_WORKFLOW_KEYS: ReadonlySet<WorkflowKey> = new Set();

export class WorkflowSerializer {
  private readonly lineageRepository = new WorkflowLineageRepository();

  private readonly hostActions: Pick<
    DashboardHostActions,
    "selectWorkspacePath" | "openWorkspaceTarget" | "openContentPreview"
  >;
  private readonly getWorkspaceRoot: () => string | undefined;
  private readonly getNamedRoots: () => readonly NamedRoot[];
  private readonly getTrustedRoots: () => readonly string[];

  constructor(
    private readonly postMessage: PostMessageFn,
    private readonly templateManager: TemplateManager,
    private readonly getManager: () => WorkflowOrchestrator | undefined,
    private readonly getOutputHistoryManager: () =>
      OutputHistoryManager | undefined,
    private readonly workspaceState: KeyValueStore,
    hostServices: {
      actions: Pick<
        DashboardHostActions,
        "selectWorkspacePath" | "openWorkspaceTarget" | "openContentPreview"
      >;
      getWorkspaceRoot: () => string | undefined;
      getNamedRoots: () => readonly NamedRoot[];
      getTrustedRoots: () => readonly string[];
    } = {
      actions: {
        openWorkspaceTarget: async () => ({
          status: DASHBOARD_ACTION_RESULT_STATUSES.UNSUPPORTED,
        }),
      },
      getWorkspaceRoot: () => undefined,
      getNamedRoots: () => [],
      getTrustedRoots: () => [],
    }
  ) {
    this.hostActions = hostServices.actions;
    this.getWorkspaceRoot = hostServices.getWorkspaceRoot;
    this.getNamedRoots = hostServices.getNamedRoots;
    this.getTrustedRoots = hostServices.getTrustedRoots;
  }

  private get workspaceRoot(): string | undefined {
    return this.getWorkspaceRoot();
  }

  // ============================================================================
  // Save Workflow
  // ============================================================================

  private static addressesEqual(
    left: WorkflowViewAddress,
    right: WorkflowViewAddress
  ): boolean {
    return (
      left.workflowKey === right.workflowKey &&
      left.kind === right.kind &&
      (left.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT ||
        (right.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
          left.runRef === right.runRef))
    );
  }

  /** Resolve the caller's displayed address, never the lineage's mutable/latest run. */
  private getViewedWorkingFilePath(
    clientId: string,
    expectedAddress?: WorkflowViewAddress
  ): string | undefined {
    const manager = this.getManager();
    const viewedAddress =
      typeof manager?.getViewAddress === "function"
        ? manager.getViewAddress(clientId)
        : null;
    if (
      expectedAddress &&
      (!viewedAddress ||
        !WorkflowSerializer.addressesEqual(viewedAddress, expectedAddress))
    ) {
      return undefined;
    }
    const address = expectedAddress ?? viewedAddress;
    const workspaceRoot = this.workspaceRoot;
    if (address && workspaceRoot) {
      return address.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT
        ? WorkflowPaths.draftFilePath(workspaceRoot, address.workflowKey)
        : WorkflowPaths.runFilePath(
            workspaceRoot,
            address.workflowKey,
            address.runRef
          );
    }
    // Lightweight unit-test/CLI shims may not expose VS Code workspace folders;
    // their queue path is still an already-resolved internal snapshot path.
    return manager?.getQueueState(clientId).workingFilePath;
  }

  /**
   * Resolve an export path under the workspace and reject symlink escapes.
   * This is shared by path checks and the final write so the advisory warning
   * cannot have weaker security rules than the commit path.
   */
  private async resolveSafeExportPath(filePath: string): Promise<string> {
    if (!filePath || !filePath.trim()) {
      throw new Error("A save destination is required.");
    }

    const workspaceRoot = this.workspaceRoot;
    const resolved = workspaceRoot
      ? path.resolve(workspaceRoot, filePath)
      : path.resolve(filePath);

    if (!workspaceRoot) {
      return resolved;
    }

    const root = path.resolve(workspaceRoot);
    if (!isPathWithinDirectory(resolved, root) || pathsEqual(resolved, root)) {
      throw new Error("Save location must be inside the open workspace.");
    }

    const rootRealPath = await fs.realpath(root).catch(() => root);
    let ancestor = path.dirname(resolved);
    while (true) {
      try {
        await fs.lstat(ancestor);
        break;
      } catch (error: any) {
        if (error?.code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) {
          throw new Error("Save location has no existing ancestor.");
        }
        ancestor = parent;
      }
    }
    const realAncestor = await fs.realpath(ancestor);
    if (!isPathWithinDirectory(realAncestor, rootRealPath)) {
      throw new Error(
        "Save location escapes the open workspace through a symlink."
      );
    }

    try {
      const destination = await fs.lstat(resolved);
      if (destination.isSymbolicLink()) {
        throw new Error("Save destination cannot be a symbolic link.");
      }
      if (destination.isDirectory()) {
        throw new Error("Save destination must be a file.");
      }
    } catch (error: any) {
      if (error?.code !== "ENOENT") throw error;
    }
    return resolved;
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private async analyzeSaveBundle(
    cleanWorkflow: Record<string, unknown>,
    destinationPath: string | undefined,
    templateMode: boolean,
    clientId: string,
    manager: WorkflowOrchestrator
  ): Promise<WorkflowBundleAnalysis> {
    const workspaceRoot = this.workspaceRoot;
    const sourceDefinitionPath =
      typeof manager.getViewSourceDefinitionPath === "function"
        ? ((await manager.getViewSourceDefinitionPath(clientId)) ?? undefined)
        : undefined;

    return analyzeWorkflowBundle(cleanWorkflow, {
      workspaceRoot,
      trustedRoots: workspaceRoot ? [...this.getTrustedRoots()] : undefined,
      approvedExternalRoots: workspaceRoot
        ? ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
            ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot)
          )
        : undefined,
      namedRoots: workspaceRoot ? [...this.getNamedRoots()] : undefined,
      sourceDefinitionPath,
      ...(destinationPath ? { destinationPath } : {}),
      templateMode,
    });
  }

  private getBundleBlockerMessage(
    blockers: readonly { message: string; fieldPath?: string; token?: string }[]
  ): string {
    return blockers
      .map((blocker) => {
        const location = blocker.fieldPath
          ? ` (${blocker.fieldPath}${blocker.token ? `, ${blocker.token}` : ""})`
          : "";
        return `${blocker.message}${location}`;
      })
      .join("\n");
  }

  private getBundlePreview(
    analysis: WorkflowBundleAnalysis
  ): SaveWorkflowBundlePreview {
    const toDiagnostic = (diagnostic: {
      code: string;
      message: string;
      fieldPath?: string;
      token?: string;
    }) => ({
      code: diagnostic.code,
      message: diagnostic.message,
      ...(diagnostic.fieldPath ? { fieldPath: diagnostic.fieldPath } : {}),
      ...(diagnostic.token ? { token: diagnostic.token } : {}),
    });
    return {
      copyCount: analysis.plan.copies.length,
      inlineCount: analysis.plan.inlines.length,
      pruneCount: analysis.plan.pruneCandidates.length,
      ...(analysis.plan.assetsDirectory
        ? { assetsDirectoryName: path.basename(analysis.plan.assetsDirectory) }
        : {}),
      warnings: analysis.plan.warnings.map(toDiagnostic),
      blockers: analysis.plan.blockers.map(toDiagnostic),
      planFingerprint: getBundlePlanFingerprint(analysis.plan),
    };
  }

  private sendSavePathChecked(
    postMessage: PostMessageFn,
    requestId: string,
    filePath: string,
    address: WorkflowViewAddress,
    exists: boolean,
    options: {
      error?: string;
      bundlePreview?: SaveWorkflowBundlePreview;
      planChanged?: boolean;
    } = {}
  ): void {
    postMessage({
      type: MESSAGE_TYPES.SAVE_PATH_CHECKED,
      requestId,
      path: filePath,
      address,
      exists,
      ...(options.bundlePreview
        ? { bundlePreview: options.bundlePreview }
        : {}),
      ...(options.planChanged ? { planChanged: true } : {}),
      ...(options.error ? { error: options.error } : {}),
    });
  }

  private sendSaveFailure(
    postMessage: PostMessageFn,
    error: string,
    requestId?: string
  ): void {
    postMessage({
      type: MESSAGE_TYPES.WORKFLOW_SAVE_FAILED,
      ...(requestId ? { requestId } : {}),
      error,
    });
  }

  private sendActionFailure(
    postMessage: PostMessageFn,
    action: string,
    error: string
  ): void {
    postMessage({
      type: MESSAGE_TYPES.WORKFLOW_ACTION_FAILED,
      action,
      error,
    });
  }

  /**
   * Handle SAVE_WORKFLOW_REQUEST from the webview.
   * Determines the default save path and format from the working file and
   * sends SAVE_WORKFLOW_DIALOG_DATA back so the webview can open the dialog.
   */
  async handleSaveWorkflowRequest(
    requestId: string,
    address: WorkflowViewAddress,
    postMessage?: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const manager = this.getManager();
    if (!manager) {
      this.sendSaveFailure(pm, "No workflow manager available.", requestId);
      return;
    }

    const workingFilePath = this.getViewedWorkingFilePath(clientId, address);

    if (!workingFilePath) {
      this.sendSaveFailure(
        pm,
        "The viewed workflow changed before Save could open.",
        requestId
      );
      return;
    }

    // Unsaved workflows default to the last directory the user exported a
    // durable workflow to, then to the repo root on the very first export —
    // ctrlyoke doesn't own a durable "workflows" folder; the user decides.
    const repoRoot = this.workspaceRoot ?? "";
    const defaultDir =
      this.workspaceState.get<string>(LAST_EXPORT_DIR_KEY) || repoRoot;

    try {
      const rawContent = await fs.readFile(workingFilePath, "utf-8");
      const workingFile = JSON.parse(rawContent);
      const workspaceRoot = this.workspaceRoot;
      const descriptor = workspaceRoot
        ? await this.lineageRepository.readDescriptor(
            workspaceRoot,
            address.workflowKey
          )
        : undefined;

      const workflowDisplayName =
        descriptor?.workflowName ||
        path
          .basename(workingFilePath)
          .replace(/\.ctrlyoke\.(ya?ml|json)$/i, "");

      let defaultPath: string;
      if (descriptor?.originalFile) {
        defaultPath = descriptor.originalFile;
      } else {
        const name =
          workflowDisplayName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "workflow";
        defaultPath = path.join(defaultDir, `${name}.ctrlyoke.yaml`);
      }

      const defaultFormat: "yaml" | "json" = defaultPath
        .toLowerCase()
        .endsWith(".json")
        ? "json"
        : "yaml";

      const title = `Save ${workflowDisplayName}`;
      let subtitle: string | undefined;
      if (address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN) {
        const summary = workspaceRoot
          ? await new OutputHistoryManager(workspaceRoot)
              .getRunSummaries(address.workflowKey)
              .then((summaries) =>
                summaries.find(
                  (candidate) => candidate.runRef === address.runRef
                )
              )
          : undefined;
        const runId = summary?.runId ?? address.runRef;
        if (workingFile._runtime?.pendingRewind) {
          subtitle = `Run ${runId} — pending continuation`;
        } else {
          const date = summary
            ? new Date(summary.startedAt).toISOString().slice(0, 10)
            : "unknown date";
          subtitle = `Run ${runId} (${date})`;
        }
      }

      pm({
        type: MESSAGE_TYPES.SAVE_WORKFLOW_DIALOG_DATA,
        requestId,
        address,
        title,
        subtitle,
        defaultPath,
        defaultFormat,
      });
    } catch (error) {
      const msg = getErrorMessage(error);
      this.sendSaveFailure(pm, `Failed to read workflow: ${msg}`, requestId);
    }
  }

  /** Return an addressed, non-mutating overwrite/security preflight result. */
  async handleCheckSavePath(
    requestId: string,
    filePath: string,
    address: WorkflowViewAddress,
    postMessage?: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const manager = this.getManager();
    const workingFilePath = this.getViewedWorkingFilePath(clientId, address);
    if (!manager || !workingFilePath) {
      this.sendSavePathChecked(pm, requestId, filePath, address, false, {
        error: "The viewed workflow changed.",
      });
      return;
    }
    try {
      const absolutePath = await this.resolveSafeExportPath(filePath);
      const workingFile = await readJsonFile(workingFilePath);
      const clean = this.buildCleanWorkflow(workingFile);
      const analysis = await this.analyzeSaveBundle(
        clean,
        absolutePath,
        false,
        clientId,
        manager
      );
      this.sendSavePathChecked(
        pm,
        requestId,
        filePath,
        address,
        await this.pathExists(absolutePath),
        { bundlePreview: this.getBundlePreview(analysis) }
      );
    } catch (error) {
      this.sendSavePathChecked(pm, requestId, filePath, address, false, {
        error: getErrorMessage(error),
      });
    }
  }

  // WORKFLOW_FIELDS: top-level properties to preserve when stripping a working
  // file down to a durable workflow (excludes originalFile, workflowName,
  // startedAt, _runtime, and other working-file-only fields).
  private static readonly WORKFLOW_FIELDS = [
    PROMPT_PROPERTIES.PROMPT,
    PROMPT_PROPERTIES.STEPS,
    PROMPT_PROPERTIES.FINAL_STEP,
    PROMPT_PROPERTIES.VARS,
    ...WORKFLOW_PROPERTY_KEYS,
  ] as const;

  // PROMPT_FIELDS: per-step properties to preserve (covers both prompt steps
  // and script steps; fields absent from a step are silently skipped).
  private static readonly PROMPT_FIELDS = [
    PROMPT_PROPERTIES.NAME,
    PROMPT_PROPERTIES.ENABLED,
    PROMPT_PROPERTIES.COLOR,
    PROMPT_PROPERTIES.STEP_TYPE,
    PROMPT_PROPERTIES.PROMPT,
    PROMPT_PROPERTIES.SCRIPT,
    PROMPT_PROPERTIES.ENV,
    PROMPT_PROPERTIES.TIMEOUT,
    PROMPT_PROPERTIES.ON_PASS,
    PROMPT_PROPERTIES.ON_FAIL,
    PROMPT_PROPERTIES.COMPARE_SOURCE,
    PROMPT_PROPERTIES.OPERATOR,
    PROMPT_PROPERTIES.EXPECTED,
    PROMPT_PROPERTIES.IGNORE_CASE,
    PROMPT_PROPERTIES.SHELL,
    ...EXECUTION_PROPERTY_KEYS,
  ] as const;

  /**
   * Strip a working file down to a durable workflow shape: only real
   * workflow/prompt fields survive (WORKFLOW_FIELDS/PROMPT_FIELDS), so
   * `_runtime`, `originalFile`, `workflowName`, `startedAt`, and other
   * working-file-only fields are dropped. Shared by `handleSaveWorkflow`
   * and `handleSaveWorkflowAsTemplate`.
   */
  private buildCleanWorkflow(
    workingFile: Record<string, any>
  ): Record<string, unknown> {
    const clean: Record<string, unknown> = {
      schemaVersion:
        CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.WORKFLOW_DEFINITION],
    };

    for (const field of WorkflowSerializer.WORKFLOW_FIELDS) {
      if (
        field in workingFile &&
        field !== PROMPT_PROPERTIES.STEPS &&
        field !== PROMPT_PROPERTIES.FINAL_STEP
      ) {
        clean[field] = workingFile[field];
      }
    }

    if (workingFile.finalStep && typeof workingFile.finalStep === "object") {
      const cleanFinalStep: Record<string, unknown> = {};
      for (const field of WorkflowSerializer.PROMPT_FIELDS) {
        if (field in workingFile.finalStep) {
          cleanFinalStep[field] = workingFile.finalStep[field];
        }
      }
      clean.finalStep = cleanFinalStep;
    }

    if (Array.isArray(workingFile.steps)) {
      const cleanSteps = workingFile.steps.map(
        (step: Record<string, unknown>) => {
          const cleanStep: Record<string, unknown> = {};
          for (const field of WorkflowSerializer.PROMPT_FIELDS) {
            if (field in step) {
              cleanStep[field] = step[field];
            }
          }
          return cleanStep;
        }
      );
      const topology = normalizeParallelGroupTopology({
        steps: workingFile.steps,
        parallelGroups: workingFile.parallelGroups,
      });
      const parallelGroups = topology.parallelGroups;
      const groupsByStart = new Map(
        parallelGroups.map((group) => [group.startIndex, group])
      );
      const authoredSteps: Record<string, unknown>[] = [];

      for (let index = 0; index < cleanSteps.length;) {
        const group = groupsByStart.get(index);
        if (!group) {
          authoredSteps.push(cleanSteps[index]);
          index++;
          continue;
        }

        authoredSteps.push({
          parallel: cleanSteps.slice(group.startIndex, group.endIndex + 1),
          failFast: group.failFast,
        });
        index = group.endIndex + 1;
      }
      clean.steps = authoredSteps;
    } else if (workingFile.prompt !== undefined) {
      clean.prompt = workingFile.prompt;
    }

    return clean;
  }

  /**
   * Handle SAVE_WORKFLOW from the webview.
   * Strips runtime metadata from the working file and serializes it to the
   * requested format and path.
   */
  async handleSaveWorkflow(
    requestId: string,
    address: WorkflowViewAddress,
    filePath: string,
    format: WorkflowFileFormat,
    postMessage?: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID,
    planFingerprint?: string,
    pathCheckRequestId?: string
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const manager = this.getManager();
    if (!manager) {
      this.sendSaveFailure(pm, "No workflow manager available.", requestId);
      return;
    }

    const workingFilePath = this.getViewedWorkingFilePath(clientId, address);

    if (!workingFilePath) {
      this.sendSaveFailure(
        pm,
        "The viewed workflow changed before Save completed.",
        requestId
      );
      return;
    }

    try {
      const workingFile = await readJsonFile(workingFilePath);
      const clean = this.buildCleanWorkflow(workingFile);
      const absolutePath = await this.resolveSafeExportPath(filePath);
      const analysis = await this.analyzeSaveBundle(
        clean,
        absolutePath,
        false,
        clientId,
        manager
      );
      const actualFingerprint = getBundlePlanFingerprint(analysis.plan);
      const requiresBundleApproval =
        analysis.plan.copies.length > 0 ||
        analysis.plan.inlines.length > 0 ||
        analysis.plan.pruneCandidates.length > 0 ||
        analysis.plan.blockers.length > 0;
      if (
        (planFingerprint !== undefined &&
          planFingerprint !== actualFingerprint) ||
        (planFingerprint === undefined && requiresBundleApproval)
      ) {
        this.sendSavePathChecked(
          pm,
          pathCheckRequestId ?? requestId,
          filePath,
          address,
          await this.pathExists(absolutePath),
          {
            bundlePreview: this.getBundlePreview(analysis),
            ...(planFingerprint !== undefined
              ? { planChanged: true }
              : { error: "A current bundle preview is required." }),
          }
        );
        return;
      }
      if (analysis.plan.blockers.length > 0) {
        throw new Error(this.getBundleBlockerMessage(analysis.plan.blockers));
      }

      // No `$schema` key or YAML modeline: the extension's bundled
      // `jsonValidation`/`yamlValidation` associations already cover
      // `*.ctrlyoke.*`, and an in-document schema URL would override them.
      const serialized =
        format === WORKFLOW_FILE_FORMATS.YAML
          ? yaml.dump(analysis.workflow, {
              lineWidth: -1,
              noRefs: true,
              quoteStyle: "double",
            })
          : JSON.stringify(analysis.workflow, null, 2);

      // Re-run the exact preflight immediately before the write. The dialog's
      // warning is advisory and may now be stale; this remains the authority.
      await this.resolveSafeExportPath(filePath);
      if (!this.getViewedWorkingFilePath(clientId, address)) {
        throw new Error("The viewed workflow changed before Save completed.");
      }
      const writeResult = await writeWorkflowBundle({
        workflowPath: absolutePath,
        serializedWorkflow: serialized,
        plan: analysis.plan,
      });
      for (const warning of writeResult.warnings) {
        Log.warn(`[WorkflowSerializer] Save As bundle warning: ${warning}`);
      }

      Log.info(`[WorkflowSerializer] Saved workflow to: ${absolutePath}`);

      // Remember this directory so the next unsaved workflow's Save As
      // defaults here instead of the repo root.
      await this.workspaceState.update(
        LAST_EXPORT_DIR_KEY,
        path.dirname(absolutePath)
      );

      pm({
        type: MESSAGE_TYPES.WORKFLOW_SAVED,
        requestId,
        filePath: absolutePath,
        ...(writeResult.warnings.length > 0
          ? { warnings: writeResult.warnings }
          : {}),
      });
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.error("[WorkflowSerializer] Failed to save workflow:", error);
      this.sendSaveFailure(pm, msg, requestId);
    }
  }

  /**
   * Handle SAVE_WORKFLOW_AS_TEMPLATE from the webview.
   * Snapshots the current working file's values (same field allowlist as
   * `handleSaveWorkflow`) into a new custom template.
   */
  async handleSaveWorkflowAsTemplate(
    requestId: string,
    address: WorkflowViewAddress,
    name: string,
    scope: TemplateScope,
    format: WorkflowFileFormat,
    postMessage?: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const manager = this.getManager();
    if (!manager) {
      this.sendSaveFailure(pm, "No workflow manager available.", requestId);
      return;
    }

    const workingFilePath = this.getViewedWorkingFilePath(clientId, address);

    if (!workingFilePath) {
      this.sendSaveFailure(
        pm,
        "The viewed workflow changed before template export completed.",
        requestId
      );
      return;
    }

    try {
      const workingFile = await readJsonFile(workingFilePath);
      const clean = this.buildCleanWorkflow(workingFile);
      const analysis = await this.analyzeSaveBundle(
        clean,
        undefined,
        true,
        clientId,
        manager
      );
      if (analysis.plan.blockers.length > 0) {
        throw new Error(this.getBundleBlockerMessage(analysis.plan.blockers));
      }

      const templatePath = await this.templateManager.saveWorkflowAsTemplate(
        name,
        scope,
        analysis.workflow,
        format
      );

      for (const warning of analysis.plan.warnings) {
        Log.warn(
          `[WorkflowSerializer] Template export warning: ${warning.message}`
        );
      }

      const templates = await this.templateManager.getAvailableTemplates();
      const created = templates.find((t) => t.path === templatePath);

      pm({
        type: MESSAGE_TYPES.WORKFLOW_SAVED_AS_TEMPLATE,
        requestId,
        templates: this.toWireTemplates(templates),
        templateId: created?.id,
      });
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.error(
        "[WorkflowSerializer] Failed to save workflow as template:",
        error
      );
      this.sendSaveFailure(pm, msg, requestId);
    }
  }

  // ============================================================================
  // Export Output
  // ============================================================================

  async handleExportOutput(
    content: string,
    fileName?: string,
    postMessage?: PostMessageFn
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    try {
      let baseName = fileName || "ctrlyoke-output";
      baseName = baseName
        .replace(/\.ctrlyoke\.(ya?ml|json)$/i, "")
        .replace(/\.prompt\.md$/i, "");
      if (!baseName.endsWith(".md")) {
        baseName += ".md";
      }

      const workspaceRoot = this.workspaceRoot;
      let defaultPath: string;
      if (workspaceRoot) {
        const outputDir = path.join(
          workspaceRoot,
          PATH_CONSTANTS.CTRLYOKE_DIR,
          "output"
        );
        await fs.mkdir(outputDir, { recursive: true });
        defaultPath = path.join(outputDir, baseName);
      } else {
        defaultPath = path.resolve(baseName);
      }

      Log.debug(
        `[WorkflowSerializer] handleExportOutput: requesting save path, defaultPath=${defaultPath}, contentLength=${content.length}`
      );

      const selectedPath = await this.hostActions.selectWorkspacePath?.({
        kind: PATH_SELECTION_KINDS.SAVE,
        title: "Export Output",
        defaultPath,
        filters: {
          "Markdown Files": ["md"],
          "Text Files": ["txt"],
          "All Files": ["*"],
        },
      });

      if (selectedPath) {
        await fs.writeFile(selectedPath, content, "utf-8");
      } else {
        Log.debug(
          "[WorkflowSerializer] handleExportOutput: save dialog cancelled by user"
        );
      }
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.error("[WorkflowSerializer] Failed to export output:", error);
      this.sendActionFailure(
        pm,
        "export output",
        `Failed to export output: ${msg}`
      );
    }
  }

  // ============================================================================
  // New Workflow / Template Modal
  // ============================================================================

  /** Wire shape sent to the webview for each template — shared by every message that lists templates. */
  private toWireTemplates(templates: TemplateInfo[]) {
    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      variables: t.variables,
      isBuiltIn: t.isBuiltIn,
      source: t.source,
    }));
  }

  async handleNewWorkflow(postMessage?: PostMessageFn): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    try {
      const templates = await this.templateManager.getAvailableTemplates();
      const defaultTemplateId = ConfigurationUtils.getDefaultWorkflowTemplate();
      const defaultTemplateSource =
        ConfigurationUtils.getDefaultWorkflowTemplateSource();

      pm({
        type: MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL,
        templates: this.toWireTemplates(templates),
        defaultTemplateId,
        defaultTemplateSource,
      });
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      this.sendActionFailure(
        pm,
        "load templates",
        `Failed to load templates: ${errorMsg}`
      );
    }
  }

  /** Load template metadata without opening the New Workflow modal. */
  async handleTemplateCatalogRequest(
    postMessage?: PostMessageFn
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    try {
      const templates = await this.templateManager.getAvailableTemplates();
      pm({
        type: MESSAGE_TYPES.TEMPLATE_CATALOG_LOADED,
        templates: this.toWireTemplates(templates),
      });
    } catch (error) {
      Log.error("[WorkflowSerializer] Failed to load template catalog:", error);
      this.sendActionFailure(
        pm,
        "load templates",
        `Failed to load templates: ${getErrorMessage(error)}`
      );
    }
  }

  async handleTemplateSelected(
    templateId: string,
    postMessage?: PostMessageFn
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    try {
      const template = await this.templateManager.getTemplateInfo(templateId);
      pm({
        type: MESSAGE_TYPES.TEMPLATE_INFO,
        template,
      });
    } catch (error) {
      Log.error("[WorkflowSerializer] Failed to load template:", error);
    }
  }

  async handleSetDefaultTemplate(
    templateId: string,
    scope: SettingWriteScope,
    postMessage?: PostMessageFn
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    try {
      await ConfigurationUtils.setDefaultWorkflowTemplate(templateId, scope);
      const defaultTemplateId =
        ConfigurationUtils.getDefaultWorkflowTemplate();
      const defaultTemplateSource =
        ConfigurationUtils.getDefaultWorkflowTemplateSource();

      pm({
        type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
        templateId,
        defaultTemplateId,
        defaultTemplateSource,
        scope,
      });
    } catch (error) {
      Log.error("[WorkflowSerializer] Failed to set default template:", error);
    }
  }

  async handleSetTemplateVariableDefaults(
    templateId: string,
    values: Record<string, string | null>,
    scope: SettingWriteScope,
    postMessage?: PostMessageFn
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    try {
      const template = await this.templateManager.getTemplateInfo(templateId);
      if (!template) throw new Error(`Unknown template: ${templateId}`);

      const userSettings = configService.getScoped(
        "templates",
        SETTING_SCOPES.USER
      );
      const workspaceSettings = configService.getScoped(
        "templates",
        SETTING_SCOPES.WORKSPACE
      );
      const userValues = userSettings?.variableDefaults?.[templateId];
      const workspaceValues =
        workspaceSettings?.variableDefaults?.[templateId];
      const pinnedValues = Object.fromEntries(
        Object.entries(values).filter(
          (entry): entry is [string, string] => entry[1] !== null
        )
      );
      const clearPinnedValues =
        Object.keys(pinnedValues).length > 0 &&
        shouldClearTemplateVariableDefaults(
          template.variables,
          scope,
          userValues,
          workspaceValues,
          pinnedValues
        );

      const nextValues = {
        ...(scope === SETTING_SCOPES.USER ? userValues : workspaceValues),
      };
      for (const [name, value] of Object.entries(values)) {
        if (value === null || clearPinnedValues) {
          delete nextValues[name];
        } else {
          nextValues[name] = value;
        }
      }

      const variableDefaults = {
        ...(scope === SETTING_SCOPES.USER
          ? userSettings?.variableDefaults
          : workspaceSettings?.variableDefaults),
      };
      if (Object.keys(nextValues).length === 0) {
        delete variableDefaults[templateId];
      } else {
        variableDefaults[templateId] = nextValues;
      }
      await configService.set("templates.variableDefaults", variableDefaults, scope);

      const templates = await this.templateManager.getAvailableTemplates();
      pm({
        type: MESSAGE_TYPES.TEMPLATE_VARIABLE_DEFAULTS_SET,
        templates: this.toWireTemplates(templates),
        templateId,
        variableNames: Object.keys(values),
        scope,
      });
    } catch (error) {
      Log.error(
        "[WorkflowSerializer] Failed to set template variable defaults:",
        error
      );
    }
  }

  async handleCreateWorkflow(
    message: any,
    clientId: string,
    postMessage?: PostMessageFn
  ): Promise<boolean> {
    const pm = postMessage ?? this.postMessage;
    const { templateId, variables, filename, runAfter } = message;

    try {
      const promptFile = await this.templateManager.createWorkflow(
        templateId,
        variables || {}
      );

      const orchestrator = this.getManager();
      if (!orchestrator) {
        throw new Error("No active workspace");
      }

      const instance = await orchestrator.createWorkflowFromTemplateForClient(
        promptFile,
        filename,
        pm,
        clientId
      );

      pm({
        type: MESSAGE_TYPES.WORKFLOW_CREATED,
        filePath: instance.getSummary().workingFilePath,
      });

      if (runAfter) {
        await orchestrator.executeWorkflow(instance.id);
      }

      return true;
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      pm({
        type: MESSAGE_TYPES.WORKFLOW_CREATED,
        error: errorMsg,
      });
      return false;
    }
  }

  /**
   * Create a custom template entirely from webview-supplied input — no native VS
   * Code dialogs. This is what the "New template..." accordion in TemplateModal
   * posts; it must work identically for the VS Code webview and hosted browser
   * clients, including the Command Palette's `ctrlyoke.createNewTemplate`
   * command, which opens this same modal path.
   */
  async handleCreateCustomTemplate(
    name: string,
    scope: TemplateScope,
    format: WorkflowFileFormat,
    baseTemplateId: string,
    postMessage?: PostMessageFn
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    try {
      const templatePath = await this.templateManager.createCustomTemplate(
        name,
        scope,
        format,
        baseTemplateId
      );

      // Best-effort editor convenience for desktop VS Code users; irrelevant to
      // (and safely ignored by) hosted browser clients.
      try {
        await this.hostActions.openWorkspaceTarget({ path: templatePath });
      } catch (openError) {
        Log.warn(
          `[WorkflowSerializer] Failed to open newly created template: ${openError}`
        );
      }

      const templates = await this.templateManager.getAvailableTemplates();
      const created = templates.find((t) => t.path === templatePath);

      pm({
        type: MESSAGE_TYPES.CUSTOM_TEMPLATE_CREATED,
        templates: this.toWireTemplates(templates),
        templateId: created?.id,
      });
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      pm({
        type: MESSAGE_TYPES.CUSTOM_TEMPLATE_CREATED,
        error: errorMsg,
      });
    }
  }

  /**
   * Resolve a native picker result into a workspace-relative,
   * forward-slash-normalized path (portable across platforms and valid in
   * prompt file @path references). Returns undefined when the dialog was
   * cancelled. Shared by `handleBrowseTemplateFile` and
   * `handleBrowseSaveLocation` so the two native dialogs normalize identically.
   */
  private resolveDialogSelection(
    selectedPath: string | undefined,
    workspaceRoot: string | undefined
  ): string | undefined {
    if (!selectedPath) {
      return undefined;
    }
    let resolvedPath = selectedPath;
    // `isPathWithinDirectory` rather than a raw `startsWith`: the dialog returns
    // a VS Code `fsPath` (lowercase drive letter) while `workspaceRoot` may carry
    // OS-native casing, and the shared helper also rejects sibling-prefix matches
    // like `C:\dev\ctrlyoke-evil`. Case-folding preserves length, so the slice
    // below stays correct.
    if (workspaceRoot && isPathWithinDirectory(resolvedPath, workspaceRoot)) {
      resolvedPath = resolvedPath
        .slice(workspaceRoot.length)
        .replace(/^[\\/]/, "");
    }
    return resolvedPath.replace(/\\/g, "/");
  }

  async handleBrowseTemplateFile(
    variable: string,
    fileFilter?: string[],
    postMessage?: PostMessageFn,
    selectFolder?: boolean
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const workspaceRoot = this.workspaceRoot;
    const fileExtensions =
      !selectFolder && fileFilter?.length
        ? extractExtensionsFromGlobs(fileFilter)
        : undefined;

    const lastBrowseDirectory = this.workspaceState.get<string>(
      LAST_TEMPLATE_BROWSE_DIR_KEY
    );

    const selectPath = this.hostActions.selectWorkspacePath;
    if (!selectPath) {
      const unsupported = {
        status: DASHBOARD_ACTION_RESULT_STATUSES.UNSUPPORTED,
      } as const;
      Log.debug(
        `[WorkflowSerializer] Native template picker unavailable (${unsupported.status}); browser picker remains active.`
      );
      return;
    }
    const selectedPath = await selectPath({
      kind: selectFolder
        ? PATH_SELECTION_KINDS.FOLDER
        : PATH_SELECTION_KINDS.FILE,
      title: selectFolder
        ? `Select folder for {${variable}}`
        : `Select file for {${variable}}`,
      defaultPath: lastBrowseDirectory ?? workspaceRoot,
      filters: selectFolder
        ? undefined
        : {
            ...(fileExtensions?.length
              ? { "Spec / Design Files": fileExtensions }
              : {}),
            "All Files": ["*"],
          },
    });

    const filePath = this.resolveDialogSelection(selectedPath, workspaceRoot);
    if (selectedPath && filePath !== undefined) {
      await this.workspaceState.update(
        LAST_TEMPLATE_BROWSE_DIR_KEY,
        selectFolder ? selectedPath : path.dirname(selectedPath)
      );
      pm({
        type: MESSAGE_TYPES.TEMPLATE_FILE_SELECTED,
        variable,
        path: filePath,
      });
    }
  }

  /**
   * Handle BROWSE_SAVE_LOCATION from the webview (VS Code panel only — the
   * hosted browser client opens the web FileBrowserModal instead, since a
   * native dialog would open invisibly on the host's screen).
   */
  async handleBrowseSaveLocation(
    postMessage?: PostMessageFn,
    defaultDir?: string
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const workspaceRoot = this.workspaceRoot;

    let defaultPath: string | undefined;
    if (defaultDir) {
      defaultPath =
        path.isAbsolute(defaultDir) || !workspaceRoot
          ? defaultDir
          : path.join(workspaceRoot, defaultDir);
    } else if (workspaceRoot) {
      defaultPath = workspaceRoot;
    }

    const selectPath = this.hostActions.selectWorkspacePath;
    if (!selectPath) {
      const unsupported = {
        status: DASHBOARD_ACTION_RESULT_STATUSES.UNSUPPORTED,
      } as const;
      Log.debug(
        `[WorkflowSerializer] Native save-location picker unavailable (${unsupported.status}); browser picker remains active.`
      );
      return;
    }
    const selectedPath = await selectPath({
      kind: PATH_SELECTION_KINDS.FOLDER,
      defaultPath,
      title: "Select Save Location",
    });

    const dirPath = this.resolveDialogSelection(selectedPath, workspaceRoot);
    if (dirPath !== undefined) {
      pm({
        type: MESSAGE_TYPES.SAVE_LOCATION_SELECTED,
        path: dirPath,
      });
    }
  }

  // ============================================================================
  // Workflow Name
  // ============================================================================

  async handleUpdateWorkflowName(
    message: any,
    updateWorkflowNameFn: (name: string) => void,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const manager = this.getManager();
    if (!manager) {
      Log.error("[WorkflowSerializer] WorkflowOrchestrator not initialized");
      return;
    }

    const { workflowName } = message;
    await manager.updateWorkflowName(
      message.mutation as
        | import("../types/WebviewMessageTypes").WorkflowDefinitionMutation
        | undefined,
      workflowName,
      clientId
    );
    updateWorkflowNameFn(workflowName);
  }

  // ============================================================================
  // Recent Workflows
  // ============================================================================

  async handleGetRecentWorkflows(
    replyPostMessage?: PostMessageFn
  ): Promise<void> {
    const pm = replyPostMessage ?? this.postMessage;
    try {
      const workspaceRoot = this.workspaceRoot;
      if (!workspaceRoot) {
        pm({
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [],
        });
        return;
      }

      const workflowKeys =
        await this.lineageRepository.listLineageKeys(workspaceRoot);
      if (workflowKeys.length === 0) {
        pm({
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [],
        });
        return;
      }

      // Build a fast lookup set of working file paths that are currently active
      // in memory. Used below to normalize stale active states from disk.
      const manager = this.getManager();
      const activeWorkingFilePaths = new Set<string>(
        (manager?.getWorkflowSummaries() ?? [])
          .filter(
            (s) =>
              s.executionState === EXECUTION_STATES.RUNNING ||
              s.executionState === EXECUTION_STATES.PAUSING ||
              s.executionState === EXECUTION_STATES.PAUSED
          )
          .map((s) => s.workingFilePath)
          .filter((p): p is string => p !== undefined)
      );

      const workflows = await Promise.all(
        workflowKeys.map(async (workflowKey) => {
          let address: WorkflowViewAddress;
          let descriptor;
          try {
            descriptor = await this.lineageRepository.readDescriptor(
              workspaceRoot,
              workflowKey
            );
            address = descriptor.latestRunRef
              ? {
                  workflowKey,
                  kind: WORKFLOW_VIEW_ADDRESS_KIND.RUN,
                  runRef: descriptor.latestRunRef,
                }
              : { workflowKey, kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT };
          } catch (error) {
            Log.warn(
              `[WorkflowSerializer] Failed to read lineage descriptor ${workflowKey}:`,
              error
            );
            return null;
          }

          const filePath =
            address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
              ? WorkflowPaths.runFilePath(
                  workspaceRoot,
                  address.workflowKey,
                  address.runRef
                )
              : WorkflowPaths.draftFilePath(workspaceRoot, address.workflowKey);
          const runDirectory =
            address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN
              ? WorkflowPaths.runDir(
                  workspaceRoot,
                  address.workflowKey,
                  address.runRef
                )
              : WorkflowPaths.draftDir(workspaceRoot, address.workflowKey);

          try {
            const workingFile = stripLegacyWorkingFileLineageMetadata(
              (await readJsonFile(filePath)) as WorkingFile
            );
            const historyManager =
              this.getOutputHistoryManager() ??
              new OutputHistoryManager(workspaceRoot);
            const { runCount, primaryRunId } =
              await historyManager.getRunNavigationSummary(workflowKey);
            const hasDraft =
              !descriptor.latestRunRef ||
              descriptor.pendingEdit?.kind === WORKFLOW_VIEW_ADDRESS_KIND.DRAFT;
            const runNav: WorkflowRunNavigationSummary = {
              primaryAddress: address,
              primaryRunId,
              runCount,
              hasDraft,
              ...(hasDraft
                ? {
                    draftDirectory: WorkflowPaths.draftDir(
                      workspaceRoot,
                      workflowKey
                    ),
                  }
                : {}),
            };

            const lastModified = await getLineageLastModifiedAt(
              workspaceRoot,
              workflowKey,
              descriptor.lastModifiedAt
            );

            let executionState: string =
              workingFile._runtime?.executionState || EXECUTION_STATES.IDLE;

            // Normalize stale active state: if the disk says "running" or
            // "pausing" but no in-memory workflow is actually executing this
            // file, show STOPPED.
            // This guards against race windows before normalizeStaleLocks finishes.
            // HOWEVER: first check whether the lock file says the CLI is actively
            // running it — this bridges the timing gap where the runner.json
            // file-watcher hasn't fired yet (common on Windows due to watcher latency).
            if (
              (executionState === EXECUTION_STATES.RUNNING ||
                executionState === EXECUTION_STATES.PAUSING) &&
              !activeWorkingFilePaths.has(filePath)
            ) {
              const registeredExternalWatch =
                (await manager?.ensureExternalRunWatchSession(filePath)) ??
                false;
              if (registeredExternalWatch) {
                Log.trace(
                  `[WorkflowSerializer] getRecentWorkflows: "${workflowKey}" has an active external lock — keeping running state (ExternalRunWatchSession registered)`
                );
                // executionState stays "running"; the session is now in externalRunSessions
                // so the next GET_WORKFLOWS_LIST will move it to the Running section.
              } else {
                Log.trace(
                  `[WorkflowSerializer] getRecentWorkflows: normalizing "${workflowKey}" runningstopped (not in activeWorkingFilePaths: [${[...activeWorkingFilePaths].map((p) => path.basename(p)).join(", ") || "none"}])`
                );
                executionState = EXECUTION_STATES.STOPPED;
              }
            }

            const steps = Array.isArray(workingFile.steps)
              ? workingFile.steps
              : [];
            const firstAiStepHarness = steps.find(
              (s): s is PromptStep => !isScriptStep(s)
            )?.harness;
            const harness = PropertyResolver.resolveHarnessValue(
              firstAiStepHarness,
              workingFile.harness
            );

            return {
              address,
              runDirectory,
              workflowName: descriptor.workflowName || workflowKey,
              executionState,
              stopReason: workingFile._runtime?.stopReason,
              startedAt: workingFile.startedAt || 0,
              lastModifiedAt: lastModified,
              isFavorite: descriptor.isFavorite,
              totalSteps: steps.length,
              harness,
              // A draft is unstarted by definition and already shows Run; the
              // flag distinguishes a prepared run from an ordinary idle one.
              ...(address.kind === WORKFLOW_VIEW_ADDRESS_KIND.RUN &&
              isUnstartedRunFile(workingFile)
                ? { unstarted: true }
                : {}),
              tokenTotals: workingFile._runtime?.tokenTotals,
              worktree: workingFile._runtime?.worktree
                ? {
                    branchName: workingFile._runtime.worktree.branchName,
                    worktreePath: workingFile._runtime.worktree.worktreePath,
                  }
                : undefined,
              runNav,
            };
          } catch (error) {
            Log.warn(
              `[WorkflowSerializer] Failed to parse workflow file ${workflowKey}:`,
              error
            );
            return null;
          }
        })
      );

      const validWorkflows = workflows
        .filter((w) => w !== null)
        .sort((a, b) => b!.lastModifiedAt - a!.lastModifiedAt);

      pm({
        type: MESSAGE_TYPES.RECENT_WORKFLOWS,
        workflows: validWorkflows,
      });
    } catch (error) {
      Log.error("[WorkflowSerializer] Failed to get recent workflows:", error);
      pm({
        type: MESSAGE_TYPES.RECENT_WORKFLOWS,
        workflows: [],
      });
    }
  }

  async handleLoadWorkflow(
    message: any,
    postMessage?: PostMessageFn
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const { filePath } = message;

    try {
      await this.getManager()?.loadWorkingFile(filePath);
    } catch (error) {
      Log.error("[WorkflowSerializer] Failed to load workflow:", error);
      this.sendActionFailure(
        pm,
        "load workflow",
        `Failed to load workflow: ${getErrorMessage(error)}`
      );
    }
  }

  async handleToggleFavorite(address: WorkflowViewAddress): Promise<void> {
    try {
      const workspaceRoot = this.workspaceRoot;
      if (!workspaceRoot) return;
      await this.lineageRepository.updateDescriptor(
        workspaceRoot,
        address.workflowKey,
        (descriptor) => ({ ...descriptor, isFavorite: !descriptor.isFavorite })
      );
    } catch (error) {
      Log.error(
        "[WorkflowSerializer] Failed to toggle workflow favorite:",
        error
      );
    }
  }

  private resolveHistoryWorkspaceRoot(): string | undefined {
    return this.workspaceRoot;
  }

  private readonly isLineageExecuting = (workflowKey: WorkflowKey): boolean =>
    this.getManager()?.isLineageExecuting(workflowKey) ?? false;

  /**
   * Clear all history: moves every lineage that is not live into one Recently
   * deleted entry. Refused without the typed confirmation phrase, so no client
   * can wipe history with a single untyped message.
   */
  async handleClearWorkflowHistory(
    confirmation: unknown,
    postMessage: PostMessageFn = this.postMessage,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<ReadonlySet<WorkflowKey>> {
    if (confirmation !== CLEAR_HISTORY_CONFIRMATION_PHRASE) {
      Log.warn(
        `[WorkflowSerializer] Refused Clear all history from ${clientId}: confirmation phrase missing`
      );
      this.sendActionFailure(
        postMessage,
        "clear workflow history",
        "Clear all history needs its confirmation phrase. Use Settings → General → Run History."
      );
      return NO_WORKFLOW_KEYS;
    }
    const workspaceRoot = this.resolveHistoryWorkspaceRoot();
    if (!workspaceRoot) {
      return NO_WORKFLOW_KEYS;
    }
    Log.info(`[WorkflowSerializer] Clear all history requested by ${clientId}`);
    try {
      const { entry, skippedLive, failed } = await new HistoryTrashRepository(
        workspaceRoot
      ).trashAllLineages(clientId, this.isLineageExecuting);
      if (entry) {
        postMessage(toHistoryTrashedMessage(entry));
        for (const item of entry.items) {
          this.getManager()?.forgetRunActivity?.(item.workflowKey);
        }
      }
      if (failed.length > 0) {
        this.sendActionFailure(
          postMessage,
          "clear workflow history",
          `${failed.length} ${failed.length === 1 ? "workflow was" : "workflows were"} in use and left in place.`
        );
      }
      if (skippedLive.length > 0) {
        Log.info(
          `[WorkflowSerializer] Clear all history kept live workflows: ${skippedLive.join(", ")}`
        );
      }
      await this.handleGetRecentWorkflows(postMessage);
      return new Set(entry?.items.map((item) => item.workflowKey));
    } catch (error) {
      Log.error(
        "[WorkflowSerializer] Failed to clear workflow history:",
        error
      );
      this.sendActionFailure(
        postMessage,
        "clear workflow history",
        `Failed to clear workflow history: ${getErrorMessage(error)}`
      );
      return NO_WORKFLOW_KEYS;
    }
  }

  /** Counts what Clear all history would move, for its confirmation dialog. */
  async handleHistoryClearPreview(
    requestId: string,
    postMessage: PostMessageFn = this.postMessage
  ): Promise<void> {
    const workspaceRoot = this.resolveHistoryWorkspaceRoot();
    try {
      if (!workspaceRoot) {
        throw new Error("Open a workspace to manage its run history.");
      }
      const preview = await new HistoryTrashRepository(
        workspaceRoot
      ).previewClearAll(this.isLineageExecuting);
      postMessage({
        type: MESSAGE_TYPES.HISTORY_CLEAR_PREVIEW,
        requestId,
        preview,
      });
    } catch (error) {
      postMessage({
        type: MESSAGE_TYPES.HISTORY_CLEAR_PREVIEW,
        requestId,
        error: getErrorMessage(error),
      });
    }
  }

  /**
   * Handle REMOVE_WORKFLOW_HISTORY: moves one addressed lineage to Recently
   * deleted, refusing a live one. Returns whether it was moved.
   */
  async handleRemoveWorkflowHistory(
    address: WorkflowViewAddress,
    postMessage: PostMessageFn = this.postMessage,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<boolean> {
    const workspaceRoot = this.resolveHistoryWorkspaceRoot();
    if (!workspaceRoot) {
      return false;
    }
    try {
      const entry = await new HistoryTrashRepository(
        workspaceRoot
      ).trashLineage(address.workflowKey, clientId, this.isLineageExecuting);
      if (entry) {
        postMessage(toHistoryTrashedMessage(entry));
        this.getManager()?.forgetRunActivity?.(address.workflowKey);
      }
      return entry !== undefined;
    } catch (error) {
      Log.warn(
        `[WorkflowSerializer] handleRemoveWorkflowHistory: could not delete ${address.workflowKey}: ${getErrorMessage(error)}`
      );
      this.sendActionFailure(
        postMessage,
        "delete workflow history",
        getErrorMessage(error)
      );
      // The client removed the row optimistically; send the real list back.
      await this.handleGetRecentWorkflows(postMessage);
      return false;
    }
  }

  /** Recently deleted, newest first, for the settings view. */
  async handleHistoryTrashList(
    postMessage: PostMessageFn = this.postMessage
  ): Promise<void> {
    const workspaceRoot = this.resolveHistoryWorkspaceRoot();
    const retentionDays = ConfigurationUtils.getTrashRetentionDays();
    const entries = workspaceRoot
      ? await new HistoryTrashRepository(workspaceRoot).list(retentionDays)
      : [];
    postMessage({
      type: MESSAGE_TYPES.HISTORY_TRASH_LIST,
      entries,
      retentionDays,
      totalBytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    });
  }

  /** Restores, purges, or empties Recently deleted, then resends the list. */
  async handleHistoryTrashAction(
    action: HistoryTrashAction,
    request: { entryId?: unknown; confirmation?: unknown },
    postMessage: PostMessageFn = this.postMessage,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const entryId =
      typeof request.entryId === "string" &&
      WorkflowPaths.isValidTrashEntryId(request.entryId)
        ? request.entryId
        : undefined;
    const reply = (ok: boolean, message: string) =>
      postMessage({
        type: MESSAGE_TYPES.HISTORY_TRASH_RESULT,
        action,
        ...(entryId ? { entryId } : {}),
        ok,
        message,
      });
    try {
      const workspaceRoot = this.resolveHistoryWorkspaceRoot();
      if (!workspaceRoot) {
        throw new Error("Open a workspace to manage its run history.");
      }
      const trash = new HistoryTrashRepository(workspaceRoot);
      switch (action) {
        case HISTORY_TRASH_ACTIONS.RESTORE: {
          if (!entryId) throw new Error(TRASH_ENTRY_GONE_MESSAGE);
          const restored = await trash.restore(entryId);
          reply(true, describeRestoreResult(restored));
          await this.getManager()?.refreshRunViewsForLineages?.(
            restored.restoredWorkflowKeys,
            postMessage,
            clientId,
            true
          );
          await this.handleGetRecentWorkflows(postMessage);
          break;
        }
        case HISTORY_TRASH_ACTIONS.PURGE:
          if (!entryId) throw new Error(TRASH_ENTRY_GONE_MESSAGE);
          await trash.purge(entryId, `requested by ${clientId}`);
          reply(true, "Permanently deleted");
          break;
        case HISTORY_TRASH_ACTIONS.EMPTY: {
          if (request.confirmation !== EMPTY_TRASH_CONFIRMATION_PHRASE) {
            throw new Error(
              "Emptying Recently deleted needs its confirmation phrase."
            );
          }
          const count = await trash.purgeAll(`emptied by ${clientId}`);
          reply(
            true,
            `Permanently deleted ${count} ${count === 1 ? "item" : "items"}`
          );
          break;
        }
      }
    } catch (error) {
      Log.warn(
        `[WorkflowSerializer] Recently deleted ${action} failed: ${getErrorMessage(error)}`
      );
      reply(false, getErrorMessage(error));
    }
    await this.handleHistoryTrashList(postMessage);
  }

  // ============================================================================
  // Run History
  // ============================================================================

  /** Stable-address deletion with deterministic client fallback. */
  async handleDeleteRunByAddress(
    address: Extract<WorkflowViewAddress, { kind: "run" }>,
    postMessage?: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const manager = this.getManager();
    if (!manager) return;
    await manager.deleteRunAtAddress(address, pm, clientId);
  }

  /** Deletes every non-executing run of an explicit lineage (run-navigation panel). */
  async handleDeleteAllRunsForLineage(
    workflowKey: WorkflowKey,
    postMessage?: PostMessageFn,
    clientId: string = PANEL_CLIENT_ID
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const manager = this.getManager();
    if (!manager) return;
    await manager.deleteAllRunsForLineage(workflowKey, pm, clientId);
  }
}
