import Ajv, { JSONSchemaType, ValidateFunction } from "ajv";
import {
  PromptFile,
  PromptItem,
  EndCondition,
  Harness,
} from "../types/FlightPathTypes";
import { Log } from "./Log";
import {
  COPILOT_CLI_MODEL_IDS,
  CLAUDE_CLI_MODELS,
  CODEX_CLI_MODELS,
} from "./ModelConstants";

/**
 * Build the model enum dynamically from ModelConstants (single source of truth).
 * Combines all CLI model IDs and deduplicates.
 */
const ALL_MODEL_IDS: string[] = [
  ...new Set([
    ...COPILOT_CLI_MODEL_IDS,
    ...CLAUDE_CLI_MODELS,
    ...CODEX_CLI_MODELS,
  ]),
];

export class ValidationUtils {
  private static ajv = new Ajv({ allErrors: true });

  // Schema for PromptItem
  private static promptItemSchema: JSONSchemaType<PromptItem> = {
    type: "object",
    properties: {
      name: {
        type: "string",
        nullable: true,
      },
      prompt: { type: "string" },
      model: {
        type: "string",
        enum: ALL_MODEL_IDS as unknown as readonly string[],
        nullable: true,
      },
      harness: {
        type: "string",
        enum: [
          Harness.CopilotCli,
          Harness.CopilotChat,
          Harness.ClaudeCli,
          Harness.CodexCli,
        ],
        nullable: true,
      },
      agent: {
        type: "string",
        nullable: true,
      },
      skills: {
        type: "array",
        items: { type: "string" },
        nullable: true,
      },
      resumeSession: {
        type: "boolean",
        nullable: true,
      },
      allowDynamicExtension: {
        type: "boolean",
        nullable: true,
      },
      endCondition: {
        type: "object",
        properties: {
          script: { type: "string" },
          returns: { type: "string" },
          timeout: { type: "number", nullable: true },
          maxRetries: { type: "number", nullable: true },
          retryPrompt: { type: "string", nullable: true },
        },
        required: ["script", "returns"],
        nullable: true,
      },
      sessionId: {
        type: ["string", "number"] as any, // Allow both string and number for session IDs
        nullable: true,
      },
      _runtime: {
        type: "object",
        properties: {
          sessionId: { type: "string", nullable: true },
          startedAt: { type: "number" },
          completedAt: { type: "number", nullable: true },
          retryCount: { type: "number", nullable: true },
          // Runtime can also inherit ExecutionProperties
          harness: {
            type: "string",
            enum: [
              Harness.CopilotCli,
              Harness.CopilotChat,
              Harness.ClaudeCli,
              Harness.CodexCli,
            ],
            nullable: true,
          },
          model: { type: "string", nullable: true },
          agent: { type: "string", nullable: true },
          skills: { type: "array", items: { type: "string" }, nullable: true },
          resumeSession: { type: "boolean", nullable: true },
          allowDynamicExtension: { type: "boolean", nullable: true },
          endCondition: {
            type: "object",
            properties: {
              script: { type: "string" },
              returns: { type: "string" },
              timeout: { type: "number", nullable: true },
              maxRetries: { type: "number", nullable: true },
              retryPrompt: { type: "string", nullable: true },
            },
            required: ["script", "returns"],
            nullable: true,
          },
        },
        required: ["startedAt"],
        nullable: true,
      },
    },
    required: ["prompt"],
    additionalProperties: false,
  };

  // Compiled validators
  private static promptItemValidator = ValidationUtils.ajv.compile(
    ValidationUtils.promptItemSchema
  );

  static validatePromptItem(item: any): { valid: boolean; errors: string[] } {
    const valid = ValidationUtils.promptItemValidator(item);
    const errors =
      ValidationUtils.promptItemValidator.errors?.map(
        (err) => `${err.instancePath || "root"}: ${err.message}`
      ) || [];

    return { valid, errors };
  }

  static validatePromptItems(items: any[]): {
    valid: boolean;
    errors: string[];
  } {
    if (!Array.isArray(items)) {
      return { valid: false, errors: ["Expected array of prompt items"] };
    }

    const allErrors: string[] = [];
    let allValid = true;

    items.forEach((item, index) => {
      const result = ValidationUtils.validatePromptItem(item);
      if (!result.valid) {
        allValid = false;
        allErrors.push(
          ...result.errors.map((error) => `Item ${index + 1}: ${error}`)
        );
      }
    });

    return { valid: allValid, errors: allErrors };
  }

