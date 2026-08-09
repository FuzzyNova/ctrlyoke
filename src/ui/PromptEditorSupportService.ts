import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { getErrorMessage } from "../utils/ErrorUtils";
import {
  getVsCodeWorkspaceRoot,
  getVsCodeTrustedWorkspaceRoots,
  getVsCodeNamedWorkspaceRoots,
} from "../platform/VsCodeWorkspaceRoot";
import {
  MESSAGE_TYPES,
  PANEL_CLIENT_ID,
  MAX_PASTED_IMAGE_BYTES,
  mimeTypeToImageExtension,
  imageExtensionToMimeType,
} from "../types/DashboardConstants";
import { TempFileManager } from "../utils/TempFileManager";
import {
  buildFileReferenceValue,
  buildPromptFileReferenceValue,
} from "../completions/ContextReferenceBuilder";
import { isPathWithinAnyDirectory } from "../utils/PathSecurity";
import { evaluateFileAccess } from "../utils/FileAccessPolicy";
import {
  openResolvedTarget,
  confirmExternalFileTrustAndOpen,
  type FileOpenTarget,
} from "./ExternalFileTrustPrompt";
import {
  resolveNamedRelativePath,
  type ResolverWorkspaceFolder,
} from "../platform/WorkspaceRootResolver";
import { PromptFileResolver } from "../core/PromptFileResolver";
import { PromptFileWriter } from "../utils/PromptFileWriter";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import { Log } from "../utils/Log";
import {
  getFileCompletions,
  getHashCompletions,
  getHashSelectionCompletions,
  getGitChangeCompletions,
  getPromptFileCompletions,
  getPriorContextCompletions,
  findSymbolKindForReference,
  getPathSuggestions,
  type PlainCompletionItem,
} from "../completions/CompletionHelpers";
import { getStashList, gitRefExists } from "../utils/GitUtils";
import { ContextExpander } from "../utils/ContextExpander";
import { decodePriorContextTokenRef } from "../utils/FileReferenceParser";
import { encode } from "gpt-tokenizer";
import { PriorContextPreviewBuilder } from "../utils/PriorContextPreviewBuilder";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import type { WorkflowOrchestrator } from "../core/WorkflowOrchestrator";
import type { WorkflowStep } from "../types/CtrlYokeTypes";
import type { WebviewClientContext } from "./WebviewClientContext";

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
    ) => string | undefined
  ) {}

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
        const selectionItems = getHashSelectionCompletions();
        if (selectionItems.length > 0) {
          this.emitCompletionsResponse(
            ctx,
            selectionItems,
            position,
            seq,
            true
          );
        }
        const fullItems = await getHashCompletions(prefix.substring(1));
        this.emitCompletionsResponse(ctx, fullItems, position, seq, false);
        return;
      }

      const items = await this.getCompletionItems(trigger, prefix);
      this.emitCompletionsResponse(ctx, items, position, seq, false);
    } catch (error) {
      Log.error("Failed to get completions:", error);
      this.emitCompletionsResponse(ctx, [], position, seq, false);
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
      `[Dashboard] Completion response: position=${position}, partial=${partial} → ${items.length} items`
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
    if (trigger === "@") {
      return await getFileCompletions(prefix.substring(1)); // Remove @
    } else if (trigger === "#") {
      return await getHashCompletions(prefix.substring(1)); // Remove #
    } else if (trigger === "~") {
      const workspaceRoot = vscode.workspace.workspaceFolders?.length
        ? getVsCodeWorkspaceRoot()
        : "";
      return await getGitChangeCompletions(workspaceRoot, prefix.substring(1)); // Remove ~
    } else if (trigger === "$") {
      return getPriorContextCompletions(prefix.substring(1)); // Remove $
    } else if (trigger === "path") {
      return await getPromptFileCompletions(prefix);
    }

    Log.warn(`[Dashboard] Unknown trigger: "${trigger}"`);
    return [];
  }

  /**
   * Validate whether a file-ref path typed in the prompt editor resolves to
   * an actual readable file. The source directory comes from the addressed
   * lineage descriptor, never from the `.runs/...` working copy.
   */
  async handleFileRefValidation(
    ctx: WebviewClientContext,
    filePath: string,
    seq?: number,
    _address?: unknown
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : null;
    const trustedRoots = workspaceRoot
      ? getVsCodeTrustedWorkspaceRoots()
      : undefined;
    const workspaceIdentity = workspaceRoot
      ? ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot)
      : undefined;
    const resolver = new PromptFileResolver({
      workspaceRoot: workspaceRoot ?? undefined,
      namedRoots: workspaceRoot ? getVsCodeNamedWorkspaceRoots() : [],
      trustedRoots,
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
      exists: resolution.status === "resolved" || resolution.status === "empty",
      isEmpty: resolution.status === "empty",
      resolvedPath:
        resolution.status === "resolved" || resolution.status === "empty"
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
      Log.error(`Failed to create prompt file: ${errorMessage}`);
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
      if (!vscode.workspace.workspaceFolders?.length) {
        throw new Error("No workspace folder open");
      }
      const workspaceRoot = getVsCodeWorkspaceRoot();
      const resolver = new PromptFileResolver({
        workspaceRoot,
        namedRoots: getVsCodeNamedWorkspaceRoots(),
        trustedRoots: getVsCodeTrustedWorkspaceRoots(),
        approvedExternalRoots:
          ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
            ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot)
          ),
      });
      const resolution = await resolver.resolve(filePath.trim());
      if (resolution.status !== "resolved" && resolution.status !== "empty") {
        throw new Error(`Prompt file could not be found: ${filePath}`);
      }

      const resolvedPath = await fs.promises.realpath(resolution.path);
      const trustedRoots = getVsCodeTrustedWorkspaceRoots();
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
          ? vscode.ViewColumn.Two
          : undefined,
      };
      const decision = evaluateFileAccess(resolvedPath, {
        workspaceRoots: trustedRoots,
        approvedExternalRoots,
      });
      if (!decision.allowed) {
        await confirmExternalFileTrustAndOpen(target);
        return;
      }
      await openResolvedTarget(target);
    } catch (error) {
      Log.error("Error opening prompt file:", error);
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
      Log.error(`Failed to save pasted image: ${errorMessage}`);
      ctx.emit({
        type: MESSAGE_TYPES.PASTED_IMAGE_SAVED,
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
   * (`resolveNamedRelativePath` + trusted-root containment), so folder-name
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

      const trustedRoots = getVsCodeTrustedWorkspaceRoots();
      const resolved = resolveNamedRelativePath(
        message.relativePath,
        workspaceRoot,
        getVsCodeNamedWorkspaceRoots()
      );
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
    references: Array<{
      id: string;
      type: "file" | "directory" | "lineRange" | "symbol" | "git";
      path?: string;
      gitRef?: string;
      lineStart?: string;
      lineEnd?: string;
      symbolName?: string;
    }>,
    seq?: number
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : null;
    const namedRoots = getVsCodeNamedWorkspaceRoots();

    const results = await Promise.all(
      references.map(async (reference) => {
        const validation = await this.validateContextReference(
          reference,
          workspaceRoot,
          namedRoots
        );
        return {
          id: reference.id,
          ...validation,
        };
      })
    );

    ctx.emit({
      type: MESSAGE_TYPES.CONTEXT_REFS_VALIDATION,
      results,
      seq,
    });
  }

  private async validateContextReference(
    reference: {
      type: "file" | "directory" | "lineRange" | "symbol" | "git";
      path?: string;
      gitRef?: string;
      lineStart?: string;
      lineEnd?: string;
      symbolName?: string;
    },
    workspaceRoot: string | null,
    namedRoots: readonly ResolverWorkspaceFolder[]
  ): Promise<{
    exists: boolean;
    message?: string;
    symbolKind?: number;
    suggestions?: string[];
  }> {
    if (reference.type === "git") {
      return this.validateGitContextReference(reference.gitRef, workspaceRoot);
    }

    if (!reference.path) {
      return { exists: false, message: "context not found" };
    }

    const pathValidation = await this.resolveContextReferencePath(
      reference.path,
      workspaceRoot,
      namedRoots
    );

    if (!pathValidation.exists || !pathValidation.resolvedPath) {
      // Type-agnostic exit (nothing exists on disk at the typed path), so word
      // the message by reference type — a missing directory ref reads "file not
      // found" otherwise. file/lineRange/symbol all point at a file, so they
      // keep "file not found".
      const message =
        reference.type === "directory"
          ? "directory not found"
          : "file not found";
      return this.notFoundWithSuggestions(reference, message);
    }

    if (reference.type === "directory") {
      return pathValidation.isDirectory
        ? { exists: true }
        : this.notFoundWithSuggestions(reference, "directory not found");
    }

    if (!pathValidation.isFile) {
      return this.notFoundWithSuggestions(reference, "file not found");
    }

    if (reference.type === "lineRange" || reference.type === "symbol") {
      const startLine = Number.parseInt(reference.lineStart ?? "", 10);
      const endLine = Number.parseInt(reference.lineEnd ?? "", 10);
      const missingSymbolName =
        reference.type === "symbol" && !reference.symbolName;
      if (
        missingSymbolName ||
        !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) ||
        startLine < 1 ||
        endLine < startLine
      ) {
        return {
          exists: false,
          message:
            reference.type === "symbol"
              ? "symbol not found"
              : "selection not found",
        };
      }

      try {
        const document = await vscode.workspace.openTextDocument(
          vscode.Uri.file(pathValidation.resolvedPath)
        );
        if (endLine > document.lineCount) {
          return {
            exists: false,
            message:
              reference.type === "symbol"
                ? "symbol not found"
                : "selection not found",
          };
        }
        if (reference.type === "symbol" && reference.symbolName) {
          // Best-effort: the reference text itself carries no kind, only a
          // live completion item does. A miss here (renamed/moved symbol,
          // no provider) just leaves the icon at its generic fallback.
          const symbolKind = await findSymbolKindForReference(
            document.uri,
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
            reference.type === "symbol"
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
      (reference.type === "file" || reference.type === "directory")
    ) {
      const suggestions = await getPathSuggestions(
        reference.path,
        reference.type
      );
      if (suggestions.length > 0) {
        return { exists: false, message, suggestions };
      }
    }
    return { exists: false, message };
  }

  private async resolveContextReferencePath(
    filePath: string,
    workspaceRoot: string | null,
    namedRoots: readonly ResolverWorkspaceFolder[]
  ): Promise<{
    exists: boolean;
    resolvedPath?: string;
    isFile?: boolean;
    isDirectory?: boolean;
  }> {
    const candidates = path.isAbsolute(filePath)
      ? [filePath]
      : workspaceRoot
        ? [
            resolveNamedRelativePath(filePath, workspaceRoot, namedRoots),
            path.resolve(
              workspaceRoot,
              PATH_CONSTANTS.CTRLYOKE_DIR,
              filePath.replace(/^\.\.?\//, "")
            ),
          ]
        : [];

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

    return { exists: false };
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
      if (!vscode.workspace.workspaceFolders?.length) {
        Log.warn("No workspace folder open");
        return;
      }
      const workspaceRoot = getVsCodeWorkspaceRoot();
      const trustedRoots = getVsCodeTrustedWorkspaceRoots();
      const namedRoots = getVsCodeNamedWorkspaceRoots();

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

      // Resolve via the same folder-name-prefixed multi-root logic as every
      // other @-reference (`resolveNamedRelativePath`): absolute paths pass
      // through as-is, a `root2/...` prefix resolves against that named root,
      // and an unprefixed path resolves against the primary root.
      const resolvedFsPath = resolveNamedRelativePath(
        trimmedPath,
        workspaceRoot,
        namedRoots
      );
      const targetUri = vscode.Uri.file(resolvedFsPath);

      const workspaceIdentity =
        ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
      const approvedExternalRoots =
        ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
          workspaceIdentity
        );
      const decision = evaluateFileAccess(targetUri.fsPath, {
        workspaceRoots: trustedRoots,
        approvedExternalRoots,
      });
      const target: FileOpenTarget = {
        path: targetUri.fsPath,
        isDirectory,
        startLine: lineStart,
        endLine: lineEnd,
      };

      if (!decision.allowed) {
        Log.warn(
          `Blocked dashboard request to open path outside every trusted root: ${relativePath}`
        );
        await confirmExternalFileTrustAndOpen(target);
        return;
      }

      await openResolvedTarget(target);
    } catch (error) {
      Log.error("Error opening file:", error);
      ctx.emit({
        type: MESSAGE_TYPES.WORKFLOW_ACTION_FAILED,
        action: "open file",
        error: `Failed to open: ${relativePath}`,
      });
    }
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
          )
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
      const doc = await vscode.workspace.openTextDocument({
        content,
        language: "xml",
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (error) {
      Log.error("handleOpenPriorContext: failed to open document", error);
    }
  }

  /**
   * Handle request to count tokens for attachment references.
   */
  async handleAttachmentTokenCountRequest(
    ctx: WebviewClientContext,
    references: string[]
  ): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.length
      ? getVsCodeWorkspaceRoot()
      : undefined;
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
      ...getVsCodeTrustedWorkspaceRoots(),
      ...ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
        workspaceIdentity
      ),
    ];
    const namedRoots = getVsCodeNamedWorkspaceRoots();

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

          const expander = new ContextExpander(
            workspaceRoot,
            trustedRoots,
            namedRoots
          );

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
          Log.warn(`Failed to count tokens for reference "${rawRef}":`, error);
          counts[rawRef] = 0;
        }
      })
    );

    ctx.emit({
      type: MESSAGE_TYPES.ATTACHMENT_TOKEN_COUNTS_RESPONSE,
      counts,
    });
  }
}
