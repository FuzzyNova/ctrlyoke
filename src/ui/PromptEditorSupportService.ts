import * as path from "path";
import * as fs from "fs";
import { getErrorMessage } from "../utils/ErrorUtils";
import type {
  DashboardHostActions,
  FileWatcherFactory,
} from "../core/HostPorts";
import {
  ATOMIC_REFERENCE_KINDS,
  DASHBOARD_ACTION_RESULT_STATUSES,
  MESSAGE_TYPES,
  HARNESS_IDS,
  type HarnessId,
  PANEL_CLIENT_ID,
  MAX_PASTED_IMAGE_BYTES,
  mimeTypeToImageExtension,
  imageExtensionToMimeType,
  type AtomicReferenceKind,
  SETTING_SCOPES,
  type SettingWriteScope,
  PROMPT_FILE_RESOLUTION_STATUSES,
  REFERENCE_PATH_BASES,
  COMPLETION_TRIGGERS,
  WORKSPACE_ENTRY_KINDS,
  type WorkflowDocumentIssueSeverity,
} from "../types/DashboardConstants";
import { configService } from "../config/CtrlYokeConfigService";
import { CliProviderUtils } from "../core/harness/shared/CliProviderUtils";
import {
  getHarnessFlagCompletions,
  type HarnessFlagCompletion,
} from "../core/harness/shared/HarnessFlagCompletionProvider";
import { CopilotCliProvider } from "../core/harness/copilot/CopilotCliProvider";
import { ClaudeCliProvider } from "../core/harness/claude/ClaudeCliProvider";
import { CodexCliProvider } from "../core/harness/codex/CodexCliProvider";
import { OpenCodeCliProvider } from "../core/harness/opencode/OpenCodeCliProvider";
import { QwenCliProvider } from "../core/harness/qwen/QwenCliProvider";
import { AntigravityCliProvider } from "../core/harness/antigravity/AntigravityCliProvider";
import { TempFileManager } from "../utils/TempFileManager";
import {
  buildFileReferenceValue,
  buildPromptFileReferenceValue,
} from "../completions/ContextReferenceBuilder";
import { isPathWithinAnyDirectory } from "../utils/PathSecurity";
import { isValidLineRange } from "../utils/LineRangeUtils";
import { splitLines } from "../utils/TextLines";
import { evaluateFileAccess } from "../utils/FileAccessPolicy";
import { type FileOpenTarget } from "./ExternalFileTrustPrompt";
import { confirmExternalFileTrust } from "./ExternalRootsApproval";
import { NullUserInteractionPort } from "./UserInteractionPort";
import {
  resolveReferencePath,
  getTrustedSourceDefinitionDir,
  type ResolverWorkspaceFolder,
} from "../platform/WorkspaceRootResolver";
import {
  getLegacyRunHistoryReferenceGuidance,
  PromptFileResolver,
} from "../core/PromptFileResolver";
import { PromptFileWriter } from "../utils/PromptFileWriter";
import type {
  ContextReferenceValidationOptions,
  ContextReferenceValidationResult,
  IdentifiedContextReference,
} from "../utils/PromptDiagnosticRules";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import { runtimeTrustedRootRegistry } from "../utils/RuntimeTrustedRootRegistry";
import { getFrozenRunHistoryLocation } from "../utils/RunHistoryStoragePolicy";
import { projectStateRoot } from "../utils/ProjectStatePaths";
import { Log } from "../utils/Log";
import {
  type PlainCompletionItem,
  type CompletionCore,
} from "../completions/CompletionCore";
import { getCtrlYokeSlashCompletions } from "../completions/SlashTokenCompletionHelpers";
import { toViewerPath } from "../platform/WorkspaceViewerPath";
import { savePendingOutputSnapshot } from "./OutputSnapshotService";
import {
  getScriptCommandCompletions,
  parseScriptCompletionContext,
} from "../completions/ScriptCommandCompletionHelpers";
import {
  getPermissionListCompletions,
  parsePermissionCompletionContext,
} from "../completions/PermissionListCompletionHelpers";
import { getBranchCompletions } from "../completions/BranchCompletionHelpers";
import { getStashList, gitRefExists } from "../utils/GitUtils";
import { ContextExpander } from "../utils/ContextExpander";
import { decodePriorContextTokenRef } from "../utils/FileReferenceParser";
import { SkillDiscovery } from "../utils/SkillDiscovery";
import { encode } from "gpt-tokenizer";
import { PriorContextPreviewBuilder } from "../utils/PriorContextPreviewBuilder";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import { PromptFileParser } from "../core/PromptFileParser";
import type { CtrlYokeFileKind } from "../types/DashboardConstants";
import type { WorkflowStep } from "../types/CtrlYokeTypes";
import type { WebviewClientContext } from "./WebviewClientContext";
import type { SecretRegistryService } from "./SecretRegistryService";

interface CursorArgumentToken {
  prefix: string;
  replacementStart: number;
}

/**
 * Find the argument prefix at a cursor position using parseArgString's quote
 * and whitespace rules. Unlike parseArgString, this retains the replacement
 * offset needed by the editor.
 */
