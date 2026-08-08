import type { CompatibilityDiagnostic } from "../../../../types/CompatibilityTypes";

/** A deferred workspace or process-local change prepared for one launch. */
export interface PreparedMutation {
  /** Workspace path when the mutation targets a file; omitted for process-local changes. */
  readonly path?: string;
  /** Exact content intended for a file mutation, when applicable. */
  readonly intendedContent?: string;
  /**
   * Explicit, provider-supplied set of keys a partial merge into a shared file
   * will touch. ExecutionPreviewService.extractOwnedKeys is only a fallback
   * when this value is absent.
   */
  readonly ownedKeys?: string[];
  /** Human-readable description for process-local or merged-file mutations. */
  readonly description?: string;
  /** Apply the mutation immediately before the consuming process starts. */
  readonly apply: () => Promise<void>;
  /** Release the mutation after the consuming process exits, when supported. */
  readonly restore?: () => Promise<void>;
}

/** Pure provider preparation output shared by preview and real execution. */
export interface CliProviderPreparation {
  readonly cliArgs: string[];
  readonly mutations: PreparedMutation[];
  readonly diagnostics: CompatibilityDiagnostic[];
}

export async function applyPreparedMutations(
  mutations: readonly PreparedMutation[]
): Promise<void> {
  for (const mutation of mutations) {
    await mutation.apply();
  }
}
