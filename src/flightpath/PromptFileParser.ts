import * as vscode from "vscode";
import * as fs from "fs/promises";
import * as path from "path";
import Ajv from "ajv";
import { PromptFile, PromptItem } from "../types/FlightPathTypes";

export class PromptFileParser {
  private ajv = new Ajv();
  private promptSchema: any;
  private flightpathSchema: any;

  constructor() {
    this.loadSchemas();
  }

  private async loadSchemas(): Promise<void> {
    try {
      const promptSchemaPath = path.join(
        __dirname,
        "..",
        "schemas",
        "prompt-schema.json"
      );
      const flightpathSchemaPath = path.join(
        __dirname,
        "..",
        "schemas",
        "flightpath-schema.json"
      );

      const promptSchemaContent = await fs.readFile(promptSchemaPath, "utf8");
      const flightpathSchemaContent = await fs.readFile(
        flightpathSchemaPath,
        "utf8"
      );

      this.promptSchema = JSON.parse(promptSchemaContent);
      this.flightpathSchema = JSON.parse(flightpathSchemaContent);

      console.log("FlightPath: JSON schemas loaded successfully");
    } catch (error) {
      console.error("FlightPath: Failed to load JSON schemas:", error);
      vscode.window.showErrorMessage(
        "FlightPath: Failed to load validation schemas"
      );
    }
  }

  /**
   * Parse and validate a prompt file
   */
  async parsePromptFile(filePath: string): Promise<PromptFile | null> {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = JSON.parse(content);

      // Determine which schema to use based on file extension
      const isFlightpathFile = filePath.endsWith(".flightpath.json");
      const schema = isFlightpathFile
        ? this.flightpathSchema
        : this.promptSchema;

      if (schema && !this.ajv.validate(schema, parsed)) {
        const errors = this.ajv.errors
          ?.map((err) => `${err.instancePath}: ${err.message}`)
          .join(", ");
        throw new Error(`Validation failed: ${errors}`);
      }

      return this.normalizePromptFile(parsed);
    } catch (error) {
      console.error(`FlightPath: Failed to parse file ${filePath}:`, error);
      vscode.window.showErrorMessage(
        `FlightPath: Failed to parse ${path.basename(filePath)}: ${error}`
      );
      return null;
    }
  }

  /**
   * Normalize prompt file to consistent format
   */
  private normalizePromptFile(parsed: any): PromptFile {
    // Handle single prompt format
    if (parsed.prompt && typeof parsed.prompt === "string") {
      return {
        prompts: [
          {
            prompt: parsed.prompt,
            endCondition: parsed.endCondition,
          },
        ],
      };
    }

    // Handle multiple prompts format
    if (parsed.prompts && Array.isArray(parsed.prompts)) {
      return {
        prompts: parsed.prompts.map((item: any) => ({
          prompt: item.prompt,
          endCondition: item.endCondition,
        })),
      };
    }

    throw new Error("Invalid prompt file format");
  }

  /**
   * Discover prompt files in workspace
   */
  async discoverPromptFiles(
    workspaceFolder: vscode.WorkspaceFolder
  ): Promise<string[]> {
    const promptsDir = vscode.workspace
      .getConfiguration("flightpath")
      .get<string>("promptsDirectory", ".flightpath");
    const promptsDirPath = path.join(workspaceFolder.uri.fsPath, promptsDir);

    try {
      const files = await this.findPromptFilesRecursive(promptsDirPath);
      return files;
    } catch (error) {
      console.log(
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
      filename.endsWith(".prompt.json") || filename.endsWith(".flightpath.json")
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
