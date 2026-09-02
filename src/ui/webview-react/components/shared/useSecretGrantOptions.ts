import { useEffect, useMemo } from "react";
import {
  SECRET_REGISTRY_STATES,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import type { SecretRegistryEntry } from "@root/types/WebviewMessageTypes";
import { useSecretRegistryStore } from "../../store/secretRegistryStore";

export interface SecretGrantOption {
  value: string;
  label: string;
  description?: string;
}

export interface SecretGrantOptions {
  options: SecretGrantOption[];
  selectedValues: string[];
  lockedValues: string[];
  nonHideableValues: string[];
  unresolvedSecretNames: string[];
  unresolvedSecretDiagnostics: Array<{
    severity: "error";
    message: string;
  }>;
  warning?: string;
}

interface UseSecretGrantOptionsInput {
  declaredSecrets: readonly string[];
  inlineSecretNames: readonly string[];
}

const SECRET_REGISTRY_SCOPES = [
  SETTING_SCOPES.USER,
  SETTING_SCOPES.WORKSPACE,
] as const;

export function filterExplicitSecretGrants(
  selectedValues: readonly string[],
  inlineSecretNames: readonly string[]
): string[] {
  return selectedValues.filter((name) => !inlineSecretNames.includes(name));
}

function uniqueSortedNames(names: readonly string[]): string[] {
  return [...new Set(names)].sort();
}

function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names)];
}

/**
 * Builds the common secret-grant model used by workflow and prompt-step
 * controls. Inline references are visible and locked, but never declarations.
 */
export function useSecretGrantOptions({
  declaredSecrets,
  inlineSecretNames,
}: UseSecretGrantOptionsInput): SecretGrantOptions {
  const entriesByScope = useSecretRegistryStore(
    (state) => state.entriesByScope
  );
  const registryLoading = useSecretRegistryStore(
    (state) =>
      state.loadingByScope[SETTING_SCOPES.USER] ||
      state.loadingByScope[SETTING_SCOPES.WORKSPACE]
  );
  const requestEntries = useSecretRegistryStore(
    (state) => state.requestEntries
  );

  // Active grants may include names typed into the editor but not yet saved to
  // a workflow file on disk (e.g. an inline `!NAME` reference just added), so
  // the registry wouldn't otherwise discover them by scanning saved workflow
  // files. Pass them through as `additionalKnownNames` so the registry still
  // reports their real resolvable state instead of the panel treating an
  // unknown-but-resolvable name as unresolved.
  const activeGrantNamesKey = uniqueSortedNames([
    ...declaredSecrets,
    ...inlineSecretNames,
  ]).join(",");

  useEffect(() => {
    const activeGrantNames = activeGrantNamesKey
      ? activeGrantNamesKey.split(",")
      : [];
    for (const scope of SECRET_REGISTRY_SCOPES) {
      requestEntries(scope, activeGrantNames);
    }
  }, [requestEntries, activeGrantNamesKey]);

  return useMemo(() => {
    const registryEntries: SecretRegistryEntry[] = [
      ...entriesByScope[SETTING_SCOPES.USER],
      ...entriesByScope[SETTING_SCOPES.WORKSPACE],
    ];
    const inlineNames = uniqueNames(inlineSecretNames);
    const secretNames = uniqueSortedNames([
      ...registryEntries.map((entry) => entry.name),
      ...declaredSecrets,
      ...inlineNames,
    ]);
    const resolvableSecretNames = new Set(
      registryEntries
        .filter(
          (entry) =>
            entry.state === SECRET_REGISTRY_STATES.MANAGED_AND_SET ||
            entry.state === SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_DETECTED
        )
        .map((entry) => entry.name)
    );
    const selectedValues = uniqueNames([...declaredSecrets, ...inlineNames]);
    const unresolvedSecretNames =
      registryLoading && registryEntries.length === 0
        ? []
        : selectedValues.filter((name) => !resolvableSecretNames.has(name));

    return {
      options: secretNames.map((name) => ({
        value: name,
        label: name,
        description: inlineNames.includes(name)
          ? "Granted by prompt text"
          : undefined,
      })),
      selectedValues,
      lockedValues: inlineNames,
      nonHideableValues: secretNames,
      unresolvedSecretNames,
      unresolvedSecretDiagnostics: unresolvedSecretNames.map((name) => ({
        severity: "error" as const,
        message: `Secret "${name}" is not available from the managed registry or environment.`,
      })),
      warning:
        unresolvedSecretNames.length > 0
          ? `${unresolvedSecretNames.length} unresolved secret${unresolvedSecretNames.length === 1 ? "" : "s"}`
          : undefined,
    };
  }, [declaredSecrets, entriesByScope, inlineSecretNames, registryLoading]);
}