  static validateEndCondition(condition: any): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!condition) {
      return { valid: true, errors: [] }; // End condition is optional
    }

    if (typeof condition !== "object") {
      return { valid: false, errors: ["End condition must be an object"] };
    }

    if (!condition.script || typeof condition.script !== "string") {
      errors.push("End condition must have a script property (string)");
    }

    if (!condition.returns || typeof condition.returns !== "string") {
      errors.push("End condition must have a returns property (string)");
    }

    if (
      condition.timeout !== undefined &&
      (typeof condition.timeout !== "number" || condition.timeout <= 0)
    ) {
      errors.push("End condition timeout must be a positive number");
    }

    if (
      condition.maxRetries !== undefined &&
      (typeof condition.maxRetries !== "number" ||
        condition.maxRetries < -1 ||
        (condition.maxRetries > 100 && condition.maxRetries !== -1))
    ) {
      errors.push(
        "End condition maxRetries must be -1 (unlimited) or between 0 and 100"
      );
    }

    // Warn about high retry counts
    if (
      condition.maxRetries !== undefined &&
      condition.maxRetries > 20 &&
      condition.maxRetries !== -1
    ) {
      Log.warn(
        `High maxRetries value (${condition.maxRetries}). Consider using -1 for unlimited or a lower value.`
      );
    }

    if (
      condition.retryPrompt !== undefined &&
      typeof condition.retryPrompt !== "string"
    ) {
      errors.push("End condition retryPrompt must be a string");
    }

    return { valid: errors.length === 0, errors };
  }

  static validatePromptFile(file: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!file || typeof file !== "object") {
      return { valid: false, errors: ["Prompt file must be an object"] };
    }

    // Check if it's a single prompt or multiple prompts format
    const hasSinglePrompt = file.prompt && typeof file.prompt === "string";
    const hasMultiplePrompts = file.prompts && Array.isArray(file.prompts);

    if (!hasSinglePrompt && !hasMultiplePrompts) {
      errors.push(
        'Prompt file must have either a "prompt" string or "prompts" array'
      );
    }

    if (hasSinglePrompt && hasMultiplePrompts) {
      errors.push(
        'Prompt file cannot have both "prompt" and "prompts" properties'
      );
    }

    if (hasSinglePrompt) {
      // Validate single prompt format
      const promptItem = {
        prompt: file.prompt,
        endCondition: file.endCondition,
      };
      const result = ValidationUtils.validatePromptItem(promptItem);
      if (!result.valid) {
        errors.push(...result.errors);
      }
    }

    if (hasMultiplePrompts) {
      // Validate multiple prompts format
      const result = ValidationUtils.validatePromptItems(file.prompts);
      if (!result.valid) {
        errors.push(...result.errors);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Sanitize prompt text by removing control characters.
   *
   * @internal Only called from tests — not used in production code paths.
   */
  static sanitizePromptText(prompt: string): string {
    if (typeof prompt !== "string") {
      return "";
    }

    // Remove potentially harmful characters or patterns
    return prompt
      .trim()
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // Remove control characters
      .replace(/\${[^}]*}/g, (match) => {
        // Keep template variables but log them
        Log.info(`Template variable found: ${match}`);
        return match;
      });
  }

  static validateScriptPath(scriptPath: string): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!scriptPath || typeof scriptPath !== "string") {
      errors.push("Script path must be a non-empty string");
      return { valid: false, errors };
    }

    // Check for potentially dangerous patterns
    const dangerousPatterns = [
      /\.\./, // Directory traversal
      /[<>|]/, // Shell redirection
      /[;&`$]/, // Shell command injection
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(scriptPath)) {
        errors.push(
          `Script path contains potentially dangerous characters: ${scriptPath}`
        );
        break;
      }
    }

    // Check file extension
    const allowedExtensions = [
      ".py",
      ".js",
      ".ts",
      ".sh",
      ".bat",
      ".cmd",
      ".ps1",
    ];
    const hasValidExtension = allowedExtensions.some((ext) =>
      scriptPath.toLowerCase().endsWith(ext)
    );

    if (!hasValidExtension) {
      errors.push(
        `Script must have one of the allowed extensions: ${allowedExtensions.join(", ")}`
      );
    }

    return { valid: errors.length === 0, errors };
  }

  static validateTimeout(timeout: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (timeout === undefined || timeout === null) {
      return { valid: true, errors: [] }; // Timeout is optional
    }

    if (typeof timeout !== "number") {
      errors.push("Timeout must be a number");
      return { valid: false, errors };
    }

    if (timeout <= 0) {
      errors.push("Timeout must be positive");
    }

    if (timeout > 300000) {
      // 5 minutes max
      errors.push("Timeout cannot exceed 5 minutes (300000ms)");
    }

    return { valid: errors.length === 0, errors };
  }

  static createValidationSummary(
    validationResults: Array<{ valid: boolean; errors: string[] }>
  ): {
    valid: boolean;
    errorCount: number;
    errors: string[];
  } {
    const allErrors: string[] = [];
    let allValid = true;

    validationResults.forEach((result) => {
      if (!result.valid) {
        allValid = false;
        allErrors.push(...result.errors);
      }
    });

    return {
      valid: allValid,
      errorCount: allErrors.length,
      errors: allErrors,
    };
  }
}
