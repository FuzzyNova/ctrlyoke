import * as fs from "fs/promises";
import * as path from "path";
import Ajv from "ajv";
import * as yaml from "js-yaml";
import {
  ExecutionProperties,
  ParallelGroupDefinition,
  PromptFile,
  PromptStep,
  WorkflowStep,
  ScriptStep,
  StepDisplayProperties,
  EXECUTION_PROPERTY_KEYS,
  isScriptStep,
  hasExecutableSteps,
  type ScriptProperties,
  type WorkflowValidationResult,
  type WorkflowValidationWarning,
} from "../types/CtrlYokeTypes";
import { PATH_CONSTANTS } from "../utils/ConfigurationUtils";
import * as WorkflowPaths from "../utils/WorkflowPaths";
import { stripLegacyWorkingFileLineageMetadata } from "../utils/WorkingFileMetadata";
import { Log } from "../utils/Log";
import { getVariableKeyErrors } from "../utils/KeyValueKeyKinds";
import type { PlatformAdapter } from "../platform/PlatformAdapter";
import { notifyUserFeedback, type UserFeedbackSink } from "./UserFeedbackSink";
import {
  STEP_TYPES,
  WORKFLOW_PROPERTY_KEYS,
  WORKFLOW_VALIDATION_WARNING_CODES,
  WORKTREE_MODES,
} from "../types/DashboardConstants";
import {
  describeIncompleteComparison,
  isComparisonIncomplete,
} from "../utils/ScriptComparison";
import { PromptFileResolver } from "./PromptFileResolver";
import {
  flattenParallelItems,
  normalizeParallelGroupTopology,
  type ResolvedParallelItem,
} from "./ParallelGroupTopology";

type ParallelValidationProperties = Pick<
  ExecutionProperties,
  "priorContext" | "sessionId"
>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Resolve the authored workflow path used for stable identity. Working files
 * retain the source path in `originalFile`; parsed files use their own path.
 */
