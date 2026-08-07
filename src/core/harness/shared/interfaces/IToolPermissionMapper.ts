import {
  CAPABILITY_FIDELITIES,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  PERMISSION_CAPABILITY_KEYS,
  PERMISSION_MODES,
  type HarnessId,
} from "../../../../types/DashboardConstants";
import type {
  CompatibilityDiagnostic,
  PermissionCapabilityDescriptor,
} from "../../../../types/CompatibilityTypes";
import {
  COMPATIBILITY_DIAGNOSTIC_CODES,
  getCompatibilityDiagnosticMessage,
} from "../../../../types/CompatibilityTypes";
import type { ToolPermissionConfig } from "../../../../types/ExecutionPropertyTypes";
import type { PreparedMutation } from "./PreparedMutation";

export type { PreparedMutation } from "./PreparedMutation";

export type {
  ToolPermissionConfig,
  ToolPermissionMode,
} from "../../../../types/ExecutionPropertyTypes";

/** Context needed to prepare one harness-specific permission application. */
export interface PermissionContext {
  readonly isInteractive?: boolean;
  readonly workspaceRoot?: string;
  readonly workingFilePath?: string;
  /** Codex-only mode settings, supplied by the provider. */
  readonly sandboxMode?: string;
  readonly approvalPolicy?: string;
  /** Existing permission keys used by config-driven harnesses for collision safety. */
  readonly permissionCollisionContext?: {
    readonly topLevelKeys: ReadonlySet<string>;
    readonly nestedKeysByTool: ReadonlyMap<string, ReadonlySet<string>>;
  };
}

/** A workspace-side effect to apply before launching the harness. */
export type WorkspacePermissionMutation = PreparedMutation;

/** Complete result of preparing one permission policy for one harness launch. */
export interface ToolPermissionApplication {
  readonly cliArgs: string[];
  readonly workspaceMutation?: WorkspacePermissionMutation;
  /** Additional process-local or workspace mutations owned by the provider. */
  readonly mutations?: PreparedMutation[];
  readonly diagnostics: CompatibilityDiagnostic[];
}

/**
 * Tool permission mapper interface
 *
 * Each CLI harness implements this to convert ctrlyoke's unified permission
 * configuration into their specific CLI arguments.
 *
 * Example conversions:
 * - Copilot: `shell(git:*)` → `--allow-tools shell(git:*)`
 * - Claude: `shell(git:*)` → `--tools "default"` (plus deny list)
 * - Codex: `shell(git:*)` → MCP tool configuration
 */
export interface IToolPermissionMapper {
  /**
   * Static permission facts owned by this harness mapper and referenced by the
   * harness descriptor. The backend registry evaluates these declarations
   * against the installed version.
   */
  readonly capabilities: PermissionCapabilityDescriptor;

  /**
   * Prepare the complete permission application for one harness launch.
   */
  prepare(
    config: ToolPermissionConfig,
    context: PermissionContext
  ): Promise<ToolPermissionApplication>;

  /**
   * Check if headless execution can proceed without interactive approval prompts.
   *
   * This can still include deny lists or sandbox restrictions. Those restrictions
   * auto-block matching operations, but they do not require a user approval UI.
   * @param config Tool permission configuration
   * @returns True if the harness will not wait for interactive tool approval
   */
  hasFullPermissions(config: ToolPermissionConfig): boolean;
}

/**
 * Shared utilities for tool permission mappers (optional base class)
 *
 * Provides common pattern parsing and validation utilities.
 * Providers can extend this class to avoid duplicating logic.
 */
export abstract class ToolPermissionMapperBase implements IToolPermissionMapper {
  abstract readonly capabilities: PermissionCapabilityDescriptor;
  abstract prepare(
    config: ToolPermissionConfig,
    context: PermissionContext
  ): Promise<ToolPermissionApplication>;

