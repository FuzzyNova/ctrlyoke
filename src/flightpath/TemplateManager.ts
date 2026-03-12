import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";

/**
 * A single template variable — name plus optional UI metadata.
 *
 * Type is inferred from the placeholder syntax in template content:
 *   {file:varName}  → type = 'file'  (Browse button, workspace-relative file picker)
 *   {text:varName}  → type = 'text'  (plain input, explicit)
 *   {varName}       → type = 'text'  (plain input, default)
 *
 * Built-in templates may also carry fileFilter and autoFillFilename, which
 * cannot be expressed in the placeholder syntax alone.
 */
export interface TemplateVariable {
  /** Matches the {placeholder} in the template content */
  name: string;
  /** 'file' shows a Browse button; 'text' (default) is a plain input */
  type?: "text" | "file";
  /** Glob patterns for the file picker filter. Only used when type = 'file' */
  fileFilter?: string[];
  /** When true, the workflow filename auto-fills with the selected file's basename (no extension) */
  autoFillFilename?: boolean;
}

/**
 * Template information structure for UI display
 */
export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  path: string | null;
  variables: TemplateVariable[];
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
      variables: [{ name: "featureDescription" }],
      isBuiltIn: true,
    },
    {
      id: "fix-tests",
      name: "Fix Tests",
      description: "Run tests and fix failures with retry",
      variables: [{ name: "testCommand" }],
      isBuiltIn: true,
    },
    {
      id: "full-feature",
      name: "Full Feature",
      description: "Plan → Implement → Review → Docs → Commit",
      variables: [{ name: "featureDescription" }, { name: "planDocument" }],
      isBuiltIn: true,
    },
    {
      id: "spec-driven-loop",
      name: "Spec-Driven Loop",
      description:
        "Architect → Implement → Orchestrate loop. Give it a spec/design doc and it runs until every requirement is satisfied.",
      variables: [
        {
          name: "specFile",
          type: "file" as const, // mirrors {file:specFile} in template content
          fileFilter: ["**/*.md", "**/*.txt", "**/*.yaml", "**/*.json"],
          autoFillFilename: true,
        },
      ],
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
   * Async check for path existence (replaces synchronous existsSync)
   */
  private async pathExists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p);
      return true;
    } catch {
      return false;
    }
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
      return await fs.promises.readFile(templatePath, "utf-8");
    }

    // Built-in template
    const templatePath = path.join(
      this.getBuiltInTemplatesPath(),
      `${templateId}.flightpath.json`
    );
    return await fs.promises.readFile(templatePath, "utf-8");
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
   * Extract variables from template content.
   *
   * Supports typed placeholder syntax:
   *   {file:varName}  → TemplateVariable with type = 'file'
   *   {text:varName}  → TemplateVariable with type = 'text'
   *   {varName}       → TemplateVariable with no explicit type (defaults to text in UI)
   *
   * Reserved names (scriptOutput, retryCount, maxRetries) are filtered out.
   * Duplicate names are deduplicated; first occurrence wins.
   */
  extractVariables(content: string): TemplateVariable[] {
    // Matches optional type prefix: {file:name}, {text:name}, or plain {name}
    const pattern = /\{(?:(file|text):)?([a-z][a-zA-Z0-9]*)\}/g;
    const reserved = ["scriptOutput", "retryCount", "maxRetries"];
    const seen = new Set<string>();
    const variables: TemplateVariable[] = [];

    let match;
    while ((match = pattern.exec(content)) !== null) {
      const [, typePrefix, name] = match;
      if (!reserved.includes(name) && !seen.has(name)) {
        seen.add(name);
        const variable: TemplateVariable = { name };
        if (typePrefix === "file" || typePrefix === "text") {
          variable.type = typePrefix;
        }
        variables.push(variable);
      }
    }

    return variables;
  }

  /**
   * Replace variables in template content with provided values.
   * Handles plain {varName}, {file:varName}, and {text:varName} placeholders.
   */
  replaceVariables(content: string, variables: Record<string, string>): string {
    let result = content;
    for (const [key, value] of Object.entries(variables)) {
      // Replace all forms: {varName}, {file:varName}, {text:varName}
      const pattern = new RegExp(`\\{(?:file:|text:)?${key}\\}`, "g");
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
    if (!(await this.pathExists(fullDir))) {
      await fs.promises.mkdir(fullDir, { recursive: true });
    }

    // Check if file already exists
    if (await this.pathExists(fullPath)) {
      throw new Error(`File already exists: ${filename}.flightpath.json`);
    }

    // Write file
    await fs.promises.writeFile(fullPath, workflowContent, "utf-8");

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
    if (!(await this.pathExists(customPath))) {
      await fs.promises.mkdir(customPath, { recursive: true });
    }

    // Get template content
    const templateContent = await this.getTemplateContent(startingPointId);

    // Build path
    const fullPath = path.join(customPath, `${templateName}.flightpath.json`);

    // Check if file already exists
    if (await this.pathExists(fullPath)) {
      throw new Error(`Template already exists: ${templateName}`);
    }

    // Write file
    await fs.promises.writeFile(fullPath, templateContent, "utf-8");

    return fullPath;
  }

  /**
   * Discover custom templates from .flightpath/templates/
   */
  private async discoverCustomTemplates(): Promise<TemplateInfo[]> {
    const customPath = this.getCustomTemplatesPath();
    if (!customPath || !(await this.pathExists(customPath))) {
      return [];
    }

    const templates: TemplateInfo[] = [];

    try {
      const files = await fs.promises.readdir(customPath);
      for (const file of files) {
        if (file.endsWith(".flightpath.json")) {
          const fullPath = path.join(customPath, file);
          const name = file.replace(".flightpath.json", "");

          try {
            const content = await fs.promises.readFile(fullPath, "utf-8");
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
            Log.warn(`Failed to read custom template: ${file}`, error);
          }
        }
      }
    } catch (error) {
      Log.warn("Failed to discover custom templates:", error);
    }

    return templates;
  }

  /**
   * Set the default template ID in settings
   */
  async setDefaultTemplateId(templateId: string): Promise<void> {
    await ConfigurationUtils.updateSetting(
      "defaultWorkflowTemplate",
      templateId,
      vscode.ConfigurationTarget.Workspace
    );
  }
}