export function getAuthoredSourcePath(
  parsedFilePath: string,
  originalFile?: string
): string {
  return originalFile ?? parsedFilePath;
}

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

      Log.debug("[PromptFileParser] JSON schema loaded successfully");
    } catch (error) {
      Log.error("[PromptFileParser] Failed to load JSON schema:", error);
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

      if (
        WorkflowPaths.parseWorkingFileAddressFromPath(filePath) &&
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      ) {
        stripLegacyWorkingFileLineageMetadata(parsed);
      }

      return await this.validateAndNormalize(parsed, filePath);
    } catch (error) {
      Log.error(`[PromptFileParser] Failed to parse file ${filePath}:`, error);
      if (this.userFeedbackSink) {
        notifyUserFeedback(
          this.userFeedbackSink,
          "error",
          `ctrlyoke: Failed to parse ${path.basename(filePath)}: ${error}`
        );
      } else {
        Log.error(
          `[PromptFileParser] ctrlyoke: Failed to parse ${path.basename(filePath)}: ${error}`
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
    this.validateAuthoredParallelStructure(parsed);

    if (
      parsed?.vars &&
      typeof parsed.vars === "object" &&
      !Array.isArray(parsed.vars)
    ) {
      const variableKeyErrors = getVariableKeyErrors(Object.keys(parsed.vars));
      if (variableKeyErrors.length > 0) {
        throw new Error(
          `Validation failed: vars: ${variableKeyErrors.join(", ")}`
        );
      }
    }

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
      Log.error(
        `[PromptFileParser] Failed to read markdown prompt file ${filePath}:`,
        error
      );
      if (this.userFeedbackSink) {
        notifyUserFeedback(
          this.userFeedbackSink,
          "error",
          `ctrlyoke: Failed to read ${path.basename(filePath)}: ${error}`
        );
      } else {
        Log.error(
          `[PromptFileParser] ctrlyoke: Failed to read ${path.basename(filePath)}: ${error}`
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
    this.copyStepDisplayProperties(source, step);
    if (source.executionMode !== undefined)
      step.executionMode = source.executionMode;
    if (source.secrets !== undefined) step.secrets = source.secrets;
    if (source.env !== undefined) step.env = source.env;
    if (source.timeoutSec !== undefined) step.timeoutSec = source.timeoutSec;
    if (source.compareSource !== undefined)
      step.compareSource = source.compareSource;
    if (source.operator !== undefined) step.operator = source.operator;
    if (source.expected !== undefined) step.expected = source.expected;
    if (source.ignoreCase !== undefined) step.ignoreCase = source.ignoreCase;
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
    this.copyStepDisplayProperties(source, promptStep);
    this.copyExecutionProperties(source, promptStep);

    return promptStep;
  }

  private copyStepDisplayProperties(
    source: Record<string, unknown>,
    step: StepDisplayProperties
  ): void {
    if (source.name !== undefined) step.name = source.name as string;
    if (source.enabled !== undefined) step.enabled = source.enabled as boolean;
    if (source.color !== undefined) step.color = source.color as string;
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
      const resolvedItems: ResolvedParallelItem[] = [];
      let resolvedStepCount = 0;
      let hasAuthoredParallelGroups = false;

      for (const item of parsed.steps) {
        if (isObject(item) && hasOwn(item, "parallel")) {
          const failFast = item.failFast;
          if (failFast !== undefined && typeof failFast !== "boolean") {
            throw new Error(
              `Step ${resolvedStepCount + 1}: parallel failFast must be a boolean`
            );
          }
          const resolvedMembers: WorkflowStep[] = await Promise.all(
            (item.parallel as any[]).map(async (member) => {
              if (member.type === STEP_TYPES.SCRIPT) {
                return this.buildScriptStep(member);
              }
              const promptValue = await this.validatePromptReference(
                member.prompt,
                promptFilePath
              );
              return this.buildPromptStep(promptValue, member);
            })
          );
          resolvedItems.push({
            parallel: resolvedMembers,
            failFast,
          });
          resolvedStepCount += resolvedMembers.length;
          hasAuthoredParallelGroups = true;
          continue;
        }

        if (item.type === STEP_TYPES.SCRIPT) {
          resolvedItems.push(this.buildScriptStep(item));
          resolvedStepCount += 1;
          continue;
        }
        const promptValue = await this.validatePromptReference(
          item.prompt,
          promptFilePath
        );
        resolvedItems.push(this.buildPromptStep(promptValue, item));
        resolvedStepCount += 1;
      }

      const hasParallelGroups =
        hasAuthoredParallelGroups || parsed.parallelGroups !== undefined;
      // Flatten first so both branches agree on step order. Root
      // `parallelGroups` and authored `parallel:` items are mutually exclusive
      // (`validateAuthoredParallelStructure` rejects a file carrying both), so
      // in the root branch flattening is the identity over a flat array.
      const flattened = flattenParallelItems(resolvedItems);
      const normalizedTopology =
        parsed.parallelGroups !== undefined
          ? normalizeParallelGroupTopology({
              steps: flattened.topology.steps,
              parallelGroups: parsed.parallelGroups,
            })
          : flattened.topology;
      const resolvedPrompts = normalizedTopology.steps;
      if (hasParallelGroups) {
        this.throwOnParallelReferenceErrors(
          resolvedPrompts,
          normalizedTopology.parallelGroups,
          parsed
        );
      }

      // Build PromptFile with workflow-level properties and prompts array
      const promptFile: PromptFile = {
        steps: resolvedPrompts,
      };
      if (hasParallelGroups) {
        promptFile.parallelGroups = normalizedTopology.parallelGroups;
      }

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
   * Validate authored-only parallel syntax before AJV so structural errors
   * remain specific instead of being reduced to a oneOf failure.
   */
  private validateAuthoredParallelStructure(parsed: unknown): void {
    if (!isObject(parsed)) {
      return;
    }

    if (hasOwn(parsed, "parallel")) {
      throw new Error(
        "`parallel` is only accepted as an item of the root `steps` array"
      );
    }

    const finalStep = parsed.finalStep;
    if (isObject(finalStep) && hasOwn(finalStep, "parallel")) {
      throw new Error("finalStep cannot be parallel");
    }

    if (!Array.isArray(parsed.steps)) {
      return;
    }

    const authoredGroups = parsed.steps.filter(
      (item): item is Record<string, unknown> =>
        isObject(item) && hasOwn(item, "parallel")
    );
    if (authoredGroups.length > 0 && parsed.parallelGroups !== undefined) {
      throw new Error(
        "A workflow cannot contain both `parallel:` items and root `parallelGroups`"
      );
    }

    parsed.steps.forEach((item, stepIndex) => {
      if (!isObject(item) || !hasOwn(item, "parallel")) {
        return;
      }
      if (!Array.isArray(item.parallel)) {
        throw new Error(`Step ${stepIndex + 1}: parallel must be an array`);
      }
      if (item.parallel.length < 2) {
        throw new Error(
          `Step ${stepIndex + 1}: parallel must contain at least two prompt or script steps`
        );
      }
      item.parallel.forEach((member, memberIndex) => {
        if (isObject(member) && hasOwn(member, "parallel")) {
          throw new Error(
            `Step ${stepIndex + 1}: parallel member ${memberIndex + 1} cannot be a nested parallel container`
          );
        }
        if (!this.isPromptOrScriptSource(member)) {
          throw new Error(
            `Step ${stepIndex + 1}: parallel member ${memberIndex + 1} must be a prompt or script step`
          );
        }
      });
    });
  }

  private isPromptOrScriptSource(source: unknown): boolean {
    if (!isObject(source)) {
      return false;
    }
    if (source.type === STEP_TYPES.SCRIPT) {
      return true;
    }
    return (
      (source.type === undefined || source.type === STEP_TYPES.PROMPT) &&
      typeof source.prompt === "string"
    );
  }

  private getParallelReferenceErrors(
    items: WorkflowStep[],
    parallelGroups: ParallelGroupDefinition[],
    workflowProperties?: ParallelValidationProperties
  ): string[] {
    const errors: string[] = [];

    for (const group of parallelGroups) {
      if (!group || typeof group !== "object") {
        continue;
      }
      if (
        !Number.isInteger(group.startIndex) ||
        !Number.isInteger(group.endIndex) ||
        group.startIndex < 0 ||
        group.endIndex >= items.length ||
        group.startIndex > group.endIndex
      ) {
        continue;
      }

      const groupStepNumbers = Array.from(
        { length: group.endIndex - group.startIndex + 1 },
        (_, offset) => group.startIndex + offset + 1
      );
      const groupStepNumberText = groupStepNumbers.join(", ");

      for (
        let stepIndex = group.startIndex;
        stepIndex <= group.endIndex;
        stepIndex++
      ) {
        const step = items[stepIndex];
        if (isScriptStep(step)) {
          continue;
        }

        const priorContext =
          step.priorContext !== undefined
            ? step.priorContext
            : workflowProperties?.priorContext;
        const sessionId =
          step.sessionId !== undefined
            ? step.sessionId
            : workflowProperties?.sessionId;

        const numericPriorContext = this.getNumericReferences(priorContext);
        for (const reference of numericPriorContext) {
          if (
            groupStepNumbers.includes(reference) &&
            reference !== stepIndex + 1
          ) {
            errors.push(
              `Step ${stepIndex + 1}: Numeric priorContext reference ${reference} cannot target a sibling in parallel group (steps ${groupStepNumberText})`
            );
          }
        }

        const numericSessionId = this.getNumericReferences(sessionId);
        for (const reference of numericSessionId) {
          if (
            groupStepNumbers.includes(reference) &&
            reference !== stepIndex + 1
          ) {
            errors.push(
              `Step ${stepIndex + 1}: Numeric sessionId reference ${reference} cannot target a sibling in parallel group (steps ${groupStepNumberText})`
            );
          }
        }
      }
    }

    return errors;
  }

  private getNumericReferences(value: unknown): number[] {
    if (typeof value === "number") {
      return [value];
    }
    if (Array.isArray(value)) {
      return value.filter(
        (reference): reference is number => typeof reference === "number"
      );
    }
    return [];
  }

  private throwOnParallelReferenceErrors(
    items: WorkflowStep[],
    parallelGroups: ParallelGroupDefinition[],
    workflowProperties?: ParallelValidationProperties
  ): void {
    const errors = this.getParallelReferenceErrors(
      items,
      parallelGroups,
      workflowProperties
    );
    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }
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
      Log.trace(
        `[PromptFileParser] ctrlyoke: Prompts directory ${promptsDirPath} not found or inaccessible`
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
   * Every script comparison a step can carry, with the RFC 6901 pointer prefix
   * that locates it. `preCondition` is nullable (explicitly disabled), so the
   * object check is load-bearing rather than defensive.
   */
  private static scriptComparisonSites(
    step: WorkflowStep,
    stepPointer: string
  ): { config: ScriptProperties; pointer: string }[] {
    // A script step *is* the comparison; only a prompt step wraps one in a
    // pre/end condition, and the two shapes are disjoint.
    if (isScriptStep(step)) {
      return [{ config: step, pointer: stepPointer }];
    }

    const sites: { config: ScriptProperties; pointer: string }[] = [];
    if (step.endCondition) {
      sites.push({
        config: step.endCondition,
        pointer: `${stepPointer}/endCondition`,
      });
    }
    if (step.preCondition) {
      sites.push({
        config: step.preCondition,
        pointer: `${stepPointer}/preCondition`,
      });
    }
    return sites;
  }

  /** Non-blocking findings for one step's script comparisons. */
  private static scriptComparisonWarnings(
    step: WorkflowStep,
    stepPointer: string,
    stepLabel: string
  ): WorkflowValidationWarning[] {
    return PromptFileParser.scriptComparisonSites(step, stepPointer)
      .filter(({ config }) => isComparisonIncomplete(config))
      .map(({ config, pointer }) => ({
        code: WORKFLOW_VALIDATION_WARNING_CODES.SCRIPT_COMPARISON_INCOMPLETE,
        message: `${stepLabel}: ${describeIncompleteComparison(config)}`,
        propertyPointer: `${pointer}/expected`,
      }));
  }

  /**
   * Validate workflow steps for execution.
   *
   * `finalStep` participates in the emptiness check only: a final-step-only
   * workflow has no queued steps by design (its final step appends them at
   * runtime), so passing it keeps that shape valid. It is still scanned for
   * warnings, which describe what will happen rather than whether it can run.
   */
  validateWorkflowSteps(
    items: WorkflowStep[],
    options?: {
      finalStep?: WorkflowStep | null;
      parallelGroups?: ParallelGroupDefinition[];
      workflowProperties?: ParallelValidationProperties;
    }
  ): WorkflowValidationResult {
    const errors: string[] = [];
    const warnings: WorkflowValidationWarning[] = [];

    if (!hasExecutableSteps({ steps: items, finalStep: options?.finalStep })) {
      errors.push("No steps found");
    }

    if (options?.parallelGroups !== undefined) {
      try {
        normalizeParallelGroupTopology({
          steps: items,
          parallelGroups: options.parallelGroups,
        });
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
      errors.push(
        ...this.getParallelReferenceErrors(
          items,
          options.parallelGroups,
          options.workflowProperties
        )
      );
    }

    (items ?? []).forEach((item, index) => {
      warnings.push(
        ...PromptFileParser.scriptComparisonWarnings(
          item,
          `/steps/${index}`,
          `Step ${index + 1}`
        )
      );

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
        // `expected` is optional — omitting it means "pass when the script
        // exits 0". A leftover `returns` is named explicitly so the rename is
        // obvious rather than silently dropping the author's comparison.
        if ("returns" in item.endCondition) {
          errors.push(
            `Prompt ${index + 1}: End condition \`returns\` was renamed to \`expected\`; omit it entirely to pass on exit code 0`
          );
        }
      }
    });

    if (options?.finalStep) {
      warnings.push(
        ...PromptFileParser.scriptComparisonWarnings(
          options.finalStep,
          "/finalStep",
          "Final step"
        )
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }
}
