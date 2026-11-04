import type {
  CompatibilityDiagnostic,
  CapabilityDeclaration,
} from "../../../../types/CompatibilityTypes";
import type {
  EffectiveSandboxKind,
  SandboxMode,
  SandboxRequest,
} from "../../../../types/DashboardConstants";

export interface EffectiveSandbox {
  kind: EffectiveSandboxKind;
  detail?: string;
}

export interface SandboxApplication {
  cliArgs: string[];
  /** Merge into the harness's single settings payload. */
  settings?: Record<string, unknown>;
  /** Variables set on the harness process (Qwen's QWEN_SANDBOX outranks its flag). */
  env?: Record<string, string>;
  diagnostics: CompatibilityDiagnostic[];
  effective: EffectiveSandbox;
}

export interface SandboxContext {
  isInteractive: boolean;
  writableRoots: readonly string[];
  /** How strict `sandbox: true` is. */
  sandboxMode: SandboxMode;
  /**
   * The request was inherited from `defaults.sandbox` rather than written in
   * the workflow or step. A harness that can't sandbox skips such a `true`
   * with a warning instead of refusing to launch.
   */
  requestFromDefaults: boolean;
  additionalArgs?: string;
}

export interface SandboxCapabilityDescriptor {
  terminal: CapabilityDeclaration;
}

/**
 * Turns a step's `sandbox` request into harness arguments. Every harness has
 * one: those that can't sandbox still turn a sandbox the user enabled off for
 * `false`, where the harness has a way to.
 */
export interface ISandboxMapper {
  readonly capabilities: SandboxCapabilityDescriptor;
  prepare(
    request: SandboxRequest | undefined,
    context: SandboxContext
  ): Promise<SandboxApplication>;
}
