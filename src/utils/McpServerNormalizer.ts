import {
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  CTRLYOKE_SLASH_TOKEN_KINDS,
  PROMPT_DIAGNOSTIC_CODES,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
} from "../types/DashboardConstants";
import type { CompatibilityDiagnostic } from "../types/CompatibilityTypes";
import type { McpServerConfig } from "../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../types/ExecutionPropertyTypes";
import type { ManagedMcpServer } from "../types/WebviewMessageTypes";
import {
  McpRegistryFileManager,
  resolveCtrlYokeMcpInvocation,
} from "./McpRegistryFileManager";
import { scanCtrlYokeSlashTokens } from "./CtrlYokeSlashTokens";
import { Log } from "./Log";
import { collectSecretInterpolationNames } from "./SecretResolver";

export interface McpServerNormalizationResult {
  readonly properties: ResolvedProperties;
  readonly diagnostics: readonly CompatibilityDiagnostic[];
  /** Secret references from selected user-scope registry entries. */
  readonly trustedUserScopeSecretNames: readonly string[];
}

/**
 * Resolve registry IDs in the effective MCP property before any harness
 * consumer plans process configuration.
 *
 * The reserved ctrlyoke ID is intentionally kept as a string. Claude and
 * Copilot use that sentinel to decide whether their own MCP server must be
 * included, while every other managed server needs its full config.
 */
export class McpServerNormalizer {
  static async applyFromRegistryWithDiagnostics(
    properties: ResolvedProperties,
    workspaceRoot: string | undefined,
    effectivePromptText: string
  ): Promise<McpServerNormalizationResult> {
    const registry = new McpRegistryFileManager(workspaceRoot);
    return this.applyWithDiagnostics(
      properties,
      await registry.readAll(),
      effectivePromptText
    );
  }

  static async apply(
    properties: ResolvedProperties,
    managedServers: readonly ManagedMcpServer[],
    effectivePromptText = ""
  ): Promise<ResolvedProperties> {
    return (
      await this.applyWithDiagnostics(
        properties,
        managedServers,
        effectivePromptText
      )
    ).properties;
  }

  static async applyWithDiagnostics(
    properties: ResolvedProperties,
    managedServers: readonly ManagedMcpServer[],
    effectivePromptText = ""
  ): Promise<McpServerNormalizationResult> {
    const diagnostics: CompatibilityDiagnostic[] = [];
    const mcpTokens = scanCtrlYokeSlashTokens(effectivePromptText).filter(
      (token) => token.kind === CTRLYOKE_SLASH_TOKEN_KINDS.MCP
    );
    const knownInlineTokens = mcpTokens.filter(
      (token) =>
        token.name === SPECIAL_TARGET_IDS.CTRLYOKE ||
        resolveCtrlYokeMcpInvocation(managedServers, token.name)
    );
    if (properties.mcpServers === null && knownInlineTokens.length === 0) {
      diagnostics.push(
        ...mcpTokens.map((token) =>
          this.createUnknownReferenceDiagnostic(properties, token.name)
        )
      );
      return {
        properties,
        diagnostics,
        trustedUserScopeSecretNames: [],
      };
    }
    const unknownIds = new Set<string>();
    const normalizedServers: (string | McpServerConfig)[] = [];
    const addServer = (server: string | McpServerConfig): void => {
      const id = typeof server === "string" ? server : server.id;
      if (
        !normalizedServers.some(
          (current) =>
            (typeof current === "string" ? current : current.id) === id
        )
      ) {
        normalizedServers.push(server);
      }
    };

    for (const server of properties.mcpServers ?? []) {
      if (typeof server !== "string") {
        addServer(server);
        continue;
      }

      if (server === SPECIAL_TARGET_IDS.CTRLYOKE) {
        addServer(server);
        continue;
      }

      const resolved = resolveCtrlYokeMcpInvocation(managedServers, server);
      if (resolved) {
        addServer(resolved);
      } else {
        unknownIds.add(server);
      }
    }

    for (const token of mcpTokens) {
      if (token.name === SPECIAL_TARGET_IDS.CTRLYOKE) {
        addServer(SPECIAL_TARGET_IDS.CTRLYOKE);
        continue;
      }

      const resolved = resolveCtrlYokeMcpInvocation(managedServers, token.name);
      if (!resolved) {
        diagnostics.push(
          this.createUnknownReferenceDiagnostic(properties, token.name)
        );
        continue;
      }

      addServer(resolved);
    }

    for (const unknownId of unknownIds) {
      Log.warn(
        `[McpServerNormalizer] MCP server ID "${unknownId}" was not found in the ctrlyoke registry; dropping it`
      );
    }

    const trustedUserScopeSecretNames = new Set<string>();
    for (const server of managedServers) {
      const hasUserLocation = server.locations.some(
        (location) => location.scope === SETTING_SCOPES.USER
      );
      const hasWorkspaceOverride = server.locations.some(
        (location) => location.scope === SETTING_SCOPES.WORKSPACE
      );
      const selectedFromRegistry = normalizedServers.some(
        (normalized) => normalized === server.config
      );
      if (
        selectedFromRegistry &&
        hasUserLocation &&
        !hasWorkspaceOverride
      ) {
        for (const name of [
          ...collectSecretInterpolationNames(server.config.env),
          ...collectSecretInterpolationNames(server.config.headers),
        ]) {
          trustedUserScopeSecretNames.add(name);
        }
      }
    }

    return {
      properties: {
        ...properties,
        mcpServers: normalizedServers,
      },
      diagnostics,
      trustedUserScopeSecretNames: [...trustedUserScopeSecretNames],
    };
  }

  private static createUnknownReferenceDiagnostic(
    properties: ResolvedProperties,
    name: string
  ): CompatibilityDiagnostic {
    return {
      code: PROMPT_DIAGNOSTIC_CODES.UNKNOWN_MCP_REFERENCE,
      severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
      harnessId: properties.harness,
      capability: "mcpServers",
      state: {
        fidelity: CAPABILITY_FIDELITIES.PARTIAL,
        mechanism: CAPABILITY_MECHANISMS.NONE,
        verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
      },
      message: `MCP server "${name}" referenced by /mcp:${name} was not found in the ctrlyoke registry.`,
    };
  }
}
