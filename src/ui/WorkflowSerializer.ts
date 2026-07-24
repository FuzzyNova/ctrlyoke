import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import * as yaml from "js-yaml";
import {
  MESSAGE_TYPES,
  EXECUTION_STATES,
  PROMPT_PROPERTIES,
  PANEL_CLIENT_ID,
} from "../types/DashboardConstants";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import { getVsCodeWorkspaceRoot } from "../platform/VsCodeWorkspaceRoot";
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
import * as WorkflowPaths from "../utils/WorkflowPaths";
import type { PostMessageFn } from "./WebviewSettingsSync";
import {
  isScriptStep,
  type PromptStep,
  type WorkingFile,
  type WorkflowViewAddress,
  type WorkflowRunNavigationSummary,
  type WorkflowKey,
} from "../types/CtrlYokeTypes";
import { PropertyResolver } from "../utils/PropertyResolver";
import { extractExtensionsFromGlobs } from "../utils/fileFilterUtils";
import { isPathWithinDirectory } from "../utils/PathSecurity";

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

export class WorkflowSerializer {
  private readonly lineageRepository = new WorkflowLineageRepository();

  constructor(
    private readonly postMessage: PostMessageFn,
    private readonly templateManager: TemplateManager,
    private readonly getManager: () => WorkflowOrchestrator | undefined,
    private readonly getOutputHistoryManager: () =>
      | OutputHistoryManager
      | undefined,
    private readonly workspaceState: vscode.Memento
  ) {}

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
      (left.kind === "draft" ||
        (right.kind === "run" && left.runRef === right.runRef))
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
    const workspaceRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : undefined;
    if (address && workspaceRoot) {
      return address.kind === "draft"
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

    const workspaceRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : undefined;
    const resolved = workspaceRoot
      ? path.resolve(workspaceRoot, filePath)
      : path.resolve(filePath);

    if (!workspaceRoot) {
      return resolved;
    }

    const root = path.resolve(workspaceRoot);
    const contained =
      process.platform === "win32"
        ? isPathWithinDirectory(resolved.toLowerCase(), root.toLowerCase())
        : isPathWithinDirectory(resolved, root);
    if (!contained || resolved === root) {
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
    const realContained =
      process.platform === "win32"
        ? isPathWithinDirectory(
            realAncestor.toLowerCase(),
            rootRealPath.toLowerCase()
          )
        : isPathWithinDirectory(realAncestor, rootRealPath);
    if (!realContained) {
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
    const repoRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : "";
    const defaultDir =
      this.workspaceState.get<string>(LAST_EXPORT_DIR_KEY) || repoRoot;

    try {
      const rawContent = await fs.readFile(workingFilePath, "utf-8");
      const workingFile = JSON.parse(rawContent);
      const workspaceRoot = vscode.workspace.workspaceFolders?.length
        ? getVsCodeWorkspaceRoot()
        : undefined;
      const descriptor = workspaceRoot
        ? await this.lineageRepository.readDescriptor(
            workspaceRoot,
            address.workflowKey
          )
        : undefined;

      let defaultPath: string;
      if (descriptor?.originalFile) {
        defaultPath = descriptor.originalFile;
      } else {
        const rawName =
          descriptor?.workflowName ||
          workingFile.workflowName ||
          path
            .basename(workingFilePath)
            .replace(/\.ctrlyoke\.(ya?ml|json)$/i, "");
        const name =
          rawName
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

      let title = "Save draft";
      if (address.kind === "run") {
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
          title = `Save run ${runId} — pending continuation`;
        } else {
          const date = summary
            ? new Date(summary.startedAt).toISOString().slice(0, 10)
            : "unknown date";
          title = `Save run ${runId} (${date})`;
        }
      }

      pm({
        type: MESSAGE_TYPES.SAVE_WORKFLOW_DIALOG_DATA,
        requestId,
        address,
        title,
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
    if (!this.getViewedWorkingFilePath(clientId, address)) {
      pm({
        type: MESSAGE_TYPES.SAVE_PATH_CHECKED,
        requestId,
        path: filePath,
        exists: false,
        error: "The viewed workflow changed.",
      });
      return;
    }
    try {
      const absolutePath = await this.resolveSafeExportPath(filePath);
      pm({
        type: MESSAGE_TYPES.SAVE_PATH_CHECKED,
        requestId,
        path: filePath,
        exists: await this.pathExists(absolutePath),
      });
    } catch (error) {
      pm({
        type: MESSAGE_TYPES.SAVE_PATH_CHECKED,
        requestId,
        path: filePath,
        exists: false,
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
    PROMPT_PROPERTIES.HARNESS,
    PROMPT_PROPERTIES.MODEL,
    PROMPT_PROPERTIES.AGENT,
    PROMPT_PROPERTIES.SKILLS,
    PROMPT_PROPERTIES.RESUME_SESSION,
    PROMPT_PROPERTIES.MCP_SERVERS,
    PROMPT_PROPERTIES.HOOKS,
    PROMPT_PROPERTIES.SESSION_ID,
    PROMPT_PROPERTIES.END_CONDITION,
    PROMPT_PROPERTIES.PRE_CONDITION,
    PROMPT_PROPERTIES.ERROR_BEHAVIOR,
    PROMPT_PROPERTIES.PRIOR_CONTEXT,
    PROMPT_PROPERTIES.ADDITIONAL_ARGS,
    PROMPT_PROPERTIES.TOOL_PERMISSIONS,
  ] as const;

  // PROMPT_FIELDS: per-step properties to preserve (covers both prompt steps
  // and script steps; fields absent from a step are silently skipped).
  private static readonly PROMPT_FIELDS = [
    PROMPT_PROPERTIES.NAME,
    PROMPT_PROPERTIES.ENABLED,
    PROMPT_PROPERTIES.STEP_TYPE,
    PROMPT_PROPERTIES.PROMPT,
    PROMPT_PROPERTIES.SCRIPT,
    PROMPT_PROPERTIES.TIMEOUT,
    PROMPT_PROPERTIES.ON_PASS,
    PROMPT_PROPERTIES.ON_FAIL,
    PROMPT_PROPERTIES.COMPARE_SOURCE,
    PROMPT_PROPERTIES.RETURNS,
    PROMPT_PROPERTIES.HARNESS,
    PROMPT_PROPERTIES.MODEL,
    PROMPT_PROPERTIES.AGENT,
    PROMPT_PROPERTIES.SKILLS,
    PROMPT_PROPERTIES.RESUME_SESSION,
    PROMPT_PROPERTIES.MCP_SERVERS,
    PROMPT_PROPERTIES.HOOKS,
    PROMPT_PROPERTIES.SESSION_ID,
    PROMPT_PROPERTIES.END_CONDITION,
    PROMPT_PROPERTIES.PRE_CONDITION,
    PROMPT_PROPERTIES.ERROR_BEHAVIOR,
    PROMPT_PROPERTIES.PRIOR_CONTEXT,
    PROMPT_PROPERTIES.ADDITIONAL_ARGS,
    PROMPT_PROPERTIES.TOOL_PERMISSIONS,
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
    const clean: Record<string, unknown> = {};

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
      clean.steps = workingFile.steps.map((p: Record<string, unknown>) => {
        const cleanPrompt: Record<string, unknown> = {};
        for (const field of WorkflowSerializer.PROMPT_FIELDS) {
          if (field in p) {
            cleanPrompt[field] = p[field];
          }
        }
        return cleanPrompt;
      });
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
    format: "yaml" | "json",
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
        "The viewed workflow changed before Save completed.",
        requestId
      );
      return;
    }

    try {
      const workingFile = await readJsonFile(workingFilePath);
      const clean = this.buildCleanWorkflow(workingFile);

      let absolutePath = await this.resolveSafeExportPath(filePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });

      let serialized: string;
      if (format === "yaml") {
        serialized = yaml.dump(clean, {
          lineWidth: -1,
          noRefs: true,
          quoteStyle: "double",
        });
      } else {
        serialized = JSON.stringify(clean, null, 2);
      }

      // Re-run the exact preflight immediately before the write. The dialog's
      // warning is advisory and may now be stale; this remains the authority.
      absolutePath = await this.resolveSafeExportPath(filePath);
      if (!this.getViewedWorkingFilePath(clientId, address)) {
        throw new Error("The viewed workflow changed before Save completed.");
      }
      await fs.writeFile(absolutePath, serialized, "utf-8");

      Log.debug(`Saved workflow to: ${absolutePath}`);

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
      });
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.error("Failed to save workflow:", error);
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

      const templatePath = await this.templateManager.saveWorkflowAsTemplate(
        name,
        scope,
        clean
      );

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
      Log.error("Failed to save workflow as template:", error);
      this.sendSaveFailure(pm, msg, requestId);
    }
  }

  // ============================================================================
  // Export Output
  // ============================================================================

  async handleExportOutput(content: string, fileName?: string): Promise<void> {
    try {
      let baseName = fileName || "ctrlyoke-output";
      baseName = baseName
        .replace(/\.ctrlyoke\.(ya?ml|json)$/i, "")
        .replace(/\.prompt\.md$/i, "");
      if (!baseName.endsWith(".md")) {
        baseName += ".md";
      }

      const workspaceRoot = vscode.workspace.workspaceFolders?.length
        ? getVsCodeWorkspaceRoot()
        : undefined;
      let defaultUri: vscode.Uri;
      if (workspaceRoot) {
        const outputDir = path.join(
          workspaceRoot,
          PATH_CONSTANTS.CTRLYOKE_DIR,
          "output"
        );
        await fs.mkdir(outputDir, { recursive: true });
        defaultUri = vscode.Uri.file(path.join(outputDir, baseName));
      } else {
        defaultUri = vscode.Uri.file(baseName);
      }

      Log.debug(
        `handleExportOutput: showing save dialog, defaultUri=${defaultUri.fsPath}, contentLength=${content.length}`
      );

      const uri = await vscode.window.showSaveDialog({
        defaultUri,
        filters: {
          "Markdown Files": ["md"],
          "Text Files": ["txt"],
          "All Files": ["*"],
        },
      });

      if (uri) {
        await fs.writeFile(uri.fsPath, content, "utf-8");
        vscode.window.showInformationMessage(
          `Output exported to ${uri.fsPath}`
        );
      } else {
        Log.debug("handleExportOutput: save dialog cancelled by user");
      }
    } catch (error) {
      const msg = getErrorMessage(error);
      Log.error("Failed to export output:", error);
      vscode.window.showErrorMessage(`Failed to export output: ${msg}`);
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

      pm({
        type: MESSAGE_TYPES.OPEN_NEW_WORKFLOW_MODAL,
        templates: this.toWireTemplates(templates),
        defaultTemplateId,
      });
    } catch (error) {
      const errorMsg = getErrorMessage(error);
      vscode.window.showErrorMessage(`Failed to load templates: ${errorMsg}`);
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
      Log.error("Failed to load template:", error);
    }
  }

  async handleSetDefaultTemplate(
    templateId: string,
    postMessage?: PostMessageFn
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    try {
      await ConfigurationUtils.setDefaultWorkflowTemplate(templateId);

      pm({
        type: MESSAGE_TYPES.DEFAULT_TEMPLATE_SET,
        templateId,
      });
    } catch (error) {
      Log.error("Failed to set default template:", error);
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
      vscode.window.showErrorMessage(`Failed to create workflow: ${errorMsg}`);
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
   * clients, unlike the Command Palette's `ctrlyoke.createNewTemplate` command
   * (which still uses QuickPick/InputBox — that command is desktop-only anyway).
   */
  async handleCreateCustomTemplate(
    name: string,
    scope: TemplateScope,
    postMessage?: PostMessageFn
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    try {
      const templatePath = await this.templateManager.createCustomTemplate(
        name,
        scope
      );

      // Best-effort editor convenience for desktop VS Code users; irrelevant to
      // (and safely ignored by) hosted browser clients.
      try {
        const doc = await vscode.workspace.openTextDocument(templatePath);
        await vscode.window.showTextDocument(doc);
      } catch (openError) {
        Log.warn(`Failed to open newly created template: ${openError}`);
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
   * Resolve a `showOpenDialog` result into a workspace-relative,
   * forward-slash-normalized path (portable across platforms and valid in
   * prompt file @path references). Returns undefined when the dialog was
   * cancelled. Shared by `handleBrowseTemplateFile` and
   * `handleBrowseSaveLocation` so the two native dialogs normalize identically.
   */
  private resolveDialogSelection(
    uris: vscode.Uri[] | undefined,
    workspaceRoot: string | undefined
  ): string | undefined {
    if (!uris || uris.length === 0) {
      return undefined;
    }
    let selectedPath = uris[0].fsPath;
    if (workspaceRoot && selectedPath.startsWith(workspaceRoot)) {
      selectedPath = selectedPath
        .slice(workspaceRoot.length)
        .replace(/^[\\/]/, "");
    }
    return selectedPath.replace(/\\/g, "/");
  }

  async handleBrowseTemplateFile(
    variable: string,
    fileFilter?: string[],
    postMessage?: PostMessageFn,
    selectFolder?: boolean
  ): Promise<void> {
    const pm = postMessage ?? this.postMessage;
    const workspaceRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : undefined;
    const filters: Record<string, string[]> = {};

    if (!selectFolder && fileFilter && fileFilter.length > 0) {
      const exts = extractExtensionsFromGlobs(fileFilter);
      if (exts.length > 0) {
        filters["Spec / Design Files"] = exts;
      }
    }
    if (!selectFolder) {
      filters["All Files"] = ["*"];
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFolders: !!selectFolder,
      canSelectFiles: !selectFolder,
      defaultUri: workspaceRoot ? vscode.Uri.file(workspaceRoot) : undefined,
      filters: selectFolder ? undefined : filters,
      title: selectFolder
        ? `Select folder for {${variable}}`
        : `Select file for {${variable}}`,
    });

    const filePath = this.resolveDialogSelection(uris, workspaceRoot);
    if (filePath !== undefined) {
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
    const workspaceRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : undefined;

    let defaultUri: vscode.Uri | undefined;
    if (defaultDir) {
      const absoluteDir =
        path.isAbsolute(defaultDir) || !workspaceRoot
          ? defaultDir
          : path.join(workspaceRoot, defaultDir);
      defaultUri = vscode.Uri.file(absoluteDir);
    } else if (workspaceRoot) {
      defaultUri = vscode.Uri.file(workspaceRoot);
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFolders: true,
      canSelectFiles: false,
      defaultUri,
      title: "Select Save Location",
    });

    const dirPath = this.resolveDialogSelection(uris, workspaceRoot);
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
      Log.error("WorkflowOrchestrator not initialized");
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
      const workspaceRoot = vscode.workspace.workspaceFolders?.length
        ? getVsCodeWorkspaceRoot()
        : undefined;
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
              ? { workflowKey, kind: "run", runRef: descriptor.latestRunRef }
              : { workflowKey, kind: "draft" };
          } catch (error) {
            Log.warn(
              `Failed to read lineage descriptor ${workflowKey}:`,
              error
            );
            return null;
          }

          const filePath =
            address.kind === "run"
              ? WorkflowPaths.runFilePath(
                  workspaceRoot,
                  address.workflowKey,
                  address.runRef
                )
              : WorkflowPaths.draftFilePath(workspaceRoot, address.workflowKey);

          try {
            const workingFile = (await readJsonFile(filePath)) as WorkingFile;
            const historyManager =
              this.getOutputHistoryManager() ??
              new OutputHistoryManager(workspaceRoot);
            const { runCount, primaryRunId } =
              await historyManager.getRunNavigationSummary(workflowKey);
            const hasDraft =
              !descriptor.latestRunRef ||
              descriptor.pendingEdit?.kind === "draft";
            const runNav: WorkflowRunNavigationSummary = {
              primaryAddress: address,
              primaryRunId,
              runCount,
              hasDraft,
            };

            const lastModified =
              workingFile.lastModifiedAt || workingFile.startedAt || 0;

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
              const isCli =
                (await manager?.ensureCliWatchSession(filePath)) ?? false;
              if (isCli) {
                Log.debug(
                  `[WorkflowSerializer] getRecentWorkflows: "${workflowKey}" has active CLI lock — keeping running state (CliWatchSession registered)`
                );
                // executionState stays "running"; the session is now in cliSessions
                // so the next GET_WORKFLOWS_LIST will move it to the Running section.
              } else {
                Log.debug(
                  `[WorkflowSerializer] getRecentWorkflows: normalizing "${workflowKey}" running→stopped (not in activeWorkingFilePaths: [${[...activeWorkingFilePaths].map((p) => path.basename(p)).join(", ") || "none"}])`
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
              workflowName: workingFile.workflowName || workflowKey,
              executionState,
              startedAt: workingFile.startedAt || 0,
              lastModifiedAt: lastModified,
              isFavorite: descriptor.isFavorite,
              totalSteps: steps.length,
              harness,
              runNav,
            };
          } catch (error) {
            Log.warn(`Failed to parse workflow file ${workflowKey}:`, error);
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
      Log.error("Failed to get recent workflows:", error);
      pm({
        type: MESSAGE_TYPES.RECENT_WORKFLOWS,
        workflows: [],
      });
    }
  }

  async handleLoadWorkflow(message: any): Promise<void> {
    const { filePath } = message;

    try {
      await this.getManager()?.loadWorkingFile(filePath);
    } catch (error) {
      Log.error("Failed to load workflow:", error);
      vscode.window.showErrorMessage(
        `Failed to load workflow: ${getErrorMessage(error)}`
      );
    }
  }

  async handleToggleFavorite(address: WorkflowViewAddress): Promise<void> {
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.length
        ? getVsCodeWorkspaceRoot()
        : undefined;
      if (!workspaceRoot) return;
      await this.lineageRepository.updateDescriptor(
        workspaceRoot,
        address.workflowKey,
        (descriptor) => ({ ...descriptor, isFavorite: !descriptor.isFavorite })
      );
    } catch (error) {
      Log.error("Failed to toggle workflow favorite:", error);
    }
  }

  async handleClearWorkflowHistory(
    postMessage?: PostMessageFn
  ): Promise<boolean> {
    const pm = postMessage ?? this.postMessage;
    const confirm = await vscode.window.showWarningMessage(
      "Delete all workflows and their history from .ctrlyoke/.runs?",
      { modal: true },
      "Delete All"
    );

    if (confirm !== "Delete All") {
      return false;
    }

    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.length
        ? getVsCodeWorkspaceRoot()
        : undefined;
      if (!workspaceRoot) {
        return false;
      }

      try {
        const workflowKeys =
          await this.lineageRepository.listLineageKeys(workspaceRoot);

        for (const workflowKey of workflowKeys) {
          await fs.rm(WorkflowPaths.lineageDir(workspaceRoot, workflowKey), {
            recursive: true,
            force: true,
          });
        }

        vscode.window.showInformationMessage(
          `Deleted ${workflowKeys.length} workflow lineage(s)`
        );

        pm({
          type: MESSAGE_TYPES.RECENT_WORKFLOWS,
          workflows: [],
        });
        return true;
      } catch (error) {
        Log.error("Failed to delete workflow files:", error);
        vscode.window.showErrorMessage(
          `Failed to delete workflow history: ${getErrorMessage(error)}`
        );
      }
    } catch (error) {
      Log.error("Failed to clear workflow history:", error);
    }
    return false;
  }

  /**
   * Handle REMOVE_WORKFLOW_HISTORY by deleting one addressed lineage directory.
   */
  async handleRemoveWorkflowHistory(
    address: WorkflowViewAddress
  ): Promise<void> {
    try {
      const workspaceRoot = vscode.workspace.workspaceFolders?.length
        ? getVsCodeWorkspaceRoot()
        : undefined;
      if (!workspaceRoot) {
        return;
      }

      await fs
        .rm(WorkflowPaths.lineageDir(workspaceRoot, address.workflowKey), {
          recursive: true,
          force: true,
        })
        .catch((err) =>
          Log.warn(
            `handleRemoveWorkflowHistory: failed to delete lineage ${address.workflowKey}:`,
            err
          )
        );

      Log.debug(
        `handleRemoveWorkflowHistory: removed lineage "${address.workflowKey}"`
      );
    } catch (error) {
      Log.error("Failed to remove workflow history entry:", error);
    }
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