  /**
   * Produce runtime diagnostics when a configured tool list is not represented
   * by the mapper's declared capability. Version verification remains owned by
   * HarnessCapabilityRegistry; this only reports a lossy application.
   */
  protected getToolTranslationDiagnostics(
    config: ToolPermissionConfig,
    harnessId: HarnessId
  ): CompatibilityDiagnostic[] {
    if (
      config.mode !== PERMISSION_MODES.ALLOW_ALL &&
      config.mode !== PERMISSION_MODES.CUSTOM
    ) {
      return [];
    }

    const diagnostics: CompatibilityDiagnostic[] = [];
    for (const [key, patterns] of [
      [PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS, config.allowedTools],
      [PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS, config.deniedTools],
    ] as const) {
      if (patterns.length === 0) {
        continue;
      }
      const declaration = this.capabilities[key];
      if (declaration.fidelity === CAPABILITY_FIDELITIES.EXACT) {
        continue;
      }
      const unsupported = key === PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS;
      const code = unsupported
        ? declaration.fidelity === CAPABILITY_FIDELITIES.UNSUPPORTED
          ? COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_NOT_ENFORCED
          : COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_PARTIAL
        : declaration.fidelity === CAPABILITY_FIDELITIES.UNSUPPORTED
          ? COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_NOT_ENFORCED
          : COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_PARTIAL;
      diagnostics.push({
        code,
        severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
        harnessId,
        capability: key,
        state: {
          fidelity: declaration.fidelity,
          mechanism: declaration.mechanism,
          verification: CAPABILITY_VERIFICATION_STATUSES.UNKNOWN,
        },
        message: getCompatibilityDiagnosticMessage(code, {
          harnessId,
          capability: key,
          caveatCode: declaration.caveatCode,
        }),
      });
    }
    return diagnostics;
  }

  protected createLossyTranslationDiagnostic(
    harnessId: HarnessId,
    capability: "allowedTools" | "deniedTools"
  ): CompatibilityDiagnostic {
    const declaration = this.capabilities[capability];
    const code = COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_TRANSLATION_LOSSY;
    return {
      code,
      severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
      harnessId,
      capability,
      state: {
        fidelity: declaration.fidelity,
        mechanism: declaration.mechanism,
        verification: CAPABILITY_VERIFICATION_STATUSES.UNKNOWN,
      },
      message: getCompatibilityDiagnosticMessage(code, {
        harnessId,
        capability,
        caveatCode: declaration.caveatCode,
      }),
    };
  }

  /**
   * Default headless-safety check shared by permission-aware CLI harnesses.
   *
   * In allowAll/dangerouslyAllowAll modes, tool approval prompts are avoided.
   * Custom and none modes may require interactive approval or auto-deny tools
   * that are not explicitly allowed.
   */
  hasFullPermissions(config: ToolPermissionConfig): boolean {
    return (
      config.mode === PERMISSION_MODES.ALLOW_ALL ||
      config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL
    );
  }

  /**
   * Parse a tool pattern into name and arguments
   * @param pattern Tool pattern string (e.g., "shell(git:*)")
   * @returns [toolName, args] or null if invalid
   *
   * @example
   * parsePattern("shell(git:*)") → ["shell", "(git:*)"]
   * parsePattern("write") → ["write", ""]
   * parsePattern("invalid-pattern!") → null
   */
  protected parsePattern(pattern: string): [string, string] | null {
    const match = pattern.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)(\(.*\))?$/);
    if (!match) {
      return null;
    }
    return [match[1], match[2] || ""];
  }

  /**
   * Convert and deduplicate a list of tool patterns using the given converter.
   *
   * When converter returns null the original pattern is skipped (filtered out).
   * Pass a `filtered` array to collect those skipped patterns for diagnostics.
   */
  protected convertUnique(
    tools: string[],
    converter: (tool: string) => string | null,
    filtered?: string[]
  ): string[] {
    const result: string[] = [];
    for (const tool of tools) {
      const converted = converter(tool);
      if (converted === null) {
        filtered?.push(tool);
      } else if (!result.includes(converted)) {
        result.push(converted);
      }
    }
    return result;
  }
}
