import * as vscode from "vscode";
import * as path from "path";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

/**
 * Manifest structure for agents
 */
interface AgentManifest {
  agents: Array<{
    id: string;
    label: string;
    description: string;
    file: string;
    tags?: string[];
    icon?: string;
  }>;
}

/**
 * Manifest structure for workflows
 */
interface WorkflowManifest {
  workflows: Array<{
    id: string;
    label: string;
    description: string;
    file: string;
    tags?: string[];
    icon?: string;
  }>;
}

/**
 * TemplateImporter
 *
 * RESPONSIBILITY: Template & Agent Import Operations
 *
 * Handles import operations including:
 * - Importing agents to .github/agents/
 * - Importing workflow templates to .flightpath/templates/
 * - Loading and parsing manifests
 * - File copying with overwrite confirmation
 */
export class TemplateImporter {
  constructor(
    private context: vscode.ExtensionContext,
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
   * Import FlightPath custom agents to the workspace's .github/agents folder
   */
  async importAgents(): Promise<void> {
    try {
      if (!this.currentWorkspaceFolder) {
        vscode.window.showErrorMessage("FlightPath: No workspace folder open");
        return;
      }

      // Load agent manifest
      const manifest = await this.loadManifest<AgentManifest>("agents");

      if (!manifest) {
        return; // Error already shown
      }

      if (!manifest.agents || manifest.agents.length === 0) {
        vscode.window.showInformationMessage(
          "FlightPath: No agents available to import"
        );
        return;
      }

      // Show QuickPick with available agents
      const selectedAgents = await vscode.window.showQuickPick(
        manifest.agents.map((agent) => ({
          label: `${agent.icon || "$(hubot)"} ${agent.label}`,
          description: agent.description,
          detail: agent.tags?.join(", "),
          picked: true,
          agent,
        })),
        {
          placeHolder: "Select agents to import to .github/agents/",
          title: "FlightPath: Import Custom Agents",
          canPickMany: true,
        }
      );

      if (!selectedAgents || selectedAgents.length === 0) {
        return; // User cancelled
      }

      // Create .github/agents directory
      const agentsDir = path.join(
        this.currentWorkspaceFolder.uri.fsPath,
        ".github",
        "agents"
      );

      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(agentsDir));
      } catch {
        // Directory might already exist
      }

      // Copy selected agents
      const templatesPath = path.join(
        this.context.extensionPath,
        "out",
        "templates",
        "agents"
      );

      const { importedAgents, failedAgents } = await this.copyTemplateFiles(
        selectedAgents.map((s) => s.agent),
        templatesPath,
        agentsDir
      );

      // Show result
      await this.showImportResult(
        importedAgents,
        failedAgents,
        agentsDir,
        selectedAgents[0]?.agent.file
      );
    } catch (error) {
      console.error("FlightPath: Error importing agents:", error);
      vscode.window.showErrorMessage(`❌ Failed to import agents: ${error}`);
    }
  }

  /**
   * Import FlightPath workflow templates to the workspace's .flightpath folder
   */
  async importWorkflowTemplates(): Promise<void> {
    try {
      if (!this.currentWorkspaceFolder) {
        vscode.window.showErrorMessage("FlightPath: No workspace folder open");
        return;
      }

      // Load workflow manifest
      const manifest = await this.loadManifest<WorkflowManifest>("workflows");

      if (!manifest) {
        return; // Error already shown
      }

      if (!manifest.workflows || manifest.workflows.length === 0) {
        vscode.window.showInformationMessage(
          "FlightPath: No workflow templates available to import"
        );
        return;
      }

      // Show QuickPick with available workflows
      const selectedWorkflows = await vscode.window.showQuickPick(
        manifest.workflows.map((workflow) => ({
          label: `${workflow.icon || "$(file-code)"} ${workflow.label}`,
          description: workflow.description,
          detail: workflow.tags?.join(", "),
          picked: false,
          workflow,
        })),
        {
          placeHolder:
            "Select workflow templates to import to .flightpath/templates/",
          title: "FlightPath: Import Workflow Templates",
          canPickMany: true,
        }
      );

      if (!selectedWorkflows || selectedWorkflows.length === 0) {
        return; // User cancelled
      }

      // Get prompts directory from settings
      const promptsDir = ConfigurationUtils.getPromptsDirectory();

      // Create .flightpath/templates directory
      const targetDir = path.join(
        this.currentWorkspaceFolder.uri.fsPath,
        promptsDir,
        "templates"
      );

      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(targetDir));
      } catch {
        // Directory might already exist
      }

      // Copy selected workflows
      const templatesPath = path.join(
        this.context.extensionPath,
        "out",
        "templates",
        "workflows"
      );

      const {
        importedAgents: importedWorkflows,
        failedAgents: failedWorkflows,
      } = await this.copyTemplateFiles(
        selectedWorkflows.map((s) => s.workflow),
        templatesPath,
        targetDir
      );

      // Show result
      await this.showImportResult(
        importedWorkflows,
        failedWorkflows,
        targetDir,
        selectedWorkflows[0]?.workflow.file
      );
    } catch (error) {
      console.error("FlightPath: Error importing workflow templates:", error);
      vscode.window.showErrorMessage(
        `❌ Failed to import workflow templates: ${error}`
      );
    }
  }

  /**
   * Load manifest file from extension templates
   *
   * @param type Type of manifest ("agents" or "workflows")
   * @returns Parsed manifest or undefined if failed
   */
  private async loadManifest<T>(
    type: "agents" | "workflows"
  ): Promise<T | undefined> {
    const manifestPath = path.join(
      this.context.extensionPath,
      "out",
      "templates",
      type,
      "manifest.json"
    );

    try {
      const manifestUri = vscode.Uri.file(manifestPath);
      const manifestContent = await vscode.workspace.fs.readFile(manifestUri);
      return JSON.parse(Buffer.from(manifestContent).toString("utf-8"));
    } catch (error) {
      console.error(`FlightPath: Failed to load ${type} manifest:`, error);
      vscode.window.showErrorMessage(
        `❌ Failed to load FlightPath ${type}. The extension may not be properly installed.`
      );
      return undefined;
    }
  }

  /**
   * Copy template files from source to destination with overwrite confirmation
   *
   * @param items Array of items to copy (agents or workflows)
   * @param srcDir Source directory path
   * @param destDir Destination directory path
   * @returns Arrays of imported and failed items
   */
  private async copyTemplateFiles(
    items: Array<{ id: string; label: string; file: string }>,
    srcDir: string,
    destDir: string
  ): Promise<{ importedAgents: string[]; failedAgents: string[] }> {
    const importedAgents: string[] = [];
    const failedAgents: string[] = [];

    for (const item of items) {
      const srcPath = path.join(srcDir, item.file);
      const destPath = path.join(destDir, item.file);

      try {
        // Check if file already exists
        try {
          await vscode.workspace.fs.stat(vscode.Uri.file(destPath));
          // File exists, ask for confirmation
          const overwrite = await vscode.window.showWarningMessage(
            `"${item.label}" already exists. Overwrite?`,
            "Yes",
            "No"
          );
          if (overwrite !== "Yes") {
            continue;
          }
        } catch {
          // File doesn't exist, proceed with copy
        }

        // Copy the file
        const content = await vscode.workspace.fs.readFile(
          vscode.Uri.file(srcPath)
        );
        await vscode.workspace.fs.writeFile(vscode.Uri.file(destPath), content);
        importedAgents.push(item.label);
      } catch (error) {
        console.error(`FlightPath: Failed to import ${item.id}:`, error);
        failedAgents.push(item.label);
      }
    }

    return { importedAgents, failedAgents };
  }

  /**
   * Show import result with action buttons
   *
   * @param imported Array of successfully imported item labels
   * @param failed Array of failed item labels
   * @param targetDir Target directory path
   * @param firstFile First imported file name (for View action)
   */
  private async showImportResult(
    imported: string[],
    failed: string[],
    targetDir: string,
    firstFile?: string
  ): Promise<void> {
    // Show success message
    if (imported.length > 0) {
      const action = await vscode.window.showInformationMessage(
        `✅ Imported ${imported.length} item(s): ${imported.join(", ")}`,
        "Open Folder",
        "View File"
      );

      if (action === "Open Folder") {
        await vscode.commands.executeCommand(
          "revealFileInOS",
          vscode.Uri.file(targetDir)
        );
      } else if (action === "View File" && imported.length === 1 && firstFile) {
        // Open the first imported file
        const filePath = path.join(targetDir, firstFile);
        const doc = await vscode.workspace.openTextDocument(filePath);
        await vscode.window.showTextDocument(doc);
      }
    }

    // Show error message for failures
    if (failed.length > 0) {
      vscode.window.showErrorMessage(
        `❌ Failed to import: ${failed.join(", ")}`
      );
    }
  }
}
