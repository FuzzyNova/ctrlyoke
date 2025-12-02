import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

/**
 * Template information structure for UI display
 */
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  path: string | null;
  variables: string[];
  isBuiltIn: boolean;
  isAction?: boolean;
}

/**
 * Manages workflow templates for FlightPath
 * - Loads built-in and custom templates
 * - Extracts variables from template content
 * - Creates workflow files from templates
 */
export class TemplateManager {
  private context: vscode.ExtensionContext;

  // Built-in template definitions (hardcoded, always available)
  private readonly BUILT_IN_TEMPLATES: Omit<TemplateInfo, "path">[] = [
    {
      id: "blank",
      name: "Blank",
      description: "Empty 2-prompt workflow",
      variables: [],
      isBuiltIn: true,
    },
    {
      id: "simple-feature",
      name: "Simple Feature",
      description: "Plan → Implement → Commit",
      variables: ["featureDescription"],
      isBuiltIn: true,
    },
    {
      id: "fix-tests",
      name: "Fix Tests",
      description: "Run tests and fix failures with retry",
      variables: ["testCommand"],
      isBuiltIn: true,
    },
    {
      id: "full-feature",
      name: "Full Feature",
      description: "Plan → Implement → Review → Docs → Commit",
      variables: ["featureDescription", "planDocument"],
      isBuiltIn: true,
    },
  ];