function parseCursorArgumentToken(
  text: string,
  position: number
): CursorArgumentToken {
  const cursor = Math.max(0, Math.min(position, text.length));
  let tokenStart = -1;
  let replacementStart = cursor;
  let current = "";
  let quote: '"' | "'" | undefined;
  let sawQuote = false;

  for (let i = 0; i < cursor; i++) {
    const ch = text[i];

    if (quote === '"') {
      if (ch === "\\" && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }

    if (quote === "'") {
      if (ch === "'") {
        quote = undefined;
      } else {
        current += ch;
      }
      continue;
    }

    if (/\s/.test(ch)) {
      tokenStart = -1;
      current = "";
      replacementStart = cursor;
      continue;
    }

    if (tokenStart === -1) {
      tokenStart = i;
      replacementStart = i;
    }

    if (ch === '"') {
      quote = '"';
      sawQuote = true;
      if (i === tokenStart) {
        replacementStart = i + 1;
      }
    } else if (ch === "'") {
      quote = "'";
      sawQuote = true;
      if (i === tokenStart) {
        replacementStart = i + 1;
      }
    } else {
      current += ch;
    }
  }

  const prefix = sawQuote ? current : text.slice(replacementStart, cursor);
  return { prefix, replacementStart };
}

function getHarnessHelpCommand(harnessId: HarnessId): string {
  switch (harnessId) {
    case HARNESS_IDS.COPILOT_CLI:
      return CopilotCliProvider.CLI_HELP_COMMAND;
    case HARNESS_IDS.CLAUDE_CLI:
      return ClaudeCliProvider.CLI_HELP_COMMAND;
    case HARNESS_IDS.CODEX_CLI:
      return CodexCliProvider.CLI_HELP_COMMAND;
    case HARNESS_IDS.OPENCODE_CLI:
      return OpenCodeCliProvider.CLI_HELP_COMMAND;
    case HARNESS_IDS.QWEN_CLI:
      return QwenCliProvider.CLI_HELP_COMMAND;
    case HARNESS_IDS.ANTIGRAVITY_CLI:
      return AntigravityCliProvider.CLI_HELP_COMMAND;
  }
}

function filterHarnessFlagCompletions(
  items: HarnessFlagCompletion[],
  prefix: string
): HarnessFlagCompletion[] {
  const normalizedPrefix = prefix.toLocaleLowerCase();
  return items.filter(
    (item) =>
      item.flag.toLocaleLowerCase().startsWith(normalizedPrefix) ||
      item.alias?.toLocaleLowerCase().startsWith(normalizedPrefix)
  );
}

/** What reference validation reads; positions in the text are not needed. */
type ContextReferenceToValidate = Omit<
  IdentifiedContextReference,
  "from" | "to"
>;

/**
 * Editor-support message handlers for the dashboard's CodeMirror prompt editor:
 * completions, reference validation, pasted-image storage, inline image
 * previews, file/prior-context opening, and attachment token counting.
 *
 * These handlers need nothing from `WebviewMessageRouter` beyond "which client
 * am I" (supplied per call as a {@link WebviewClientContext}), the workspace
 * root, and — for the prior-context paths only — the orchestrator. The dispatch
 * table itself stays in the router; entries there are thin delegations to this
 * service.
 */
export class PromptEditorSupportService {
  private readonly workflowTextValidator = new PromptFileParser();
  constructor(
    private readonly getWorkspaceRoot: () => string,
    private readonly getOrchestrator: () => WorkflowOrchestrator | undefined,
    /**
     * Resolve an absolute, workspace-contained image path to a URI the webview
     * can load in an `<img src>` (VS Code panel: `webview.asWebviewUri`).
     * Returns undefined for transports without a webview URI scheme.
     */
    private readonly resolveImageWebviewUri: (
      absolutePath: string
    ) => string | undefined,
    private readonly secretRegistry?: SecretRegistryService,
    private readonly hostActions?: Pick<
      DashboardHostActions,
      "openWorkspaceTarget" | "openContentPreview"
    >,
    private readonly getNamedRoots: () => readonly ResolverWorkspaceFolder[] = () => [],
    private readonly getTrustedRoots: () => readonly string[] = () => [],
    private readonly fileWatcherFactory?: FileWatcherFactory,
    private readonly completionCore?: CompletionCore
  ) {}

  validateWorkflowDocument(
    text: string,
    kind: CtrlYokeFileKind
  ): Array<{
    path: string;
    message: string;
    severity: WorkflowDocumentIssueSeverity;
    position?: { line: number; column: number };
  }> {
    return this.workflowTextValidator
      .validateWorkflowText(text, kind, ConfigurationUtils.getGlobalMaxSteps())
      .issues.map(({ instancePath, message, severity, position }) => ({
        path: instancePath,
        message,
        severity,
        position,
      }));
  }

  private getTrustedWorkspaceRoots(): string[] {
    return [
      ...this.getTrustedRoots(),
      ...(this.getWorkspaceRoot() ? [this.getWorkspaceRoot()] : []),
      ...runtimeTrustedRootRegistry.getRoots(),
    ];
  }

  private async openWorkspaceTarget(target: FileOpenTarget): Promise<void> {
    const result = await this.hostActions?.openWorkspaceTarget(target);
    if (
      !result ||
      result.status === DASHBOARD_ACTION_RESULT_STATUSES.UNSUPPORTED
    ) {
      throw new Error("Opening workspace targets is unavailable in this host.");
    }
    if (result.status === DASHBOARD_ACTION_RESULT_STATUSES.FAILED) {
      throw new Error(result.message);
    }
  }

  private getOwnStateRoots(workspaceRoot: string): string[] {
    return [projectStateRoot(workspaceRoot, getFrozenRunHistoryLocation())];
  }

  async handleCompletionRequest(
    ctx: WebviewClientContext,
    trigger: string,
    prefix: string,
    position: number,
    seq?: number
  ): Promise<void> {
    try {
      // Progressive `#` completion: emit the current editor selection(s)
      // immediately so the dropdown populates instantly, then follow up with
      // the full list once the (potentially slow, on large codebases)
      // workspace-symbol query resolves. Marked `partial` so the editor knows
      // a second, authoritative response is still coming.
      if (trigger === "#") {
        const selectionItems =
          this.completionCore?.getHashSelectionCompletions() ?? [];
        if (selectionItems.length > 0) {
          this.emitCompletionsResponse(
            ctx,
            selectionItems,
            position,
            seq,
            true
          );
        }
        const fullItems =
          (await this.completionCore?.getHashCompletions(
            prefix.substring(1)
          )) ?? [];
        this.emitCompletionsResponse(ctx, fullItems, position, seq, false);
        return;
      }

      const items = await this.getCompletionItems(trigger, prefix);
      this.emitCompletionsResponse(ctx, items, position, seq, false);
    } catch (error) {
      Log.trace("[Dashboard] Failed to get completions:", error);
      this.emitCompletionsResponse(ctx, [], position, seq, false);
    }
  }

  async handleScriptCompletionRequest(
    ctx: WebviewClientContext,
    text: string,
    position: number,
    seq: number
  ): Promise<void> {
    try {
      const namedRoots = this.getNamedRoots();
      const fallbackWorkspaceRoot =
        namedRoots.length === 0 ? this.getWorkspaceRoot() : undefined;
      const workspaceRoot =
        namedRoots.length > 0
          ? namedRoots
          : fallbackWorkspaceRoot
            ? [
                {
                  name: path.basename(fallbackWorkspaceRoot),
                  fsPath: fallbackWorkspaceRoot,
                },
              ]
            : [];
      const items = await getScriptCommandCompletions(
        workspaceRoot,
        text,
        position,
        this.fileWatcherFactory
      );
      const from = parseScriptCompletionContext(
        text,
        position
      ).replacementStart;
      ctx.emit({
        type: MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE,
        items,
        from,
        seq,
      });
    } catch (error) {
      Log.trace("[Dashboard] Failed to get script completions:", error);
      ctx.emit({
        type: MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE,
        items: [],
        from: position,
        seq,
      });
    }
  }

  async handleHarnessFlagCompletionRequest(
    ctx: WebviewClientContext,
    harnessId: HarnessId,
    text: string,
    position: number,
    seq: number
  ): Promise<void> {
    const token = parseCursorArgumentToken(text, position);
    try {
      const helpText = await CliProviderUtils.runHelpCommand(
        getHarnessHelpCommand(harnessId),
        { retryWindowsFileLockErrors: true }
      );
      const items = filterHarnessFlagCompletions(
        getHarnessFlagCompletions(harnessId, helpText),
        token.prefix
      );
      ctx.emit({
        type: MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_RESPONSE,
        items,
        from: token.replacementStart,
        seq,
      });
    } catch (error) {
      Log.trace("[Dashboard] Failed to get harness flag completions:", error);
      ctx.emit({
        type: MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_RESPONSE,
        items: [],
        from: token.replacementStart,
        seq,
      });
    }
  }

  async handlePermissionCompletionRequest(
    ctx: WebviewClientContext,
    text: string,
    position: number,
    seq: number
  ): Promise<void> {
    try {
      const items = getPermissionListCompletions(text, position);
      const from = parsePermissionCompletionContext(
        text,
        position
      ).replacementStart;
      ctx.emit({
        type: MESSAGE_TYPES.PERMISSION_COMPLETIONS_RESPONSE,
        items,
        from,
        seq,
      });
    } catch (error) {
      Log.error("[Dashboard] Failed to get permission completions:", error);
      ctx.emit({
        type: MESSAGE_TYPES.PERMISSION_COMPLETIONS_RESPONSE,
        items: [],
        from: position,
        seq,
      });
    }
  }

  async handleBranchListRequest(
    ctx: WebviewClientContext,
    filterText: string,
    seq: number
  ): Promise<void> {
    try {
      const repoRoot = this.getWorkspaceRoot() || undefined;
      const items = await getBranchCompletions(repoRoot, filterText);
      ctx.emit({
        type: MESSAGE_TYPES.BRANCH_LIST_RESPONSE,
        items,
        seq,
      });
    } catch (error) {
      Log.trace("[Dashboard] Failed to get branch completions:", error);
      ctx.emit({
        type: MESSAGE_TYPES.BRANCH_LIST_RESPONSE,
        items: [],
        seq,
      });
    }
  }

  private emitCompletionsResponse(
    ctx: WebviewClientContext,
    items: PlainCompletionItem[],
    position: number,
    seq: number | undefined,
    partial: boolean
  ): void {
    Log.trace(
      `[Dashboard] Completion response: position=${position}, partial=${partial} ${items.length} items`
    );

    ctx.emit({
      type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
      items: items.map((item) => ({
        label: item.label,
        kind: item.kind,
        insertText: item.insertText,
        detail: item.detail,
        documentation: item.documentation,
        sortText: item.sortText,
        filterText: item.filterText,
        rank: item.rank,
        captureId: item.captureId,
        icon: item.icon,
      })),
      from: position,
      seq,
      partial,
    });
  }

  /**
   * Get completion items based on trigger (@file, #file, or path)
   */
  private async getCompletionItems(
    trigger: string,
    prefix: string
  ): Promise<any[]> {
    if (trigger === "/") {
      return await getCtrlYokeSlashCompletions(this.getWorkspaceRoot(), prefix);
    } else if (trigger === "@") {
      return this.completionCore?.getFileCompletions(prefix.substring(1)) ?? []; // Remove @
    } else if (trigger === "#") {
      return this.completionCore?.getHashCompletions(prefix.substring(1)) ?? []; // Remove #
    } else if (trigger === "~") {
      const workspaceRoot = this.getWorkspaceRoot();
      return (
        this.completionCore?.getGitChangeCompletions(
          workspaceRoot,
          prefix.substring(1)
        ) ?? []
      ); // Remove ~
    } else if (trigger === "$") {
      return (
        this.completionCore?.getPriorContextCompletions(prefix.substring(1)) ??
        []
      ); // Remove $
    } else if (trigger === "!") {
      if (!this.getWorkspaceRoot() || !this.secretRegistry) {
        return [];
      }
      const names = await this.secretRegistry.getCompletionNames();
      return (
        this.completionCore?.getSecretCompletions(names, prefix.substring(1)) ??
        []
      );
    } else if (trigger === COMPLETION_TRIGGERS.PATH) {
      return this.completionCore?.getPromptFileCompletions(prefix) ?? [];
    }

    Log.warn(`[Dashboard] Unknown trigger: "${trigger}"`);
    return [];
  }

  /**
   * Validate whether a file-ref path typed in the prompt editor resolves to
   * an actual readable file. The source directory comes from the addressed
   * lineage descriptor, never from the run-storage working copy.
   */
  async handleFileRefValidation(
    ctx: WebviewClientContext,
    filePath: string,
    seq?: number,
    _address?: unknown
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot() || null;
    const trustedRoots = workspaceRoot
      ? this.getTrustedWorkspaceRoots()
      : undefined;
    const workspaceIdentity = workspaceRoot
      ? ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot)
      : undefined;
    const ownStateRoots = workspaceRoot
      ? this.getOwnStateRoots(workspaceRoot)
      : undefined;
    const resolver = new PromptFileResolver({
      workspaceRoot: workspaceRoot ?? undefined,
      namedRoots: workspaceRoot ? this.getNamedRoots() : [],
      trustedRoots,
      ownStateRoots,
      approvedExternalRoots: workspaceIdentity
        ? ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
            workspaceIdentity
          )
        : undefined,
    });
    const sourceDefinitionPath =
      await this.getOrchestrator()?.getViewSourceDefinitionPath(ctx.clientId);
    const resolution = await resolver.resolve(
      filePath.trim(),
      sourceDefinitionPath ?? undefined
    );

    ctx.emit({
      type: MESSAGE_TYPES.FILE_REF_VALIDATION,
      seq,
      filePath,
      exists:
        resolution.status === PROMPT_FILE_RESOLUTION_STATUSES.RESOLVED ||
        resolution.status === PROMPT_FILE_RESOLUTION_STATUSES.EMPTY,
      isEmpty: resolution.status === PROMPT_FILE_RESOLUTION_STATUSES.EMPTY,
      resolvedPath:
        resolution.status === PROMPT_FILE_RESOLUTION_STATUSES.RESOLVED ||
        resolution.status === PROMPT_FILE_RESOLUTION_STATUSES.EMPTY
          ? resolution.path
          : undefined,
    });
  }

  async handleConvertPromptToFile(
    ctx: WebviewClientContext,
    message: {
      seq?: number;
      text?: string;
      suggestedName?: string;
    }
  ): Promise<void> {
    const { seq } = message;
    try {
      const workspaceRoot = this.getWorkspaceRoot();
      if (!workspaceRoot) {
        throw new Error("No workspace folder open");
      }
      if (typeof message.text !== "string") {
        throw new Error("Missing prompt text");
      }

      const result = await new PromptFileWriter(workspaceRoot).createPromptFile(
        message.text,
        message.suggestedName
      );
      ctx.emit({
        type: MESSAGE_TYPES.PROMPT_FILE_CREATED,
        seq,
        reference: buildPromptFileReferenceValue(
          path.posix.join(
            PATH_CONSTANTS.CTRLYOKE_DIR,
            PATH_CONSTANTS.PROMPTS_DIR,
            result.fileName
          )
        ),
        resolvedPath: result.filePath,
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      Log.error(
        `[PromptEditorSupportService] Failed to create prompt file: ${errorMessage}`
      );
      ctx.emit({
        type: MESSAGE_TYPES.PROMPT_FILE_CREATED,
        seq,
        reference: undefined,
        resolvedPath: undefined,
        error: errorMessage,
      });
    }
  }

  async handleOpenPromptFile(
    ctx: WebviewClientContext,
    filePath: string
  ): Promise<void> {
    try {
      const workspaceRoot = this.getWorkspaceRoot();
      if (!workspaceRoot) {
        throw new Error("No workspace folder open");
      }
      const ownStateRoots = this.getOwnStateRoots(workspaceRoot);
      const resolver = new PromptFileResolver({
        workspaceRoot,
        namedRoots: this.getNamedRoots(),
        trustedRoots: this.getTrustedWorkspaceRoots(),
        ownStateRoots,
        approvedExternalRoots:
          ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
            ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot)
          ),
      });
      const resolution = await resolver.resolve(filePath.trim());
      if (
        resolution.status !== PROMPT_FILE_RESOLUTION_STATUSES.RESOLVED &&
        resolution.status !== PROMPT_FILE_RESOLUTION_STATUSES.EMPTY
      ) {
        throw new Error(`Prompt file could not be found: ${filePath}`);
      }

      const resolvedPath = await fs.promises.realpath(resolution.path);
      const trustedRoots = this.getTrustedWorkspaceRoots();
      const workspaceIdentity =
        ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
      const approvedExternalRoots =
        ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
          workspaceIdentity
        );
      const target: FileOpenTarget = {
        path: resolvedPath,
        openAsText: true,
        viewColumn: ConfigurationUtils.shouldOpenPromptsInSecondGroup()
          ? 2
          : undefined,
      };
      const decision = evaluateFileAccess(resolvedPath, {
        workspaceRoots: trustedRoots,
        ownStateRoots,
        approvedExternalRoots,
      });
      if (!decision.allowed) {
        const approved = await confirmExternalFileTrust(target.path, {
          port: ctx.interactionPort ?? new NullUserInteractionPort(),
          workspaceRoot,
          workflowSourcePath:
            (await this.getOrchestrator()?.getViewSourceDefinitionPath(
              ctx.clientId
            )) ?? undefined,
          onWorkflowRootsUpdated: async (roots) => {
            await this.getOrchestrator()?.updateWorkflowTrustedExternalRootsForClient(
              ctx.clientId,
              roots
            );
          },
        });
        if (approved) await this.openWorkspaceTarget(target);
        return;
      }
      await this.openWorkspaceTarget(target);
    } catch (error) {
      Log.error(
        "[PromptEditorSupportService] Error opening prompt file:",
        error
      );
      ctx.emit({
        type: MESSAGE_TYPES.WORKFLOW_ACTION_FAILED,
        action: "open prompt file",
        error: `Failed to open: ${filePath}`,
      });
    }
  }

  private getTempFileManager(): TempFileManager {
    return new TempFileManager(this.getWorkspaceRoot());
  }

  /**
   * Save a pasted clipboard image to disk and reply with the workspace-relative
   * `@`-reference the editor should insert. Every paste — saved workflow or new
   * unsaved prompt — lands in the flat, content-addressed `.ctrlyoke/attachments/`
   * store, so identical images dedup across all workflows (see
   * TempFileManager.getAttachmentsDir / createPastedImageFile).
   */
  async handleSavePastedImage(
    ctx: WebviewClientContext,
    message: {
      seq?: number;
      dataBase64?: string;
      mimeType?: string;
    }
  ): Promise<void> {
    const { seq } = message;
    try {
      const workspaceRoot = this.getWorkspaceRoot();
      if (!workspaceRoot) {
        throw new Error("No workspace folder open");
      }

      const extension = mimeTypeToImageExtension(message.mimeType);
      if (!extension) {
        throw new Error(
          `Unsupported image type: ${message.mimeType ?? "unknown"}`
        );
      }
      if (!message.dataBase64) {
        throw new Error("Missing pasted image data");
      }

      const buffer = Buffer.from(message.dataBase64, "base64");
      if (buffer.length === 0) {
        throw new Error("Pasted image is empty");
      }
      if (buffer.length > MAX_PASTED_IMAGE_BYTES) {
        throw new Error("Pasted image exceeds the maximum allowed size");
      }

      const tempFileManager = this.getTempFileManager();
      const absolutePath = await tempFileManager.createPastedImageFile(
        buffer,
        extension,
        tempFileManager.getAttachmentsDir()
      );
      const relativePath = buildFileReferenceValue(
        tempFileManager.getRelativePath(absolutePath)
      );

      ctx.emit({
        type: MESSAGE_TYPES.PASTED_IMAGE_SAVED,
        seq,
        relativePath,
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      Log.error(
        `[PromptEditorSupportService] Failed to save pasted image: ${errorMessage}`
      );
      ctx.emit({
        type: MESSAGE_TYPES.PASTED_IMAGE_SAVED,
        seq,
        error: errorMessage,
      });
    }
  }

  /** Save a pending output capture and reply with the workspace-relative reference. */
  async handleSaveOutputSnapshot(
    ctx: WebviewClientContext,
    message: { seq?: number; captureId?: string }
  ): Promise<void> {
    const { seq } = message;
    try {
      if (!message.captureId) {
        throw new Error("Missing output capture id");
      }

      const relativePath = await savePendingOutputSnapshot(
        this.getWorkspaceRoot,
        message.captureId
      );

      ctx.emit({
        type: MESSAGE_TYPES.OUTPUT_SNAPSHOT_SAVED,
        seq,
        relativePath,
      });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      Log.error(
        `[PromptEditorSupportService] Failed to save output snapshot: ${errorMessage}`
      );
      ctx.emit({
        type: MESSAGE_TYPES.OUTPUT_SNAPSHOT_SAVED,
        seq,
        error: errorMessage,
      });
    }
  }

  /**
   * Resolve a workspace image path to a displayable URI for an inline thumbnail.
   * Any image anywhere in an open workspace folder is previewable — not just
   * pasted images under `.ctrlyoke/` — so a harness that references an existing
   * repo image (`docs/diagram.png`, `root2/assets/logo.webp`, …) gets a thumbnail
   * too. The path is resolved with the same multi-root logic as `@`-references
   * (`resolveReferencePath` + trusted-root containment), so folder-name
   * prefixes and every folder of a multi-root `.code-workspace` are honored, and
   * any path that escapes every trusted root returns an error so the webview
   * falls back to a plain file-ref rather than leaking arbitrary filesystem
   * paths as images.
   *
   * Transport-aware, so both the VS Code panel and the hosted browser dashboard
   * render thumbnails:
   * - **Panel** → a lightweight `vscode-webview://` resource URI via
   *   `asWebviewUri` (streams from disk, no payload bloat). Every workspace
   *   folder is on `localResourceRoots` (see `getImageResourceRoots`), so the
   *   panel can load a resolved image from anywhere in the workspace.
   * - **Hosted browser** (and panel fallback) → an inline `data:` URI, since a
   *   browser can't load a `vscode-webview://` URI. Both webview CSPs already
   *   allow `img-src data:`.
   */
  async handleFilePreviewUriRequest(
    ctx: WebviewClientContext,
    message: {
      seq?: number;
      relativePath?: string;
    }
  ): Promise<void> {
    const { seq } = message;
    const fail = (error: string): void => {
      ctx.emit({
        type: MESSAGE_TYPES.FILE_PREVIEW_URI_RESPONSE,
        seq,
        error,
      });
    };
    const succeed = (uri: string): void => {
      ctx.emit({
        type: MESSAGE_TYPES.FILE_PREVIEW_URI_RESPONSE,
        seq,
        uri,
      });
    };

    try {
      const workspaceRoot = this.getWorkspaceRoot();
      if (!workspaceRoot) {
        return fail("No workspace folder open");
      }
      if (!message.relativePath) {
        return fail("Missing image path");
      }

      const trustedRoots = this.getTrustedWorkspaceRoots();
      const sourceDefinitionDir = await this.getViewSourceDefinitionDir(
        ctx,
        trustedRoots
      );
      const resolved = resolveReferencePath(message.relativePath, {
        primaryRoot: workspaceRoot,
        namedRoots: this.getNamedRoots(),
        sourceDefinitionDir,
      }).absolutePath;
      if (!isPathWithinAnyDirectory(resolved, trustedRoots)) {
        return fail("Image is not inside an open workspace folder");
      }

      try {
        await fs.promises.access(resolved);
      } catch {
        return fail("Image file no longer exists");
      }

      // Only ever hand back an allowed image type, regardless of transport —
      // the webview requests previews only for image-extension paths, but this
      // is the host-side gate that keeps a non-image workspace file from being
      // surfaced as a thumbnail URI.
      const extension = path.extname(resolved).replace(/^\./, "");
      const mimeType = imageExtensionToMimeType(extension);
      if (!mimeType) {
        return fail("Unsupported image type for inline preview");
      }

      // Panel: prefer the lightweight webview-resource URI.
      if (ctx.clientId === PANEL_CLIENT_ID) {
        const uri = this.resolveImageWebviewUri(resolved);
        if (uri) {
          return succeed(uri);
        }
        // Panel view unavailable (e.g. not resolved yet) — fall through to a
        // data URI, which the panel CSP also permits.
      }

      // Hosted browser (and panel fallback): serve an inline data URI.
      const stats = await fs.promises.stat(resolved);
      if (stats.size > MAX_PASTED_IMAGE_BYTES) {
        return fail("Image is too large to preview inline");
      }
      const bytes = await fs.promises.readFile(resolved);
      return succeed(`data:${mimeType};base64,${bytes.toString("base64")}`);
    } catch (error) {
      fail(getErrorMessage(error));
    }
  }

  async handleContextRefsValidation(
    ctx: WebviewClientContext,
    references: ContextReferenceToValidate[],
    seq?: number
  ): Promise<void> {
    const sourceDefinitionDir = await this.getViewSourceDefinitionDir(
      ctx,
      this.getWorkspaceRoot() ? this.getTrustedWorkspaceRoots() : undefined
    );
    // The dashboard's reference chips show the symbol's kind icon.
    const results = await this.resolveContextReferences(
      references,
      sourceDefinitionDir,
      { resolveSymbolKind: true }
    );

    ctx.emit({
      type: MESSAGE_TYPES.CONTEXT_REFS_VALIDATION,
      results,
      seq,
    });
  }

  /**
   * Validate references for a host that has no webview client (the VS Code
   * diagnostics provider). `sourceDefinitionPath` is the document the text
   * lives in, so `./` references resolve against it when it is trusted.
   */
  validateContextReferences(
    references: IdentifiedContextReference[],
    sourceDefinitionPath: string | undefined,
    options: ContextReferenceValidationOptions
  ): Promise<ContextReferenceValidationResult[]> {
    return this.resolveContextReferences(
      references,
      getTrustedSourceDefinitionDir(
        sourceDefinitionPath,
        this.getWorkspaceRoot() ? this.getTrustedWorkspaceRoots() : undefined
      ),
      options
    );
  }

  private resolveContextReferences(
    references: readonly ContextReferenceToValidate[],
    sourceDefinitionDir: string | undefined,
    options: ContextReferenceValidationOptions
  ): Promise<ContextReferenceValidationResult[]> {
    const workspaceRoot = this.getWorkspaceRoot() || null;
    const namedRoots = [...this.getNamedRoots()];
    return Promise.all(
      references.map(async (reference) => ({
        id: reference.id,
        ...(await this.validateContextReference(
          reference,
          workspaceRoot,
          namedRoots,
          sourceDefinitionDir,
          options
        )),
      }))
    );
  }

  private async validateContextReference(
    reference: {
      type: AtomicReferenceKind;
      path?: string;
      gitRef?: string;
      lineStart?: string;
      lineEnd?: string;
      symbolName?: string;
      secretName?: string;
    },
    workspaceRoot: string | null,
    namedRoots: readonly ResolverWorkspaceFolder[],
    sourceDefinitionDir: string | undefined,
    options: ContextReferenceValidationOptions
  ): Promise<{
    exists: boolean;
    message?: string;
    symbolKind?: number;
    suggestions?: string[];
  }> {
    if (reference.type === ATOMIC_REFERENCE_KINDS.SECRET) {
      const name = reference.secretName ?? "";
      const exists =
        !!this.secretRegistry && (await this.secretRegistry.isResolvable(name));
      return exists
        ? { exists: true }
        : { exists: false, message: "secret not found" };
    }

    if (reference.type === ATOMIC_REFERENCE_KINDS.GIT) {
      return this.validateGitContextReference(reference.gitRef, workspaceRoot);
    }

    if (!reference.path) {
      return { exists: false, message: "context not found" };
    }

    const pathValidation = await this.resolveContextReferencePath(
      reference.path,
      workspaceRoot,
      namedRoots,
      sourceDefinitionDir
    );

    if (!pathValidation.exists || !pathValidation.resolvedPath) {
      if (pathValidation.message) {
        return { exists: false, message: pathValidation.message };
      }
      // Type-agnostic exit (nothing exists on disk at the typed path), so word
      // the message by reference type — a missing directory ref reads "file not
      // found" otherwise. file/lineRange/symbol all point at a file, so they
      // keep "file not found".
      const message =
        reference.type === ATOMIC_REFERENCE_KINDS.DIRECTORY
          ? "directory not found"
          : "file not found";
      return this.notFoundWithSuggestions(reference, message);
    }

    if (reference.type === ATOMIC_REFERENCE_KINDS.DIRECTORY) {
      return pathValidation.isDirectory
        ? { exists: true }
        : this.notFoundWithSuggestions(reference, "directory not found");
    }

    if (!pathValidation.isFile) {
      return this.notFoundWithSuggestions(reference, "file not found");
    }

    if (
      reference.type === ATOMIC_REFERENCE_KINDS.LINE_RANGE ||
      reference.type === ATOMIC_REFERENCE_KINDS.SYMBOL
    ) {
      const startLine = Number.parseInt(reference.lineStart ?? "", 10);
      const endLine = Number.parseInt(reference.lineEnd ?? "", 10);
      const missingSymbolName =
        reference.type === ATOMIC_REFERENCE_KINDS.SYMBOL &&
        !reference.symbolName;
      if (
        missingSymbolName ||
        !isValidLineRange(startLine, endLine, Number.MAX_SAFE_INTEGER)
      ) {
        return {
          exists: false,
          message:
            reference.type === ATOMIC_REFERENCE_KINDS.SYMBOL
              ? "symbol not found"
              : "selection not found",
        };
      }

      try {
        const documentText = await fs.promises.readFile(
          pathValidation.resolvedPath,
          "utf8"
        );
        const lineCount = splitLines(documentText).length;
        if (!isValidLineRange(startLine, endLine, lineCount)) {
          return {
            exists: false,
            message:
              reference.type === ATOMIC_REFERENCE_KINDS.SYMBOL
                ? "symbol not found"
                : "selection not found",
          };
        }
        if (
          options.resolveSymbolKind &&
          reference.type === ATOMIC_REFERENCE_KINDS.SYMBOL &&
          reference.symbolName
        ) {
          // Best-effort: the reference text itself carries no kind, only a
          // live completion item does. A miss here (renamed/moved symbol,
          // no provider) just leaves the icon at its generic fallback.
          const workspaceRoot = this.getWorkspaceRoot();
          const viewerPath = workspaceRoot
            ? toViewerPath(pathValidation.resolvedPath, {
                primaryRoot: workspaceRoot,
                namedRoots: this.getNamedRoots(),
              })
            : pathValidation.resolvedPath;
          const symbolKind =
            await this.completionCore?.findSymbolKindForReference(
              viewerPath,
              reference.symbolName,
              startLine,
              endLine
            );
          return symbolKind === undefined
            ? { exists: true }
            : { exists: true, symbolKind };
        }
        return { exists: true };
      } catch {
        return {
          exists: false,
          message:
            reference.type === ATOMIC_REFERENCE_KINDS.SYMBOL
              ? "symbol not found"
              : "selection not found",
        };
      }
    }

    return { exists: true };
  }

  /**
   * Build a not-found validation result, attaching "did you mean?" path
   * suggestions for @file / @directory references so the editor can offer
   * one-click lint quick-fixes (see getPathSuggestions). Only file/directory
   * refs get suggestions — for symbol/lineRange the file usually resolves and
   * it's the symbol/line-range that's wrong, which a path swap can't fix.
   */
  private async notFoundWithSuggestions(
    reference: { type: string; path?: string },
    message: string
  ): Promise<{ exists: false; message: string; suggestions?: string[] }> {
    if (
      reference.path &&
      (reference.type === ATOMIC_REFERENCE_KINDS.FILE ||
        reference.type === ATOMIC_REFERENCE_KINDS.DIRECTORY)
    ) {
      const suggestions =
        (await this.completionCore?.getPathSuggestions(
          reference.path,
          reference.type === ATOMIC_REFERENCE_KINDS.DIRECTORY
            ? WORKSPACE_ENTRY_KINDS.DIRECTORY
            : WORKSPACE_ENTRY_KINDS.FILE
        )) ?? [];
      if (suggestions.length > 0) {
        return { exists: false, message, suggestions };
      }
    }
    return { exists: false, message };
  }

  private async resolveContextReferencePath(
    filePath: string,
    workspaceRoot: string | null,
    namedRoots: readonly ResolverWorkspaceFolder[],
    sourceDefinitionDir?: string
  ): Promise<{
    exists: boolean;
    resolvedPath?: string;
    isFile?: boolean;
    isDirectory?: boolean;
    message?: string;
  }> {
    if (!workspaceRoot) {
      return { exists: false };
    }

    let resolution;
    try {
      resolution = resolveReferencePath(filePath, {
        primaryRoot: workspaceRoot,
        namedRoots,
        sourceDefinitionDir,
      });
    } catch (error) {
      return { exists: false, message: getErrorMessage(error) };
    }

    const candidates = [resolution.absolutePath];
    if (resolution.base === REFERENCE_PATH_BASES.WORKSPACE) {
      candidates.push(
        resolveReferencePath(
          path.join(
            PATH_CONSTANTS.CTRLYOKE_DIR,
            filePath.replace(/^\.\.?[\\/]/, "")
          ),
          { primaryRoot: workspaceRoot, namedRoots }
        ).absolutePath
      );
    }

    for (const candidate of candidates) {
      try {
        const stat = await fs.promises.stat(candidate);
        return {
          exists: true,
          resolvedPath: candidate,
          isFile: stat.isFile(),
          isDirectory: stat.isDirectory(),
        };
      } catch {
        // try next candidate
      }
    }

    return {
      exists: false,
      message: getLegacyRunHistoryReferenceGuidance(filePath),
    };
  }

  private async validateGitContextReference(
    gitRef: string | undefined,
    workspaceRoot: string | null
  ): Promise<{ exists: boolean; message?: string }> {
    if (!gitRef || !workspaceRoot) {
      return { exists: false, message: "git context not found" };
    }

    const stashMatch = gitRef.match(/^stash:(\d+)$/);
    if (stashMatch) {
      try {
        const stashes = await getStashList(workspaceRoot);
        const stashIndex = Number.parseInt(stashMatch[1], 10);
        return stashes.some((stash) => stash.index === stashIndex)
          ? { exists: true }
          : { exists: false, message: "stash not found" };
      } catch {
        return { exists: false, message: "git context not found" };
      }
    }

    return gitRefExists(workspaceRoot, gitRef);
  }

  async handleOpenFile(
    ctx: WebviewClientContext,
    relativePath: string,
    lineStart?: number,
    lineEnd?: number
  ): Promise<void> {
    try {
      const workspaceRoot = this.getWorkspaceRoot();
      if (!workspaceRoot) {
        Log.warn("[PromptEditorSupportService] No workspace folder open");
        return;
      }
      const trustedRoots = this.getTrustedWorkspaceRoots();
      const namedRoots = this.getNamedRoots();
      const sourceDefinitionDir = await this.getViewSourceDefinitionDir(
        ctx,
        trustedRoots
      );

      const normalizeCodexAbsPath = (rawPath: string): string => {
        const pathWithDrive = rawPath.match(/^\/abs\/path\/([A-Za-z]:)(\/.*)$/);
        if (pathWithDrive) {
          return `${pathWithDrive[1].toUpperCase()}${pathWithDrive[2]}`;
        }

        const slashDrivePath = rawPath.match(/^\/([A-Za-z]:)(\/.*)$/);
        if (slashDrivePath) {
          return `${slashDrivePath[1].toUpperCase()}${slashDrivePath[2]}`;
        }

        return rawPath;
      };

      const normalizedPath = normalizeCodexAbsPath(
        relativePath.replace(/\\/g, "/")
      );
      const isDirectory = normalizedPath.endsWith("/");
      const trimmedPath = isDirectory
        ? normalizedPath.replace(/\/+$/, "")
        : normalizedPath;

      const resolvedFsPath = resolveReferencePath(trimmedPath, {
        primaryRoot: workspaceRoot,
        namedRoots,
        sourceDefinitionDir,
      }).absolutePath;

      const workspaceIdentity =
        ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
      const ownStateRoots = this.getOwnStateRoots(workspaceRoot);
      const approvedExternalRoots =
        ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
          workspaceIdentity
        );
      const decision = evaluateFileAccess(resolvedFsPath, {
        workspaceRoots: trustedRoots,
        ownStateRoots,
        approvedExternalRoots,
      });
      const target: FileOpenTarget = {
        path: resolvedFsPath,
        isDirectory,
        startLine: lineStart,
        endLine: lineEnd,
      };

      if (!decision.allowed) {
        Log.warn(
          `[PromptEditorSupportService] Blocked dashboard request to open path outside every trusted root: ${relativePath}`
        );
        const approved = await confirmExternalFileTrust(target.path, {
          port: ctx.interactionPort ?? new NullUserInteractionPort(),
          workspaceRoot,
          workflowSourcePath:
            (await this.getOrchestrator()?.getViewSourceDefinitionPath(
              ctx.clientId
            )) ?? undefined,
          onWorkflowRootsUpdated: async (roots) => {
            await this.getOrchestrator()?.updateWorkflowTrustedExternalRootsForClient(
              ctx.clientId,
              roots
            );
          },
        });
        if (approved) await this.openWorkspaceTarget(target);
        return;
      }

      await this.openWorkspaceTarget(target);
    } catch (error) {
      Log.error("[PromptEditorSupportService] Error opening file:", error);
      ctx.emit({
        type: MESSAGE_TYPES.WORKFLOW_ACTION_FAILED,
        action: "open file",
        error: `Failed to open: ${relativePath}`,
      });
    }
  }

  /**
   * Open the user- or workspace-scope settings.json directly, bypassing the
   * external-root trust prompt — same rationale as {@link handleOpenSkill}:
   * both paths come from ctrlyoke's own config service, never from
   * user-controlled input, so there's nothing to prompt-trust.
   */
  async handleOpenSettingsFile(
    _ctx: WebviewClientContext,
    scope: SettingWriteScope
  ): Promise<void> {
    const filePath =
      scope === SETTING_SCOPES.WORKSPACE
        ? configService.getWorkspaceFilePath()
        : configService.getUserFilePath();
    if (!filePath) {
      Log.warn(
        `[PromptEditorSupportService] No settings file available to open for scope: ${scope}`
      );
      return;
    }
    await this.openWorkspaceTarget({ path: filePath });
  }

  async handleOpenSkill(
    _ctx: WebviewClientContext,
    skillName: string
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot();
    const skills = await SkillDiscovery.discoverSkills(workspaceRoot);
    const skill = SkillDiscovery.resolveCtrlYokeSkillInvocation(
      skills,
      skillName
    );
    if (!skill) {
      Log.warn(
        `[PromptEditorSupportService] Unable to resolve ctrlyoke skill link: ${skillName}`
      );
      return;
    }

    await this.openWorkspaceTarget({ path: skill.path });
  }

  /** Build the prior-context XML preview without opening it in an editor. */
  async buildPriorContextContent(
    ctx: WebviewClientContext,
    ref: string,
    stepCount: number
  ): Promise<string> {
    if (!ref) return "";
    const orchestrator = this.getOrchestrator();
    const workingFilePath = orchestrator?.getQueueState(
      ctx.clientId
    )?.workingFilePath;
    if (workingFilePath && fs.existsSync(workingFilePath)) {
      try {
        const raw = fs.readFileSync(workingFilePath, "utf-8");
        const workingFile = JSON.parse(raw) as { steps?: unknown[] };
        const steps = (workingFile.steps ?? []) as WorkflowStep[];
        const address =
          WorkflowPaths.parseWorkingFileAddressFromPath(workingFilePath);
        if (!address?.runRef) {
          return `<!-- $${ref}: no executed run output is available for this draft -->`;
        }
        const outputHistoryManager = orchestrator.getOutputHistoryManager();
        return await PriorContextPreviewBuilder.buildPreview(
          ref,
          stepCount,
          steps,
          outputHistoryManager.getRunOutputResolver(),
          outputHistoryManager.getHistoryFilePath(
            address.workflowKey,
            address.runRef
          ),
          orchestrator.getPriorContextProjectionOptions()
        );
      } catch {
        return `<!-- Could not read workflow state for $${ref} -->`;
      }
    }
    return `<!-- No active workflow — $${ref} will be resolved at execution time -->`;
  }

  /**
   * Open an untitled XML preview showing the exact <priorContext> block that
   * a $prior-context ref will expand to when the prompt runs.
   * Uses the same buildPriorContextXmlFromItems codepath as live harness injection.
   */
  async handleOpenPriorContext(
    ctx: WebviewClientContext,
    ref: string,
    stepCount: number
  ): Promise<void> {
    if (!ref) return;
    const content = await this.buildPriorContextContent(ctx, ref, stepCount);

    try {
      const result = await this.hostActions?.openContentPreview?.({
        content,
        language: "xml",
      });
      if (
        !result ||
        result.status !== DASHBOARD_ACTION_RESULT_STATUSES.OPENED
      ) {
        throw new Error(
          result?.status === DASHBOARD_ACTION_RESULT_STATUSES.FAILED
            ? result.message
            : "Preview is unavailable"
        );
      }
    } catch (error) {
      Log.warn(
        "[PromptEditorSupportService] handleOpenPriorContext: failed to open document",
        error
      );
    }
  }

  /**
   * Handle request to count tokens for attachment references.
   */
  async handleAttachmentTokenCountRequest(
    ctx: WebviewClientContext,
    references: string[]
  ): Promise<void> {
    const workspaceRoot = this.getWorkspaceRoot() || undefined;
    if (!workspaceRoot || !references || references.length === 0) {
      ctx.emit({
        type: MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE,
        counts: {},
      });
      return;
    }

    const counts: Record<string, number> = {};

    const workspaceIdentity =
      ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
    const trustedRoots = [
      ...this.getTrustedWorkspaceRoots(),
      ...ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
        workspaceIdentity
      ),
    ];
    const namedRoots = [...this.getNamedRoots()];
    const sourceDefinitionDir = await this.getViewSourceDefinitionDir(
      ctx,
      trustedRoots
    );

    await Promise.all(
      references.map(async (rawRef) => {
        try {
          // Prior-context refs ($previous, $step:N …) expand to the actual
          // output of earlier steps — count that exact XML. When no run output
          // exists yet, buildPriorContextContent returns an `<!-- … -->`
          // placeholder; treat that as zero tokens.
          const priorRef = decodePriorContextTokenRef(rawRef);
          if (priorRef) {
            const content = await this.buildPriorContextContent(
              ctx,
              priorRef.body,
              priorRef.stepCount
            );
            counts[rawRef] = content.startsWith("<!--")
              ? 0
              : encode(content).length;
            return;
          }

          const expander = new ContextExpander({
            workspaceRoot,
            additionalTrustedRoots: trustedRoots,
            namedRoots,
            effectiveAbsolute: false,
            sourceDefinitionDir,
          });

          // Images are billed by pixel area, not raw byte content — estimate
          // them directly instead of tokenizing the binary file as text.
          const imageTokens =
            await expander.estimateImageReferenceTokens(rawRef);
          if (imageTokens !== null) {
            counts[rawRef] = imageTokens;
            return;
          }

          // Bare full-file @refs are capped the same way the dry-run preview
          // caps its Tier 1 file references — see estimateFileReferenceTokens.
          const fileEstimate =
            await expander.estimateFileReferenceTokens(rawRef);
          if (fileEstimate !== null) {
            counts[rawRef] = fileEstimate.tokens;
            return;
          }

          const expanded = await expander.expandContext(rawRef);

          if (expanded === rawRef) {
            counts[rawRef] = 0;
            return;
          }

          const attachmentContent = expanded.slice(
            0,
            expanded.lastIndexOf(`\n\n${rawRef}`)
          );
          counts[rawRef] = encode(attachmentContent).length;
        } catch (error) {
          Log.warn(
            `[PromptEditorSupportService] Failed to count tokens for reference "${rawRef}":`,
            error
          );
          counts[rawRef] = 0;
        }
      })
    );

    ctx.emit({
      type: MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE,
      counts,
    });
  }

  private async getViewSourceDefinitionDir(
    ctx: WebviewClientContext,
    trustedRoots: readonly string[] | undefined
  ): Promise<string | undefined> {
    const sourceDefinitionPath =
      await this.getOrchestrator()?.getViewSourceDefinitionPath(ctx.clientId);
    return getTrustedSourceDefinitionDir(
      sourceDefinitionPath ?? undefined,
      trustedRoots
    );
  }
}
