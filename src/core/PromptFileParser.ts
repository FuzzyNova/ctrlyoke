import * as fs from "fs/promises";
import * as path from "path";
import Ajv from "ajv";
import * as yaml from "js-yaml";
import {
  PromptFile,
  PromptStep,
  WorkflowStep,
  ScriptStep,
  ExecutionProperties,
  EXECUTION_PROPERTY_KEYS,
  isScriptStep,
  hasExecutableSteps,
} from "../types/CtrlYokeTypes";
import { PATH_CONSTANTS } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import type { PlatformAdapter } from "../platform/PlatformAdapter";
import { notifyUserFeedback, type UserFeedbackSink } from "./UserFeedbackSink";
import {
  STEP_TYPES,
  WORKFLOW_PROPERTY_KEYS,
  WORKTREE_MODES,
} from "../types/DashboardConstants";
import { PromptFileResolver } from "./PromptFileResolver";

export class PromptFileParser {
  private ajv = new Ajv({ allowUnionTypes: true });
  private promptSchema: any;

  constructor(
    private readonly platform?: PlatformAdapter,
    private readonly userFeedbackSink?: UserFeedbackSink
  ) {
    this.loadSchemas();
  }

  private loadSchemas(): void {
    try {
      // The bundled extension (esbuild, __dirname === out/) gets schemas copied to
      // out/schemas/. The tsc-compiled test output (__dirname === out/ctrlyoke/)
      // has no such copy, so fall back to the sibling out/schemas/ directory.
      const candidatePaths = [
        path.join(__dirname, "schemas", "workflow-schema.json"),
        path.join(__dirname, "..", "schemas", "workflow-schema.json"),
      ];
      const promptSchemaPath = candidatePaths.find((candidate) =>
        require("fs").existsSync(candidate)
      );
      if (!promptSchemaPath) {
        throw new Error(
          `workflow-schema.json not found in any of: ${candidatePaths.join(", ")}`
        );
      }

      // Use synchronous read to avoid race condition where parsePromptFile
      // is called before the schema finishes loading
      const promptSchemaContent = require("fs").readFileSync(
        promptSchemaPath,
        "utf8"
      );

      this.promptSchema = JSON.parse(promptSchemaContent);

      Log.debug("JSON schema loaded successfully");
    } catch (error) {
      Log.error("Failed to load JSON schema:", error);
      notifyUserFeedback(
        this.userFeedbackSink,
        "error",
        "ctrlyoke: Failed to load validation schema"
      );
    }
  }

  /**
   * Parse and validate a prompt file
   * Supports .ctrlyoke.yaml/.yml, .ctrlyoke.json, and .prompt.md files
   */
  async parsePromptFile(filePath: string): Promise<PromptFile | null> {
    try {
      const ext = path.extname(filePath).toLowerCase();

      // Handle markdown prompt files differently
      if (ext === ".md") {
        return this.parseMarkdownPromptFile(filePath);
      }

      const content = await fs.readFile(filePath, "utf8");
      let parsed: any;

      // Parse based on file extension
      if (ext === ".yaml" || ext === ".yml") {
        // Parse YAML
        try {
          parsed = yaml.load(content, {
            filename: filePath,
            schema: yaml.CORE_SCHEMA,
            json: false, // Use YAML semantics, not JSON compatibility mode
          });
        } catch (yamlError: any) {
          throw new Error(
            `YAML parsing error: ${yamlError.message || yamlError}`
          );
        }
      } else if (ext === ".json") {
        // Parse JSON (.ctrlyoke.json only, .prompt.json removed)
        parsed = JSON.parse(content);
      } else {
        throw new Error(
          `Unsupported file extension: ${ext}. Supported: .yaml, .yml, .json, .md`
        );
      }

      return await this.validateAndNormalize(parsed, filePath);
    } catch (error) {
      Log.error(`Failed to parse file ${filePath}:`, error);
      if (this.userFeedbackSink) {
        notifyUserFeedback(
          this.userFeedbackSink,
          "error",
          `ctrlyoke: Failed to parse ${path.basename(filePath)}: ${error}`
        );
      } else {
        Log.error(
          `ctrlyoke: Failed to parse ${path.basename(filePath)}: ${error}`
        );
      }
      return null;
    }
  }

  /**
   * Validate an already-parsed object against the schema and normalize it into
   * a PromptFile. Shared by parsePromptFile (disk-backed) and callers that
   * already have a parsed object in memory (e.g. template variable substitution)
   * and only need the same schema/normalization guarantees applied.
   * @param parsed Raw parsed YAML/JSON object (no `_templateMeta` or other authoring-only keys)
   * @param contentPath Path used to resolve relative `@file` prompt references; does not need to exist on disk
   */
  async validateAndNormalize(
    parsed: any,
    contentPath: string
  ): Promise<PromptFile> {
    if (this.promptSchema && !this.ajv.validate(this.promptSchema, parsed)) {
      const errors = this.ajv.errors
        ?.map((err) => `${err.instancePath}: ${err.message}`)
        .join(", ");
      throw new Error(`Validation failed: ${errors}`);
    }

    return await this.normalizePromptFile(parsed, contentPath);
  }

