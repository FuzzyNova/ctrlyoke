import * as fs from "fs/promises";
import * as path from "path";
import Ajv from "ajv";
import * as yaml from "js-yaml";
import { PromptFile, PromptItem } from "../types/FlightPathTypes";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { Log } from "../utils/Log";
import type { PlatformAdapter } from "../platform/PlatformAdapter";

/**
 * Extensions that indicate a prompt value might be a file path
 * We try to resolve these as files first, falling back to literal text if not found
 */
const PROMPT_FILE_EXTENSIONS = [".prompt.md", ".md", ".txt"] as const;

export class PromptFileParser {
  private ajv = new Ajv({ allowUnionTypes: true });
  private promptSchema: any;

  constructor(private readonly platform?: PlatformAdapter) {
    this.loadSchemas();
  }

  private loadSchemas(): void {
    try {
      // Load schema from bundled location (copied from /schemas during build)
      const promptSchemaPath = path.join(
        __dirname,
        "..",
        "schemas",
        "prompt-schema.json"
      );

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
      if (this.platform) {
        this.platform.error("FlightPath: Failed to load validation schema");
      } else {
        Log.error("FlightPath: Failed to load validation schema");
      }
    }
  }

  /**
   * Parse and validate a prompt file
   * Supports .flightpath.yaml/.yml, .flightpath.json, and .prompt.md files
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
            schema: yaml.DEFAULT_SCHEMA,
            json: false, // Use YAML semantics, not JSON compatibility mode
          });
        } catch (yamlError: any) {
          throw new Error(
            `YAML parsing error: ${yamlError.message || yamlError}`
          );
        }
      } else if (ext === ".json") {
        // Parse JSON (.flightpath.json only, .prompt.json removed)
        parsed = JSON.parse(content);
      } else {
        throw new Error(
          `Unsupported file extension: ${ext}. Supported: .yaml, .yml, .json, .md`
        );
      }

      // Validate against schema (same for both JSON and YAML)
      if (this.promptSchema && !this.ajv.validate(this.promptSchema, parsed)) {
        const errors = this.ajv.errors
          ?.map((err) => `${err.instancePath}: ${err.message}`)
          .join(", ");
        throw new Error(`Validation failed: ${errors}`);
      }

      return await this.normalizePromptFile(parsed, filePath);
    } catch (error) {
      Log.error(`Failed to parse file ${filePath}:`, error);
      if (this.platform) {
        this.platform.error(
          `FlightPath: Failed to parse ${path.basename(filePath)}: ${error}`
        );
      } else {
        Log.error(
          `FlightPath: Failed to parse ${path.basename(filePath)}: ${error}`
        );
      }
      return null;
    }
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
        prompts: [
          {
            prompt: promptText,
            // Properties omitted will be undefined - global setting used at execution time
          },
        ],
      };
    } catch (error) {
      Log.error(`Failed to read markdown prompt file ${filePath}:`, error);
      if (this.platform) {
        this.platform.error(
          `FlightPath: Failed to read ${path.basename(filePath)}: ${error}`
        );
      } else {
        Log.error(
          `FlightPath: Failed to read ${path.basename(filePath)}: ${error}`
        );
      }
      return null;
    }
  }

  /**
   * Check if a prompt value looks like it could be a file path
   * This is a heuristic check - we verify file existence separately
   *
   * IMPORTANT: This should ONLY match pure file paths, not prompts that happen to
   * contain file references like #selection:path/to/file.ts or "help me with ./file.md"
   */
  private looksLikeFilePath(promptValue: string): boolean {
    const trimmed = promptValue.trim();

    // Skip if it starts with # - that's a FlightPath reference (#selection:, #sym:, etc.), not a prompt file path
    if (trimmed.startsWith("#")) {
      return false;
    }

    // A prompt file reference must be ONLY a path - no other text before or after
    // Check if it starts with a valid path indicator
    const startsWithRelative =
      trimmed.startsWith("./") || trimmed.startsWith("../");
    const startsWithDriveLetter = /^[a-zA-Z]:[/\\]/.test(trimmed);
    const startsWithUnixAbsolute = trimmed.startsWith("/");

    const isPathLike =
      startsWithRelative || startsWithDriveLetter || startsWithUnixAbsolute;

    // If it doesn't start like a path, it's not a file reference
    if (!isPathLike) {
      return false;
    }

    // Check for known file extensions at the END of the string
    const hasKnownExtension = PROMPT_FILE_EXTENSIONS.some((ext) =>
      trimmed.toLowerCase().endsWith(ext)
    );
    if (hasKnownExtension) {
      return true;
    }

    // For other extensions, also require ending with an extension pattern
    const endsWithExtension = /\.\w+$/.test(trimmed);

    return endsWithExtension;
  }

