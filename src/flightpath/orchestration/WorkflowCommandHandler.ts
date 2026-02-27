import * as vscode from "vscode";
import * as path from "path";
import { PromptFileParser } from "../PromptFileParser";
import { EndConditionEvaluator } from "../EndConditionEvaluator";
import { TemplateManager } from "../TemplateManager";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

/**
 * WorkflowCommandHandler
 *
 * RESPONSIBILITY: Command Routing & UI Interactions
 *
 * Handles all user-facing commands including:
 * - Creating prompt files (YAML/JSON/Markdown)
 * - Creating draft prompts with timestamps
 * - Creating end condition scripts
 * - Opening files and panels
 * - File picker (Take Off command)
 * - Opening current prompt file
 */
export class WorkflowCommandHandler {
  constructor(
    private context: vscode.ExtensionContext,
    private promptFileParser: PromptFileParser,
    private endConditionEvaluator: EndConditionEvaluator,
    private currentWorkspaceFolder?: vscode.WorkspaceFolder
  ) {}

  /**
   * Update workspace folder reference
   * @param workspaceFolder New workspace folder
   */
  setWorkspaceFolder(
    workspaceFolder: vscode.WorkspaceFolder | undefined
  ): void {
    this.currentWorkspaceFolder = workspaceFolder;
  }