  /**
   * Parse a .prompt.md file as a single prompt
   * @param filePath Path to the .prompt.md file
   * @returns PromptFile with single prompt item
   */
  async parseMarkdownPromptFile(filePath: string): Promise<PromptFile | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");

      // Trim whitespace but preserve the prompt text as-is
      const promptText = content.trim();

      if (!promptText) {
        throw new Error("Prompt file is empty");
      }

      return {
        steps: [
          {
            prompt: promptText,
            // Properties omitted will be undefined - global setting used at execution time
          },
        ],
      };
    } catch (error) {
      Log.error(`Failed to read markdown prompt file ${filePath}:`, error);
      if (this.userFeedbackSink) {
        notifyUserFeedback(
          this.userFeedbackSink,
          "error",
          `ctrlyoke: Failed to read ${path.basename(filePath)}: ${error}`
        );
      } else {
        Log.error(
          `ctrlyoke: Failed to read ${path.basename(filePath)}: ${error}`
        );
      }
      return null;
    }
  }

  /** Validate file references early while retaining the authored prompt value. */
  private async validatePromptReference(
    promptValue: string,
    promptFilePath: string
  ): Promise<string> {
    const trustedRoots = this.platform?.getWorkspaceRoots();
    const resolver = new PromptFileResolver({
      workspaceRoot: this.platform?.getWorkspaceRoot(),
      namedRoots: this.platform?.getNamedWorkspaceRoots() ?? [],
      trustedRoots: trustedRoots?.length ? trustedRoots : undefined,
      approvedExternalRoots: this.platform?.getApprovedExternalFileRoots?.(
        this.platform?.getWorkspaceRoot()
      ),
    });

    await resolver.validatePromptReference(promptValue, promptFilePath);
    return promptValue;
  }

  /**
   * Build a ScriptStep from a parsed source object
   * @param source The source object (parsed JSON/YAML)
   * @returns ScriptStep with only defined properties
   */
  private buildScriptStep(source: any): ScriptStep {
    const step: ScriptStep = { type: STEP_TYPES.SCRIPT, script: source.script };
    if (source.name !== undefined) step.name = source.name;
    if (source.enabled !== undefined) step.enabled = source.enabled;
    if (source.executionMode !== undefined)
      step.executionMode = source.executionMode;
    if (source.secrets !== undefined) step.secrets = source.secrets;
    if (source.env !== undefined) step.env = source.env;
    if (source.timeout !== undefined) step.timeout = source.timeout;
    if (source.compareSource !== undefined)
      step.compareSource = source.compareSource;
    if (source.returns !== undefined) step.returns = source.returns;
    if (source.errorBehavior !== undefined)
      step.errorBehavior = source.errorBehavior;
    if (source.onPass !== undefined) step.onPass = source.onPass;
    if (source.onFail !== undefined) step.onFail = source.onFail;
    return step;
  }

  /**
   * Build a PromptStep with only explicitly set properties
   * @param promptText The authored prompt text, retained verbatim
   * @param source The source object (parsed JSON/YAML)
   * @returns PromptStep with only defined properties
   */
  private buildPromptStep(promptText: string, source: any): PromptStep {
    const promptStep: PromptStep = { prompt: promptText };

    // Only include properties that are explicitly set
    if (source.type !== undefined) promptStep.type = source.type;
    if (source.name !== undefined) promptStep.name = source.name;
    if (source.enabled !== undefined) promptStep.enabled = source.enabled;
    this.copyExecutionProperties(source, promptStep);

    return promptStep;
  }

  /**
   * Normalize prompt file to consistent format
   * Resolves any prompt values that are file paths to their content
   *
   * @param parsed The parsed JSON content
   * @param promptFilePath Path to the prompt file (for relative path resolution)
   */
  private async normalizePromptFile(
    parsed: any,
    promptFilePath: string
  ): Promise<PromptFile> {
    if (
      parsed.type === STEP_TYPES.SCRIPT &&
      typeof parsed.script === "string"
    ) {
      const promptFile: PromptFile = {
        steps: [this.buildScriptStep(parsed)],
      };
      this.copyWorkflowLevelProperties(parsed, promptFile);
      return promptFile;
    }

    // Handle single prompt format
    if (parsed.prompt && typeof parsed.prompt === "string") {
      const promptValue = await this.validatePromptReference(
        parsed.prompt,
        promptFilePath
      );

      // Build PromptFile with workflow-level properties and single prompt
      const promptFile: PromptFile = {
        steps: [this.buildPromptStep(promptValue, parsed)],
      };

      // Copy workflow-level properties (if present)
      this.copyWorkflowLevelProperties(parsed, promptFile);

      return promptFile;
    }

    // Handle multiple prompts format
    if (parsed.steps && Array.isArray(parsed.steps)) {
      const resolvedPrompts: WorkflowStep[] = await Promise.all(
        parsed.steps.map(async (item: any) => {
          if (item.type === STEP_TYPES.SCRIPT) {
            return this.buildScriptStep(item);
          }
          const promptValue = await this.validatePromptReference(
            item.prompt,
            promptFilePath
          );
          return this.buildPromptStep(promptValue, item);
        })
      );

      // Build PromptFile with workflow-level properties and prompts array
      const promptFile: PromptFile = {
        steps: resolvedPrompts,
      };

      const rawFinalStep = parsed.finalStep;
      if (rawFinalStep) {
        if (rawFinalStep.type === STEP_TYPES.SCRIPT) {
          promptFile.finalStep = this.buildScriptStep(rawFinalStep);
        } else if (typeof rawFinalStep.prompt === "string") {
          const promptValue = await this.validatePromptReference(
            rawFinalStep.prompt,
            promptFilePath
          );
          promptFile.finalStep = this.buildPromptStep(
            promptValue,
            rawFinalStep
          );
        }
      }

      // Copy workflow-level properties (if present)
      this.copyWorkflowLevelProperties(parsed, promptFile);

      return promptFile;
    }

    throw new Error("Invalid prompt file format");
  }

  /**
   * Copy workflow-level properties from parsed source to PromptFile.
   * Centralizes the property copying to avoid duplication between
   * single-prompt and multi-prompt normalization paths.
   */
  private copyWorkflowLevelProperties(
    parsed: any,
    promptFile: PromptFile
  ): void {
    for (const key of WORKFLOW_PROPERTY_KEYS) {
      const value = parsed[key];
      if (value !== undefined) {
        Object.assign(promptFile, {
          [key]:
            key === "worktree" && value === true
              ? { mode: WORKTREE_MODES.MANAGED }
              : value,
        });
      }
    }
    if (parsed.vars !== undefined) promptFile.vars = parsed.vars;
  }

  /** Copy every schema-backed execution property while preserving null values. */
  private copyExecutionProperties(
    source: Record<string, unknown>,
    target: ExecutionProperties
  ): void {
    for (const key of EXECUTION_PROPERTY_KEYS) {
      const value = source[key];
      if (value !== undefined) {
        Object.assign(target, { [key]: value });
      }
    }
  }

  /**
   * Discover prompt files in workspace
   */
  async discoverPromptFiles(workspaceFolderPath: string): Promise<string[]> {
    const promptsDirPath = path.join(
      workspaceFolderPath,
      PATH_CONSTANTS.CTRLYOKE_DIR
    );

    try {
      const files = await this.findPromptFilesRecursive(promptsDirPath);
      return files;
    } catch (error) {
      Log.debug(
        `ctrlyoke: Prompts directory ${promptsDirPath} not found or inaccessible`
      );
      return [];
    }
  }

  /**
   * Recursively find prompt files
   */
  private async findPromptFilesRecursive(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const subFiles = await this.findPromptFilesRecursive(fullPath);
          files.push(...subFiles);
        } else if (this.isPromptFile(entry.name)) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      // Directory might not exist or be accessible, ignore
    }

    return files;
  }

  /**
   * Check if file is a prompt file based on extension
   */
  private isPromptFile(filename: string): boolean {
    return (
      filename.endsWith(".ctrlyoke.json") ||
      filename.endsWith(".ctrlyoke.yaml") ||
      filename.endsWith(".ctrlyoke.yml") ||
      filename.endsWith(".prompt.md")
    );
  }

  /**
   * Validate workflow steps for execution.
   *
   * `finalStep` participates in the emptiness check only: a final-step-only
   * workflow has no queued steps by design (its final step appends them at
   * runtime), so passing it keeps that shape valid.
   */
  validateWorkflowSteps(
    items: WorkflowStep[],
    options?: { finalStep?: WorkflowStep | null }
  ): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!hasExecutableSteps({ steps: items, finalStep: options?.finalStep })) {
      errors.push("No steps found");
    }

    (items ?? []).forEach((item, index) => {
      // Script steps only require a non-empty script field
      if (isScriptStep(item)) {
        if (!item.script || item.script.trim().length === 0) {
          errors.push(`Step ${index + 1}: Empty script command`);
        }
        return;
      }

      if (!item.prompt || item.prompt.trim().length === 0) {
        errors.push(`Prompt ${index + 1}: Empty prompt text`);
      }

      if (item.endCondition) {
        if (!item.endCondition.script) {
          errors.push(`Prompt ${index + 1}: End condition missing script path`);
        }
        if (!item.endCondition.returns) {
          errors.push(
            `Prompt ${index + 1}: End condition missing expected return value`
          );
        }
      }
    });

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
