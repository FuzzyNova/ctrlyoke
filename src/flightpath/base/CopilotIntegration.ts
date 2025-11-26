import * as vscode from "vscode";
import * as path from "path";
import { PromptItem } from "../../types/FlightPathTypes";
import { CopilotCliResult } from "../../types/CopilotTypes";

/**
 * Copilot initialization status
 */
export enum CopilotStatus {
  Initializing = "initializing",
  Waiting = "waiting",
  Ready = "ready",
  Unavailable = "unavailable",
}

/**
 * Base class for Copilot integrations
 *
 * Provides common functionality and defines the contract that all
 * Copilot integration strategies must implement.
 */
export abstract class CopilotIntegration {
  protected context: vscode.ExtensionContext;
  protected isAvailable: boolean = false;
  protected workflowStep: number = 0;
  protected totalSteps: number = 0;
  protected isCancelling: boolean = false;
  protected lastFailureReason: string | null = null;

  // Event emitters for status and response completion
  protected statusChangeEmitter = new vscode.EventEmitter<CopilotStatus>();
  public readonly onDidChangeStatus = this.statusChangeEmitter.event;

  protected responseCompleteEmitter = new vscode.EventEmitter<string>();
  public readonly onResponseComplete = this.responseCompleteEmitter.event;

  // Event emitter for streaming response chunks
  protected streamingChunkEmitter = new vscode.EventEmitter<string>();
  public readonly onStreamingChunk = this.streamingChunkEmitter.event;