  /**
   * Resolve a prompt value that might be a file path
   * Returns the file content if path resolves to a file, otherwise returns original value
   *
   * @param promptValue The prompt string (might be literal text or file path)
   * @param promptFilePath Path to the prompt file containing this value (for relative resolution)
   * @returns The resolved prompt content
   */
  private async resolvePromptContent(
    promptValue: string,
    promptFilePath: string
  ): Promise<string> {
    // Quick check - if it doesn't look like a file path, return as-is
    if (!this.looksLikeFilePath(promptValue)) {
      return promptValue;
    }

    const trimmedPath = promptValue.trim();

    // Try to resolve the file path
    const resolvedPath = await this.resolvePromptFilePath(
      trimmedPath,
      promptFilePath
    );

    if (!resolvedPath) {
      // File not found - warn user if it looks like an intentional prompt file reference
      const looksIntentional = PROMPT_FILE_EXTENSIONS.some((ext) =>
        trimmedPath.toLowerCase().endsWith(ext)
      );

      if (looksIntentional) {
        Log.warn(
          `Prompt file reference not found, using as literal text: "${trimmedPath}"`
        );
        this.platform?.warn(
          `FlightPath: Could not find prompt file "${trimmedPath}". Using as literal prompt text.`
        );
      }

      return promptValue;
    }

    // Read the file content
    try {
      const content = await fs.readFile(resolvedPath, "utf8");
      const trimmedContent = content.trim();

      if (!trimmedContent) {
        Log.warn(`Referenced prompt file is empty: ${trimmedPath}`);
        return promptValue; // Return original if file is empty
      }

      Log.debug(`Resolved prompt from file: ${trimmedPath} -> ${resolvedPath}`);
      return trimmedContent;
    } catch (error) {
      Log.error(`Failed to read prompt file ${resolvedPath}:`, error);
      return promptValue; // Return original on read error
    }
  }

  /**
   * Resolve a file path relative to the prompt file or workspace
   * Resolution order:
   * 1. Absolute paths
   * 2. Relative to prompt file's directory
   * 3. Relative to workspace root
   * 4. Relative to .flightpath directory
   *
   * @param filePath The file path to resolve
   * @param promptFilePath Path to the prompt file (for relative resolution)
   * @returns Resolved absolute path if file exists, null otherwise
   */
  private async resolvePromptFilePath(
    filePath: string,
    promptFilePath: string
  ): Promise<string | null> {
    // Try absolute path first
    if (path.isAbsolute(filePath)) {
      if (await this.fileExists(filePath)) {
        return filePath;
      }
      return null;
    }

    // Try relative to prompt file's directory
    const promptDir = path.dirname(promptFilePath);
    const relativeToPrompt = path.resolve(promptDir, filePath);
    if (await this.fileExists(relativeToPrompt)) {
      return relativeToPrompt;
    }

    // Try relative to workspace root
    const workspaceRoot = this.platform?.getWorkspaceRoot();
    if (workspaceRoot) {
      const relativeToWorkspace = path.resolve(workspaceRoot, filePath);
      if (await this.fileExists(relativeToWorkspace)) {
        return relativeToWorkspace;
      }

      // Try in .flightpath directory
      const flightpathDir = ConfigurationUtils.getPromptsDirectory();
      const relativeToFlightpath = path.resolve(
        workspaceRoot,
        flightpathDir,
        filePath
      );
      if (await this.fileExists(relativeToFlightpath)) {
        return relativeToFlightpath;
      }
    }

    return null;
  }