  /**
   * Create a new prompt file with example content
   */
  async createPromptFile(): Promise<void> {
    try {
      if (!this.currentWorkspaceFolder) {
        vscode.window.showErrorMessage("FlightPath: No workspace folder found");
        return;
      }

      // Get user's preferred workflow format
      const defaultFormat = ConfigurationUtils.getDefaultWorkflowFormat();

      // Get file name from user
      const fileName = await vscode.window.showInputBox({
        prompt: "Enter prompt file name",
        placeHolder:
          defaultFormat === "yaml"
            ? "my-workflow.flightpath.yaml"
            : "my-workflow.flightpath.json",
        validateInput: (value) => {
          if (!value) {
            return "File name is required";
          }
          const validExtensions = [
            ".flightpath.yaml",
            ".flightpath.yml",
            ".flightpath.json",
            ".prompt.md",
          ];
          const isValid = validExtensions.some((ext) => value.endsWith(ext));
          if (!isValid) {
            return "File must end with .flightpath.yaml, .flightpath.yml, .flightpath.json, or .prompt.md";
          }
          return null;
        },
      });

      if (!fileName) {
        return;
      }

      // Create prompts directory if it doesn't exist
      const promptsDir = ConfigurationUtils.getPromptsDirectory();
      const promptsDirPath = path.join(
        this.currentWorkspaceFolder.uri.fsPath,
        promptsDir
      );

      // Ensure directory exists
      try {
        await vscode.workspace.fs.createDirectory(
          vscode.Uri.file(promptsDirPath)
        );
      } catch {
        // Directory might already exist
      }

      const filePath = path.join(promptsDirPath, fileName);

      // Create example content based on file extension
      let exampleContent: string;
      if (fileName.endsWith(".yaml") || fileName.endsWith(".yml")) {
        exampleContent = this.createExampleFlightPathYAML();
      } else if (fileName.endsWith(".json")) {
        exampleContent = this.createExampleFlightPathJSON();
      } else if (fileName.endsWith(".md")) {
        exampleContent = this.createExampleMarkdownPrompt();
      } else {
        throw new Error("Unsupported file extension");
      }

      // Write file
      const uri = vscode.Uri.file(filePath);
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from(exampleContent, "utf8")
      );

      // Open file in editor (respects openPromptsInSecondGroup setting)
      await this.openPromptFile(filePath);

      vscode.window.showInformationMessage(`FlightPath: Created ${fileName}`);
    } catch (error) {
      console.error("FlightPath: Failed to create prompt file:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Failed to create prompt file: ${error}`
      );
    }
  }

  /**
   * Create a new draft prompt file with timestamp-based name
   * Opens in editor and ready for the user to edit
   */
  async createDraftPrompt(): Promise<
    { filePath: string; fileName: string } | undefined
  > {
    try {
      if (!this.currentWorkspaceFolder) {
        vscode.window.showErrorMessage("FlightPath: No workspace folder found");
        return undefined;
      }

      // Generate timestamp-based filename: YYYYMMDD-HHmmss.prompt.md
      const now = new Date();
      const pad = (n: number) => n.toString().padStart(2, "0");
      const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      const fileName = `${timestamp}.prompt.md`;

      // Create prompts directory
      const promptsDir = path.join(
        this.currentWorkspaceFolder.uri.fsPath,
        ".flightpath",
        "prompts"
      );

      // Ensure directory exists
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(promptsDir));

      const filePath = path.join(promptsDir, fileName);
      const uri = vscode.Uri.file(filePath);

      // Create empty file
      await vscode.workspace.fs.writeFile(uri, Buffer.from("", "utf8"));

      // Open file in editor (respects openPromptsInSecondGroup setting)
      const document = await vscode.workspace.openTextDocument(uri);
      if (ConfigurationUtils.shouldOpenPromptsInSecondGroup()) {
        await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.Two,
          preview: true,
          preserveFocus: false,
        });
      } else {
        await vscode.window.showTextDocument(document, {
          preview: true,
          preserveFocus: false,
        });
      }

      console.log(`FlightPath: Created draft prompt: ${fileName}`);

      return { filePath, fileName };
    } catch (error) {
      console.error("FlightPath: Failed to create draft prompt:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Failed to create draft prompt: ${error}`
      );
      return undefined;
    }
  }

  /**
   * Create an end condition script from templates
   */
  async createEndConditionScript(): Promise<void> {
    try {
      // Ask user which type of script to create
      const scriptType = await vscode.window.showQuickPick(
        [
          {
            label: "$(file-code) Python",
            description: "Create a Python end condition script",
            value: "python" as const,
          },
          {
            label: "$(file-code) JavaScript",
            description: "Create a JavaScript/Node.js end condition script",
            value: "javascript" as const,
          },
          {
            label: "$(terminal) Shell Script",
            description:
              process.platform === "win32"
                ? "Create a Windows batch script"
                : "Create a bash shell script",
            value: "shell" as const,
          },
          {
            label: "$(terminal-powershell) PowerShell",
            description: "Create a PowerShell script (.ps1)",
            value: "powershell" as const,
          },
        ],
        {
          placeHolder: "Select the type of end condition script to create",
          title: "FlightPath: Create End Condition Script",
        }
      );

      if (!scriptType) {
        return; // User cancelled
      }

      // Create the script
      const scriptPath = await this.endConditionEvaluator.createSampleScript(
        scriptType.value
      );

      if (scriptPath) {
        // Show success message with option to open
        const action = await vscode.window.showInformationMessage(
          `✅ Created end condition script: ${path.basename(scriptPath)}`,
          "Open Script",
          "Show in Explorer"
        );

        if (action === "Open Script") {
          const doc = await vscode.workspace.openTextDocument(scriptPath);
          await vscode.window.showTextDocument(doc);
        } else if (action === "Show in Explorer") {
          await vscode.commands.executeCommand(
            "revealFileInOS",
            vscode.Uri.file(scriptPath)
          );
        }
      } else {
        vscode.window.showErrorMessage(
          "❌ Failed to create end condition script. Check that you have a workspace folder open."
        );
      }
    } catch (error) {
      console.error("FlightPath: Error creating end condition script:", error);
      vscode.window.showErrorMessage(
        `❌ Failed to create end condition script: ${error}`
      );
    }
  }

  /**
   * Open FlightPath panel/dashboard
   * Shows warning and retry if harness is unavailable
   *
   * @param getHarnessStatus Callback to get current harness status
   * @param onRetry Callback to retry harness detection
   */
  async openPanel(
    getHarnessStatus: () => { initializationStatus: string },
    onRetry: () => Promise<void>
  ): Promise<void> {
    // Check if harness is unavailable and offer retry
    const harnessStatus = getHarnessStatus();

    if (harnessStatus.initializationStatus === "unavailable") {
      const action = await vscode.window.showWarningMessage(
        "FlightPath: Harness automation is unavailable. Would you like to retry detection?",
        "Retry Detection",
        "Continue Anyway"
      );

      if (action === "Retry Detection") {
        await onRetry();
        return;
      }
    }

    // Focus the FlightPath dashboard panel
    try {
      await vscode.commands.executeCommand("flightpath.dashboard.focus");
    } catch (error) {
      console.error("Failed to focus FlightPath dashboard:", error);
      throw error; // Let caller handle fallback
    }
  }

  /**
   * Take off - show file picker and execute selected prompt file
   *
   * @param onExecute Callback to execute the selected file
   */
  async takeOff(onExecute: (filePath: string) => Promise<void>): Promise<void> {
    try {
      if (!this.currentWorkspaceFolder) {
        vscode.window.showErrorMessage("FlightPath: No workspace folder found");
        return;
      }

      // Discover available prompt files
      const promptFiles = await this.promptFileParser.discoverPromptFiles(
        this.currentWorkspaceFolder
      );

      if (promptFiles.length === 0) {
        const createAction = await vscode.window.showInformationMessage(
          "No prompt files found. Would you like to create one?",
          "Create Prompt File",
          "Cancel"
        );

        if (createAction === "Create Prompt File") {
          await this.createPromptFile();
        }
        return;
      }

      // Show quick pick for file selection
      const items = promptFiles.map((filePath) => ({
        label: path.basename(filePath),
        description: path.relative(
          this.currentWorkspaceFolder!.uri.fsPath,
          filePath
        ),
        filePath,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: "Select a prompt file to execute",
        ignoreFocusOut: true,
      });

      if (selected) {
        await onExecute(selected.filePath);
      }
    } catch (error) {
      console.error("FlightPath: Take off failed:", error);
      vscode.window.showErrorMessage(`FlightPath: Take off failed: ${error}`);
    }
  }

  /**
   * Open the currently loaded prompt file in the editor
   *
   * @param currentFilePath Current prompt file path or undefined
   */
  async openCurrentPromptFile(currentFilePath?: string): Promise<void> {
    if (!currentFilePath) {
      vscode.window.showWarningMessage(
        "FlightPath: No prompt file loaded. Use 'Select' button to choose a file first."
      );
      return;
    }

    try {
      await this.openPromptFile(currentFilePath);
      console.log(`FlightPath: Opened prompt file: ${currentFilePath}`);
    } catch (error) {
      console.error("FlightPath: Failed to open prompt file:", error);
      vscode.window.showErrorMessage(
        `FlightPath: Failed to open file: ${error}`
      );
    }
  }

  /**
   * Create a new custom template from a built-in starting point
   */
  async createNewTemplate(): Promise<void> {
    try {
      // Show QuickPick for starting point selection
      const startingPoints = [
        {
          label: "$(new-file) Blank",
          description: "Empty 2-prompt workflow",
          id: "blank",
        },
        {
          label: "$(lightbulb) Simple Feature",
          description: "Plan → Implement → Commit",
          id: "simple-feature",
        },
        {
          label: "$(testing-run-icon) Fix Tests",
          description: "Run tests and fix failures with retry",
          id: "fix-tests",
        },
        {
          label: "$(rocket) Full Feature",
          description: "Plan → Implement → Review → Docs → Commit",
          id: "full-feature",
        },
      ];

      const selected = await vscode.window.showQuickPick(startingPoints, {
        placeHolder: "Select a starting point for your custom template",
        title: "Create New Template",
      });

      if (!selected) {
        return; // User cancelled
      }

      // Prompt for template name
      const templateName = await vscode.window.showInputBox({
        prompt: "Enter a name for your custom template",
        placeHolder: "my-custom-workflow",
        validateInput: (value) => {
          if (!value || !value.trim()) {
            return "Template name is required";
          }
          // Check for invalid characters
          if (/[<>:"/\\|?*\x00-\x1f]/.test(value)) {
            return "Invalid characters in template name";
          }
          return undefined;
        },
      });

      if (!templateName) {
        return; // User cancelled
      }

      // Create the template using TemplateManager
      const templateManager = new TemplateManager(this.context);

      const templatePath = await templateManager.createCustomTemplate(
        selected.id,
        templateName.trim()
      );

      // Open the template file in editor
      const doc = await vscode.workspace.openTextDocument(templatePath);
      await vscode.window.showTextDocument(doc);

      vscode.window.showInformationMessage(
        `✅ Created custom template: ${templateName}.flightpath.json`
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`Failed to create template: ${errorMsg}`);
    }
  }

  /**
   * Open a prompt file in the editor
   * Respects openPromptsInSecondGroup setting
   *
   * @param filePath Path to the prompt file to open
   */
  private async openPromptFile(filePath: string): Promise<void> {
    try {
      const document = await vscode.workspace.openTextDocument(filePath);

      if (ConfigurationUtils.shouldOpenPromptsInSecondGroup()) {
        // Open in second editor group (right side) to keep main code visible
        await vscode.window.showTextDocument(document, {
          viewColumn: vscode.ViewColumn.Two,
          preview: false,
          preserveFocus: false,
        });
      } else {
        // Open in active editor (default VS Code behavior)
        await vscode.window.showTextDocument(document);
      }
    } catch (error) {
      console.error("FlightPath: Failed to open prompt file:", error);
    }
  }

  /**
   * Create example FlightPath YAML content
   */
  private createExampleFlightPathYAML(): string {
    return `# FlightPath Workflow
# Multi-step AI automation with validation

prompts:
  - id: analyze
    prompt: |
      Analyze this codebase for potential bugs and code quality issues.

      Focus on:
      - Error handling
      - Type safety
      - Security concerns

      Provide specific recommendations with examples.

  - id: fix
    prompt: |
      Fix any issues found in the previous analysis.

      Follow best practices and maintain code consistency.
    resumeSession: true
    endCondition:
      script: run_tests.py
      returns: "all_passed"
      timeout: 30000
`;
  }

  /**
   * Create example FlightPath JSON content
   */
  private createExampleFlightPathJSON(): string {
    return JSON.stringify(
      {
        prompts: [
          {
            id: "analyze",
            prompt:
              "Analyze this codebase for potential bugs and code quality issues. Focus on error handling, type safety, and security concerns.",
          },
          {
            id: "fix",
            prompt: "Fix any issues found in the previous analysis.",
            endCondition: {
              script: "run_tests.py",
              returns: "all_passed",
            },
          },
        ],
      },
      null,
      2
    );
  }

  /**
   * Create example Markdown prompt content
   */
  private createExampleMarkdownPrompt(): string {
    return `Analyze this codebase and provide recommendations for improvements.

Focus on:
- Code organization and structure
- Error handling patterns
- Type safety
- Security best practices

Provide specific examples and actionable suggestions.
`;
  }
}