  // Special action item for creating new templates
  private readonly CREATE_TEMPLATE_ACTION: TemplateInfo = {
    id: "__create_new__",
    name: "➕ Create New Template...",
    description: "Create a custom template from a starting point",
    path: null,
    variables: [],
    isBuiltIn: false,
    isAction: true,
  };

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Get the workspace folder for the current workspace
   */
  private getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
    return vscode.workspace.workspaceFolders?.[0];
  }

  /**
   * Get the templates directory from the extension bundle
   */
  private getBuiltInTemplatesPath(): string {
    return path.join(
      this.context.extensionPath,
      "out",
      "templates",
      "workflows"
    );
  }

  /**
   * Get the custom templates directory in the workspace
   */
  private getCustomTemplatesPath(): string | null {
    const workspaceFolder = this.getWorkspaceFolder();
    if (!workspaceFolder) return null;
    return path.join(workspaceFolder.uri.fsPath, ".flightpath", "templates");
  }

  /**
   * Get all available templates (built-in + custom + action)
   */
  async getAvailableTemplates(): Promise<TemplateInfo[]> {
    const templates: TemplateInfo[] = [];

    // Add built-in templates with paths
    for (const template of this.BUILT_IN_TEMPLATES) {
      const templatePath =
        template.id === "blank"
          ? null
          : path.join(
              this.getBuiltInTemplatesPath(),
              `${template.id}.flightpath.json`
            );

      templates.push({
        ...template,
        path: templatePath,
      });
    }

    // Discover custom templates from .flightpath/templates/
    const customTemplates = await this.discoverCustomTemplates();
    templates.push(...customTemplates);

    // Add "Create New Template" action at the end
    templates.push(this.CREATE_TEMPLATE_ACTION);

    return templates;
  }

  /**
   * Get template content by ID
   */
  async getTemplateContent(templateId: string): Promise<string> {
    if (templateId === "blank") {
      return this.getBlankTemplateContent();
    }

    // Check if it's a custom template (starts with "custom:")
    if (templateId.startsWith("custom:")) {
      const customPath = this.getCustomTemplatesPath();
      if (!customPath) {
        throw new Error("No workspace folder available");
      }
      const filename = templateId.substring(7); // Remove "custom:" prefix
      const templatePath = path.join(customPath, `${filename}.flightpath.json`);
      return fs.readFileSync(templatePath, "utf-8");
    }

    // Built-in template
    const templatePath = path.join(
      this.getBuiltInTemplatesPath(),
      `${templateId}.flightpath.json`
    );
    return fs.readFileSync(templatePath, "utf-8");
  }

  /**
   * Get blank template content (generated, not stored as file)
   */
  getBlankTemplateContent(): string {
    return JSON.stringify(
      {
        prompts: [{ prompt: "" }, { prompt: "" }],
      },
      null,
      2
    );
  }

  /**
   * Get template info by ID
   */
  async getTemplateInfo(templateId: string): Promise<TemplateInfo | undefined> {
    const templates = await this.getAvailableTemplates();
    return templates.find((t) => t.id === templateId);
  }

  /**
   * Extract variables from template content
   * Matches {variableName} patterns, filters out reserved variables
   */
  extractVariables(content: string): string[] {
    const pattern = /\{([a-z][a-zA-Z0-9]*)\}/g;
    const reserved = ["scriptOutput", "retryCount", "maxRetries"];
    const variables = new Set<string>();

    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (!reserved.includes(match[1])) {
        variables.add(match[1]);
      }
    }

    return Array.from(variables);
  }

  /**
   * Replace variables in template content with provided values
   */
  replaceVariables(content: string, variables: Record<string, string>): string {
    let result = content;
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\{${key}\\}`, "g");
      result = result.replace(pattern, value);
    }
    return result;
  }

  /**
   * Create a workflow file from a template
   * @param templateId Template ID to use
   * @param variables Variable values to substitute
   * @param filename Workflow filename (without extension)
   * @param workflowsDir Directory to save workflow (relative to workspace)
   * @returns Path to created workflow file
   */
  async createWorkflow(
    templateId: string,
    variables: Record<string, string>,
    filename: string,
    workflowsDir: string
  ): Promise<string> {
    const workspaceFolder = this.getWorkspaceFolder();
    if (!workspaceFolder) {
      throw new Error("No workspace folder available");
    }

    // Get template content
    const templateContent = await this.getTemplateContent(templateId);

    // Replace variables
    const workflowContent = this.replaceVariables(templateContent, variables);

    // Build full path
    const fullDir = path.join(workspaceFolder.uri.fsPath, workflowsDir);
    const fullPath = path.join(fullDir, `${filename}.flightpath.json`);

    // Ensure directory exists
    if (!fs.existsSync(fullDir)) {
      fs.mkdirSync(fullDir, { recursive: true });
    }

    // Check if file already exists
    if (fs.existsSync(fullPath)) {
      throw new Error(`File already exists: ${filename}.flightpath.json`);
    }

    // Write file
    fs.writeFileSync(fullPath, workflowContent, "utf-8");

    return fullPath;
  }

  /**
   * Create a new custom template from a built-in starting point
   * @param startingPointId Built-in template ID to copy
   * @param templateName Name for the new template
   * @returns Path to created template file
   */
  async createCustomTemplate(
    startingPointId: string,
    templateName: string
  ): Promise<string> {
    const customPath = this.getCustomTemplatesPath();
    if (!customPath) {
      throw new Error("No workspace folder available");
    }

    // Ensure templates directory exists
    if (!fs.existsSync(customPath)) {
      fs.mkdirSync(customPath, { recursive: true });
    }

    // Get template content
    const templateContent = await this.getTemplateContent(startingPointId);

    // Build path
    const fullPath = path.join(customPath, `${templateName}.flightpath.json`);

    // Check if file already exists
    if (fs.existsSync(fullPath)) {
      throw new Error(`Template already exists: ${templateName}`);
    }

    // Write file
    fs.writeFileSync(fullPath, templateContent, "utf-8");

    return fullPath;
  }

  /**
   * Discover custom templates from .flightpath/templates/
   */
  private async discoverCustomTemplates(): Promise<TemplateInfo[]> {
    const customPath = this.getCustomTemplatesPath();
    if (!customPath || !fs.existsSync(customPath)) {
      return [];
    }

    const templates: TemplateInfo[] = [];

    try {
      const files = fs.readdirSync(customPath);
      for (const file of files) {
        if (file.endsWith(".flightpath.json")) {
          const fullPath = path.join(customPath, file);
          const name = file.replace(".flightpath.json", "");

          try {
            const content = fs.readFileSync(fullPath, "utf-8");
            const variables = this.extractVariables(content);

            templates.push({
              id: `custom:${name}`,
              name: name,
              description: `Custom template`,
              path: fullPath,
              variables,
              isBuiltIn: false,
            });
          } catch (error) {
            console.warn(`Failed to read custom template: ${file}`, error);
          }
        }
      }
    } catch (error) {
      console.warn("Failed to discover custom templates:", error);
    }

    return templates;
  }

  /**
   * Get the workflows directory from settings
   */
  getWorkflowsDirectory(): string {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get("workflowsDirectory", ".flightpath/workflows");
  }

  /**
   * Get the default template ID from settings
   */
  getDefaultTemplateId(): string {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get("defaultWorkflowTemplate", "blank");
  }

  /**
   * Set the default template ID in settings
   */
  async setDefaultTemplateId(templateId: string): Promise<void> {
    await vscode.workspace
      .getConfiguration("flightpath")
      .update(
        "defaultWorkflowTemplate",
        templateId,
        vscode.ConfigurationTarget.Workspace
      );
  }
}
