import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import * as jsYaml from "js-yaml";
import {
  ConfigurationUtils,
  PATH_CONSTANTS,
} from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";

/**
 * A single template variable — name plus optional UI metadata.
 *
 * Type is inferred from the placeholder syntax in template content:
 *   {file:varName}  → type = 'file'  (Browse button, workspace-relative file picker)
 *   {text:varName}  → type = 'text'  (plain input, explicit)
 *   {varName}       → type = 'text'  (plain input, default)
 *
 * Built-in templates hardcode fileFilter and autoFillFilename in BUILT_IN_TEMPLATES.
 * User templates can declare the same metadata via a top-level `_templateMeta` key:
 *
 *   _templateMeta:
 *     variables:
 *       specFile:
 *         type: file
 *         fileFilter: ["**\/*.md"]
 *         autoFillFilename: true
 *
 * If multiple variables declare autoFillFilename: true, only the first wins.
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
}

/** Parsed shape of a `_templateMeta` block in a template file */
interface ParsedTemplateMeta {
  name?: string;
  description?: string;
  variables: Record<string, Partial<Omit<TemplateVariable, "name">>>;
}

/**
 * Manages workflow templates for FlightPath
 * - Loads built-in and custom templates
 * - Extracts variables from template content
 * - Creates workflow files from templates
 */
export class TemplateManager {
  private context: vscode.ExtensionContext;

