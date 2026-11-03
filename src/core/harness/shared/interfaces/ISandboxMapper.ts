import type {
  CompatibilityDiagnostic,
  CapabilityDeclaration,
} from "../../../../types/CompatibilityTypes";
import type { EffectiveSandboxKind } from "../../../../types/DashboardConstants";
import type { ToolPermissionConfig } from "./IToolPermissionMapper";
import type { CodexSandboxMode } from "../../../../types/DashboardConstants";

export interface EffectiveSandbox {
  kind: EffectiveSandboxKind;
  detail?: string;
}

export interface SandboxApplication {
  cliArgs: string[];
  /** Merge into the harness's single settings payload. */
  settings?: Record<string, unknown>;
  diagnostics: CompatibilityDiagnostic[];
  effective: EffectiveSandbox;
}

export interface SandboxContext {
  toolPermissions: ToolPermissionConfig | null;
  isInteractive: boolean;
  writableRoots: readonly string[];
  codexSandboxMode?: CodexSandboxMode;
  cliVersion?: string;
  additionalArgs?: string;
}

export interface SandboxCapabilityDescriptor {
  terminal: CapabilityDeclaration;
}

export interface ISandboxMapper {
  readonly capabilities: SandboxCapabilityDescriptor;
  prepare(
    request: boolean | undefined,
    context: SandboxContext
  ): Promise<SandboxApplication>;
}