  /**
   * Check if a file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build a PromptItem with only explicitly set properties
   * @param promptText The resolved prompt text
   * @param source The source object (parsed JSON/YAML)
   * @returns PromptItem with only defined properties
   */
  private buildPromptItem(promptText: string, source: any): PromptItem {
    const promptItem: PromptItem = { prompt: promptText };

    // Only include properties that are explicitly set
    if (source.name !== undefined) promptItem.name = source.name;
    if (source.harness !== undefined) promptItem.harness = source.harness;
    if (source.model !== undefined) promptItem.model = source.model;
    if (source.agent !== undefined) promptItem.agent = source.agent;
    if (source.skills !== undefined) promptItem.skills = source.skills;
    if (source.resumeSession !== undefined)
      promptItem.resumeSession = source.resumeSession;
    if (source.sessionId !== undefined) promptItem.sessionId = source.sessionId;
    if (source.allowDynamicExtension !== undefined)
      promptItem.allowDynamicExtension = source.allowDynamicExtension;
    if (source.endCondition !== undefined)
      promptItem.endCondition = source.endCondition;
    if (source.priorContext !== undefined)
      promptItem.priorContext = source.priorContext;
    if (source.additionalArgs !== undefined)
      promptItem.additionalArgs = source.additionalArgs;

    return promptItem;
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
    // Handle single prompt format
    if (parsed.prompt && typeof parsed.prompt === "string") {
      const resolvedPrompt = await this.resolvePromptContent(
        parsed.prompt,
        promptFilePath
      );

      // Build PromptFile with workflow-level properties and single prompt
      const promptFile: PromptFile = {
        prompts: [this.buildPromptItem(resolvedPrompt, parsed)],
      };

      // Copy workflow-level properties (if present)
      this.copyWorkflowLevelProperties(parsed, promptFile);

      return promptFile;
    }

    // Handle multiple prompts format
    if (parsed.prompts && Array.isArray(parsed.prompts)) {
      const resolvedPrompts = await Promise.all(
        parsed.prompts.map(async (item: any) => {
          const resolvedPrompt = await this.resolvePromptContent(
            item.prompt,
            promptFilePath
          );
          return this.buildPromptItem(resolvedPrompt, item);
        })
      );

      // Build PromptFile with workflow-level properties and prompts array
      const promptFile: PromptFile = {
        prompts: resolvedPrompts,
      };

      if (parsed.finalPrompt && typeof parsed.finalPrompt.prompt === "string") {
        const resolvedFinalPrompt = await this.resolvePromptContent(
          parsed.finalPrompt.prompt,
          promptFilePath
        );
        promptFile.finalPrompt = this.buildPromptItem(
          resolvedFinalPrompt,
          parsed.finalPrompt
        );
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
    if (parsed.harness !== undefined) promptFile.harness = parsed.harness;
    if (parsed.model !== undefined) promptFile.model = parsed.model;
    if (parsed.agent !== undefined) promptFile.agent = parsed.agent;
    if (parsed.skills !== undefined) promptFile.skills = parsed.skills;
    if (parsed.resumeSession !== undefined)
      promptFile.resumeSession = parsed.resumeSession;
    if (parsed.sessionId !== undefined) promptFile.sessionId = parsed.sessionId;
    if (parsed.allowDynamicExtension !== undefined)
      promptFile.allowDynamicExtension = parsed.allowDynamicExtension;
    if (parsed.endCondition !== undefined)
      promptFile.endCondition = parsed.endCondition;
    if (parsed.priorContext !== undefined)
      promptFile.priorContext = parsed.priorContext;
    if (parsed.additionalArgs !== undefined)
      promptFile.additionalArgs = parsed.additionalArgs;
  }

  /**
   * Discover prompt files in workspace
   */
  async discoverPromptFiles(workspaceFolderPath: string): Promise<string[]> {
    const promptsDir = ConfigurationUtils.getPromptsDirectory();
    const promptsDirPath = path.join(workspaceFolderPath, promptsDir);

    try {
      const files = await this.findPromptFilesRecursive(promptsDirPath);
      return files;
    } catch (error) {
      Log.debug(
        `FlightPath: Prompts directory ${promptsDirPath} not found or inaccessible`
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
      filename.endsWith(".flightpath.json") ||
      filename.endsWith(".flightpath.yaml") ||
      filename.endsWith(".flightpath.yml") ||
      filename.endsWith(".prompt.md")
    );
  }

  /**
   * Validate prompt items for execution
   */
  validatePromptItems(items: PromptItem[]): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!items || items.length === 0) {
      errors.push("No prompts found");
    }

    items.forEach((item, index) => {
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