  // Ordered list of built-in template IDs. "blank" is special-cased (generated, no file).
  // All others are self-describing via _templateMeta in their YAML files.
  private readonly BUILT_IN_TEMPLATE_IDS = [
    "blank",
    "simple-feature",
    "fix-tests",
    "full-feature",
    "spec-driven-loop",
  ] as const;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
  }

  /**
   * Parse the `_templateMeta` block from raw template content.
   * Returns name, description, and a variable enrichment map.
   * Returns safe defaults if the block is absent or malformed.
   */
  private parseTemplateMeta(content: string): ParsedTemplateMeta {
    try {
      const parsed = jsYaml.load(content) as Record<string, unknown> | null;
      if (!parsed || typeof parsed !== "object") return { variables: {} };
      const meta = parsed["_templateMeta"] as
        | Record<string, unknown>
        | undefined;
      if (!meta || typeof meta !== "object") return { variables: {} };

      const result: ParsedTemplateMeta = { variables: {} };

      if (typeof meta["name"] === "string") result.name = meta["name"];
      if (typeof meta["description"] === "string")
        result.description = meta["description"];

      const variablesMeta = meta["variables"];
      if (
        variablesMeta &&
        typeof variablesMeta === "object" &&
        !Array.isArray(variablesMeta)
      ) {
        for (const [varName, varMeta] of Object.entries(
          variablesMeta as Record<string, unknown>
        )) {
          if (typeof varMeta !== "object" || varMeta === null) continue;
          const vm = varMeta as Record<string, unknown>;
          const entry: Partial<Omit<TemplateVariable, "name">> = {};
          if (vm["type"] === "file" || vm["type"] === "text")
            entry.type = vm["type"];
          if (
            Array.isArray(vm["fileFilter"]) &&
            vm["fileFilter"].every((f) => typeof f === "string")
          ) {
            entry.fileFilter = vm["fileFilter"] as string[];
          }
          if (vm["autoFillFilename"] === true) entry.autoFillFilename = true;
          result.variables[varName] = entry;
        }
      }

      return result;
    } catch {
      return { variables: {} };
    }
  }

  /**
   * Merge auto-extracted variables with metadata from `_templateMeta`.
   * Meta enriches type, fileFilter, and autoFillFilename.
   *
   * Corner case: if multiple variables declare autoFillFilename: true,
   * only the first (in extraction order) gets it — subsequent ones are warned and ignored.
   */
  private mergeVariablesWithMeta(
    extracted: TemplateVariable[],
    meta: Record<string, Partial<Omit<TemplateVariable, "name">>>,
    templateName: string
  ): TemplateVariable[] {
    let autoFillAssigned = false;

    return extracted.map((variable) => {
      const varMeta = meta[variable.name];
      if (!varMeta) return variable;

      const merged: TemplateVariable = { ...variable };
      if (varMeta.type) merged.type = varMeta.type;
      if (varMeta.fileFilter) merged.fileFilter = varMeta.fileFilter;

      if (varMeta.autoFillFilename) {
        if (!autoFillAssigned) {
          merged.autoFillFilename = true;
          autoFillAssigned = true;
        } else {
          Log.warn(
            `Template "${templateName}": variable "${variable.name}" declares autoFillFilename but a prior variable already claims it; ignoring.`
          );
        }
      }

      return merged;
    });
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
    return path.join(
      workspaceFolder.uri.fsPath,
      PATH_CONSTANTS.FLIGHTPATH_DIR,
      PATH_CONSTANTS.TEMPLATES_DIR
    );
  }

  /**
   * Get all available templates (built-in + custom + action).
   *
   * Built-in templates are self-describing: name, description, and variable enrichment
   * come from the `_templateMeta` block in each YAML file, same as user templates.
   */
  async getAvailableTemplates(): Promise<TemplateInfo[]> {
    const templates: TemplateInfo[] = [];

    // "blank" is generated — no file, no metadata to parse
    templates.push({
      id: "blank",
      name: "Blank",
      description: "Empty 2-prompt workflow",
      path: null,
      variables: [],
      isBuiltIn: true,
    });

    // All other built-ins are loaded from their YAML files
    for (const id of this.BUILT_IN_TEMPLATE_IDS) {
      if (id === "blank") continue;
      const templatePath = path.join(
        this.getBuiltInTemplatesPath(),
        `${id}.flightpath.yaml`
      );
      try {
        const content = await fs.promises.readFile(templatePath, "utf-8");
        const meta = this.parseTemplateMeta(content);
        const extracted = this.extractVariables(content);
        const variables = this.mergeVariablesWithMeta(
          extracted,
          meta.variables,
          id
        );
        templates.push({
          id,
          name: meta.name ?? id,
          description: meta.description ?? "",
          path: templatePath,
          variables,
          isBuiltIn: true,
        });
      } catch (error) {
        Log.warn(`Failed to load built-in template: ${id}`, error);
      }
    }

    // Discover custom templates from .flightpath/templates/
    const customTemplates = await this.discoverCustomTemplates();
    templates.push(...customTemplates);

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

    // Built-in template (source is .yaml)
    const templatePath = path.join(
      this.getBuiltInTemplatesPath(),
      `${templateId}.flightpath.yaml`
    );
    return await fs.promises.readFile(templatePath, "utf-8");
  }

  /**
   * Get blank template content (generated, not stored as file)
   */
  getBlankTemplateContent(): string {
    return JSON.stringify(
      {
        steps: [{ prompt: "" }, { prompt: "" }],
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
    workflowsDir: string,
    format: "yaml" | "json" = "yaml"
  ): Promise<string> {
    const workspaceFolder = this.getWorkspaceFolder();
    if (!workspaceFolder) {
      throw new Error("No workspace folder available");
    }

    // Get template content (built-ins are YAML; custom templates are JSON)
    const templateContent = await this.getTemplateContent(templateId);

    // Replace variables in raw template string
    const substituted = this.replaceVariables(templateContent, variables);

    // Parse (yaml.load handles both YAML and JSON) then re-serialize to desired format.
    // Strip _templateMeta — it's template-authoring metadata, not a workflow execution field.
    const parsed = jsYaml.load(substituted) as Record<string, unknown>;
    delete parsed["_templateMeta"];
    let workflowContent: string;
    const ext = format === "json" ? ".flightpath.json" : ".flightpath.yaml";

    if (format === "json") {
      workflowContent = JSON.stringify(parsed, null, 2);
    } else {
      workflowContent = jsYaml.dump(parsed, { lineWidth: -1, noRefs: true });
    }

    // Build full path
    const fullDir = path.join(workspaceFolder.uri.fsPath, workflowsDir);
    const fullPath = path.join(fullDir, `${filename}${ext}`);

    // Ensure directory exists
    if (!(await this.pathExists(fullDir))) {
      await fs.promises.mkdir(fullDir, { recursive: true });
    }

    // Check if file already exists
    if (await this.pathExists(fullPath)) {
      throw new Error(`File already exists: ${filename}${ext}`);
    }

    // Write file
    await fs.promises.writeFile(fullPath, workflowContent, "utf-8");

    return fullPath;
  }

  /**
   * Create a new custom template with a feature-demonstrating starter.
   * The starter includes _templateMeta, a file-type variable with autoFillFilename,
   * and a plain text placeholder so users can see key features in context.
   *
   * @param templateName Name for the new template
   * @returns Path to created template file
   */
  async createCustomTemplate(templateName: string): Promise<string> {
    const customPath = this.getCustomTemplatesPath();
    if (!customPath) {
      throw new Error("No workspace folder available");
    }

    // Ensure templates directory exists
    if (!(await this.pathExists(customPath))) {
      await fs.promises.mkdir(customPath, { recursive: true });
    }

    const fullPath = path.join(customPath, `${templateName}.flightpath.json`);

    if (await this.pathExists(fullPath)) {
      throw new Error(`Template already exists: ${templateName}`);
    }

    const starter = {
      _templateMeta: {
        name: templateName,
        description: "Describe what this template does",
        variables: {
          specFile: {
            type: "file",
            fileFilter: ["**/*.md", "**/*.txt"],
            autoFillFilename: true,
          },
        },
      },
      steps: [
        {
          name: "plan",
          prompt:
            "Review the following spec and create a detailed implementation plan:\n@{file:specFile}",
        },
        {
          name: "implement",
          prompt: "Implement the plan you just created.",
          resumeSession: true,
        },
      ],
    };

    await fs.promises.writeFile(
      fullPath,
      JSON.stringify(starter, null, 2),
      "utf-8"
    );

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
            const meta = this.parseTemplateMeta(content);
            const extracted = this.extractVariables(content);
            const variables = this.mergeVariablesWithMeta(
              extracted,
              meta.variables,
              name
            );

            templates.push({
              id: `custom:${name}`,
              name: meta.name ?? name,
              description: meta.description ?? "Custom template",
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