  // Event emitter for prompt ready (fires when prompt is built but before execution)
  protected promptReadyEmitter = new vscode.EventEmitter<{
    fullPrompt: string;
    cliCommand?: string;
  }>();
  public readonly onPromptReady = this.promptReadyEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    // Register disposal of event emitters
    context.subscriptions.push(this.statusChangeEmitter);
    context.subscriptions.push(this.responseCompleteEmitter);
    context.subscriptions.push(this.streamingChunkEmitter);
    context.subscriptions.push(this.promptReadyEmitter);
  }

  /**
   * Initialize the Copilot integration
   * Must be implemented by subclasses
   */
  abstract initialize(): Promise<void>;

  /**
   * Send a prompt to Copilot
   * Must be implemented by subclasses
   * @param prompt The prompt item to send
   * @param needsCompletionDetection If true, set up completion detection mechanisms (default: true)
   * @param workflowContext Optional workflow context for dynamic queue instructions
   * @returns True if prompt was sent successfully
   */
  abstract sendPrompt(
    prompt: PromptItem,
    needsCompletionDetection?: boolean,
    workflowContext?: {
      promptIndex: number;
      allPrompts: PromptItem[];
      filePath?: string;
    }
  ): Promise<boolean>;

  /**
   * Get the current status of the integration
   * Must be implemented by subclasses
   */
  abstract getStatus(): {
    available: boolean;
    message: string;
    strategy: string;
  };

  /**
   * Check if the integration is available
   * Must be implemented by subclasses
   */
  abstract isIntegrationAvailable(): boolean;

  /**
   * Build prompt text from prompt item
   * Common logic for extracting prompt text (without tool instruction XML)
   */
  protected async buildPromptText(prompt: PromptItem): Promise<string> {
    // Check if auto-attachment is enabled
    const autoAttach = vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("autoAttachFiles", true);

    // User's prompt text is already in final form with all context variables
    const promptText = prompt.prompt.trim();

    // Process file attachments if enabled
    if (autoAttach) {
      return await this.processPromptAttachments(promptText);
    }

    return promptText;
  }

  /**
   * Build prompt with dynamic queue instructions if needed
   * @param prompt The prompt item
   * @param promptIndex Current prompt index
   * @param allPrompts All prompts in the workflow
   * @param filePath Path to the .flightpath.json file
   * @returns Prompt text with optional dynamic queue instructions
   */
  protected async buildPromptWithInstructions(
    prompt: PromptItem,
    promptIndex: number,
    allPrompts: PromptItem[],
    filePath?: string
  ): Promise<string> {
    // Build base prompt text (with attachments)
    let promptText = await this.buildPromptText(prompt);

    // Check if we should inject dynamic queue instructions
    const config = vscode.workspace.getConfiguration("flightpath");
    const dynamicQueueEnabled = config.get<boolean>(
      "enableDynamicQueue",
      false
    );

    if (!dynamicQueueEnabled || !filePath) {
      return promptText; // No instructions needed
    }

    // Check if this prompt should get extension instructions
    const {
      shouldInjectExtensionInstructions,
    } = require("../../utils/PromptIdentity");
    const dynamicExtensionOnLastPrompt = config.get<boolean>(
      "dynamicExtensionOnLastPrompt",
      true
    );

    const shouldInject = shouldInjectExtensionInstructions(
      prompt,
      promptIndex,
      allPrompts,
      dynamicExtensionOnLastPrompt
    );

    if (!shouldInject) {
      return promptText; // No instructions for this prompt
    }

    // Get dynamic queue config for instruction template
    const maxQueueSize = config.get<number>("maxQueueSize", 100);
    const maxExecutionTime = config.get<number>("maxExecutionTime", 18000);
    const unlimitedMode = config.get<boolean>("unlimitedMode", false);

    // Calculate current stats (approximations for instruction template)
    const currentSize = allPrompts.length;
    const currentIndex = promptIndex + 1; // 1-based for display
    const totalPrompts = allPrompts.length;

    // Convert file path to workspace-relative
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    const relativeFilePath = workspaceFolder
      ? vscode.workspace.asRelativePath(filePath, false)
      : filePath;

    // Build instruction template
    const maxSizeDisplay = unlimitedMode
      ? "unlimited"
      : maxQueueSize.toString();
    const maxTimeDisplay = unlimitedMode ? "unlimited" : `${maxExecutionTime}s`;

    const instructions = `<criticalInstruction>
You are executing prompt ${currentIndex} of ${totalPrompts} in a FlightPath workflow.

DYNAMIC QUEUE EXTENSION:
If you need additional steps to complete this task, you can extend the workflow:
1. Read the current file: ${relativeFilePath}
2. Insert new prompts AFTER the current prompt (index ${currentIndex}) in the "prompts" array
   - Recommended: Insert immediately after current position for logical flow
   - Alternative: Append to end of array if order doesn't matter
3. Include "id" fields for clarity (e.g., "id": "step-4-refactor-auth")
4. Optionally set "allowDynamicExtension": true on prompts that may need further extension
5. Keep existing prompts intact - DO NOT modify or delete completed prompts
6. Save the file - FlightPath will detect changes and continue

Current queue: ${currentSize}/${maxSizeDisplay} prompts
Max execution time: ${maxTimeDisplay}

IMPORTANT: Only extend the queue if truly necessary. Each prompt adds execution time.
</criticalInstruction>

`;

    // Prepend instructions to prompt
    return instructions + promptText;
  }

  /**
   * Process #file: references in prompt and build Copilot attachment XML
   * @param prompt Original prompt text with #file: references
   * @returns Final prompt with attachment XML prepended (keeps #file: syntax in prompt text)
   */
  protected async processPromptAttachments(prompt: string): Promise<string> {
    try {
      // Parse file references from prompt
      const fileReferences = this.parseFileReferences(prompt);

      if (fileReferences.length === 0) {
        return prompt; // No attachments needed
      }

      // Build attachments in parallel for performance
      const attachmentPromises = fileReferences.map((ref) =>
        this.buildAttachmentXml(ref.path, ref.startLine, ref.endLine).catch(
          (err) => {
            console.error(
              `Failed to attach ${ref.path}${ref.startLine ? `:${ref.startLine}-${ref.endLine}` : ""}:`,
              err
            );
            return null; // Skip failed attachments
          }
        )
      );

      const attachments = await Promise.all(attachmentPromises);
      const validAttachments = attachments.filter(
        (a) => a !== null
      ) as string[];

      if (validAttachments.length === 0) {
        return prompt; // No valid attachments
      }

      // Prepend attachments to prompt (keeps #file: syntax in prompt body)
      const attachmentsSection = validAttachments.join("\n\n");
      return `${attachmentsSection}\n\n${prompt}`;
    } catch (error) {
      console.error("Error processing prompt attachments:", error);
      // Return original prompt on error
      return prompt;
    }
  }

  /**
   * Parse #file: references from prompt text
   * Supports formats:
   * - #file:path (entire file)
   * - #file:"path with spaces" (quoted path)
   * - #file:path:startLine-endLine (line range)
   * - #file:"path with spaces":startLine-endLine (quoted path with line range)
   */
  protected parseFileReferences(
    prompt: string
  ): Array<{ path: string; startLine?: number; endLine?: number }> {
    const fileReferences: Array<{
      path: string;
      startLine?: number;
      endLine?: number;
    }> = [];

    // Regex to match #file:path or #file:"path with spaces" with optional :start-end
    // Group 1: quoted path, Group 2: unquoted path, Group 3: startLine, Group 4: endLine
    const regex = /#file:(?:"([^"]+)"|([^:\s]+))(?::(\d+)-(\d+))?/g;
    let match;

    while ((match = regex.exec(prompt)) !== null) {
      const [, quotedPath, unquotedPath, startLine, endLine] = match;
      const filePath = quotedPath || unquotedPath; // Use quoted path if present, otherwise unquoted

      fileReferences.push({
        path: filePath,
        startLine: startLine ? parseInt(startLine, 10) : undefined,
        endLine: endLine ? parseInt(endLine, 10) : undefined,
      });
    }

    return fileReferences;
  }

  /**
   * Build Copilot attachment XML for a file or file excerpt
   */
  private async buildAttachmentXml(
    filePath: string,
    startLine?: number,
    endLine?: number
  ): Promise<string> {
    // Resolve to absolute path
    const absolutePath = this.resolveWorkspacePath(filePath);
    const uri = vscode.Uri.file(absolutePath);

    // Read file content
    const doc = await vscode.workspace.openTextDocument(uri);
    const language = doc.languageId;

    // If no line range, attach entire file
    if (!startLine || !endLine) {
      const content = doc.getText();
      return `<attachment id="file:${filePath}">
File: ${filePath}
\`\`\`${language}
${content}
\`\`\`
</attachment>`;
    }

    // Extract line range (convert to 0-indexed)
    const start = new vscode.Position(startLine - 1, 0);
    const end = new vscode.Position(endLine - 1, Number.MAX_SAFE_INTEGER);
    const range = new vscode.Range(start, end);
    const content = doc.getText(range);

    return `<attachment id="file:${filePath}:${startLine}-${endLine}">
Excerpt from ${filePath}, lines ${startLine} to ${endLine}:
\`\`\`${language}
${content}
\`\`\`
</attachment>`;
  }

  /**
   * Resolve relative path to absolute workspace path
   * Uses Node.js path.resolve for cross-platform compatibility
   */
  protected resolveWorkspacePath(relativePath: string): string {
    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      throw new Error("No workspace folder open");
    }

    // path.resolve handles both absolute and relative paths correctly
    // If relativePath is already absolute, it returns it as-is
    // If relative, it joins with workspaceRoot
    return path.resolve(workspaceRoot, relativePath);
  }

  /**
   * Get workspace root directory
   */
  protected getWorkspaceRoot(): string | undefined {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    return workspaceFolder?.uri.fsPath;
  }

  /**
   * Set workflow progress tracking
   * Called by PromptQueue to update progress information
   */
  setWorkflowProgress(currentStep: number, totalSteps: number): void {
    this.workflowStep = currentStep;
    this.totalSteps = totalSteps;
  }

  /**
   * Update workflow progress status bar message
   */
  protected async updateWorkflowProgress(): Promise<void> {
    if (this.totalSteps > 0) {
      const progress = `${this.workflowStep}/${this.totalSteps}`;
      vscode.window.setStatusBarMessage(
        `$(compass-dot) FlightPath: Step ${progress} completed`,
        3000
      );
    }
  }

  /**
   * Get initialization status
   * Must be implemented by subclasses
   */
  abstract getInitializationStatus(): CopilotStatus;

  /**
   * Check if Copilot is ready for workflows
   * Must be implemented by subclasses
   */
  abstract isReady(): boolean;

  /**
   * Cancel the current operation
   * Sets the shared cancellation flag and calls subclass-specific implementation
   */
  async cancel(): Promise<void> {
    this.isCancelling = true;
    await this.cancelImplementation();
  }

  /**
   * Subclass-specific cancellation logic
   * Must be implemented by subclasses to handle their specific cleanup
   */
  protected abstract cancelImplementation(): Promise<void>;

  /**
   * Reset cancellation flag (call before starting new operations)
   */
  protected resetCancellationFlag(): void {
    this.isCancelling = false;
  }

  /**
   * Get detailed status (optional - can be overridden by subclasses)
   * Default implementation returns basic information
   */
  getDetailedStatus(): {
    initializationStatus: CopilotStatus;
    isReady: boolean;
    message: string;
    pollingAttempts?: number;
    maxPollingAttempts?: number;
  } {
    const status = this.getInitializationStatus();
    let message = "";

    switch (status) {
      case CopilotStatus.Initializing:
        message = "🔍 Initializing Copilot integration...";
        break;
      case CopilotStatus.Waiting:
        message = "⏳ Waiting for Copilot...";
        break;
      case CopilotStatus.Ready:
        message = "✅ Copilot ready";
        break;
      case CopilotStatus.Unavailable:
        message = "❌ Copilot unavailable";
        break;
    }

    return {
      initializationStatus: status,
      isReady: this.isReady(),
      message,
    };
  }

  // ============================================================
  // EXECUTION OUTPUT METHODS (CLI provides real values, Chat returns undefined)
  // ============================================================

  /**
   * Get the last execution result (CLI-specific, returns undefined for Chat)
   * Includes response text, statistics, and exit code
   */
  getLastResult(): CopilotCliResult | undefined {
    return undefined;
  }

  /**
   * Get the last CLI command executed (for debugging)
   * Returns undefined for non-CLI integrations
   */
  getLastCliCommand(): string | undefined {
    return undefined;
  }

  /**
   * Get the full prompt text sent (includes all context and instructions)
   * Returns undefined if not tracked
   */
  getLastFullPrompt(): string | undefined {
    return undefined;
  }

  /**
   * Parse token counts from statistics string
   * Returns undefined for non-CLI integrations or unparseable stats
   */
  parseTokenCounts(
    _statistics: string
  ): { prompt: number; completion: number } | undefined {
    return undefined;
  }

  // ============================================================
  // DIAGNOSTIC METHODS (Chat provides full implementations, CLI provides defaults)
  // ============================================================

  /**
   * Test automation capability (diagnostic tool)
   * CLI: Returns isReady() since CLI doesn't need automation testing
   * Chat: Sends test message to verify automation works
   */
  async testAutomation(): Promise<boolean> {
    return this.isReady();
  }

  /**
   * Retry integration detection/initialization
   * CLI: Re-runs initialize()
   * Chat: Restarts polling for Copilot availability
   */
  async retryDetection(): Promise<void> {
    await this.initialize();
  }

  /**
   * Get capability information for this integration
   */
  getCapabilities(): {
    hasDirectAutomation: boolean;
    supportsZeroInteraction: boolean;
    currentStrategy: string;
  } {
    const status = this.getStatus();
    return {
      hasDirectAutomation: this.isAvailable,
      supportsZeroInteraction: this.isAvailable,
      currentStrategy: status.strategy,
    };
  }

  /**
   * Check if the last sendPrompt failure was due to user cancellation
   * Returns false by default (only Chat tracks this)
   */
  wasLastFailureUserCancellation(): boolean {
    return false;
  }

  /**
   * Get the reason for the last sendPrompt failure
   * Returns the failure reason and resets it to null
   * Returns "Failed to send prompt" as default if no specific reason was set
   */
  getLastFailureReason(): string {
    const reason = this.lastFailureReason || "Failed to send prompt";
    this.lastFailureReason = null; // Reset after reading
    return reason;
  }

  /**
   * Check if this is a CLI-based integration
   * Returns false by default. CLI integrations override to return true.
   * Use this for CLI-specific features like output logging, token display, etc.
   */
  isCli(): boolean {
    return false;
  }
}
