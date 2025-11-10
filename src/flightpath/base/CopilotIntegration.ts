import * as vscode from "vscode";
import * as path from "path";
import { PromptItem } from "../../types/FlightPathTypes";

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

  // Event emitters for status and response completion
  protected statusChangeEmitter = new vscode.EventEmitter<CopilotStatus>();
  public readonly onDidChangeStatus = this.statusChangeEmitter.event;

  protected responseCompleteEmitter = new vscode.EventEmitter<string>();
  public readonly onResponseComplete = this.responseCompleteEmitter.event;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;

    // Register disposal of event emitters
    context.subscriptions.push(this.statusChangeEmitter);
    context.subscriptions.push(this.responseCompleteEmitter);
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
   * @returns True if prompt was sent successfully
   */
  abstract sendPrompt(
    prompt: PromptItem,
    needsCompletionDetection?: boolean
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
   * Process #file: references in prompt and build Copilot attachment XML
   * @param prompt Original prompt text with #file: references
   * @returns Final prompt with attachment XML prepended (keeps #file: syntax in prompt text)
   */
  private async processPromptAttachments(prompt: string): Promise<string> {
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
  private parseFileReferences(
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
  private resolveWorkspacePath(relativePath: string): string {
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
}
