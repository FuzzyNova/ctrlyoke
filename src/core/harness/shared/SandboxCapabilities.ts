import type {
  ISandboxMapper,
  SandboxApplication,
  SandboxCapabilityDescriptor,
  SandboxContext,
} from "./interfaces/ISandboxMapper";
import {
  sandboxUnsupportedDiagnostic,
  type SandboxCaveatCode,
} from "../../../types/CompatibilityTypes";
import {
  EFFECTIVE_SANDBOX_KINDS,
  type HarnessId,
  type SandboxRequest,
} from "../../../types/DashboardConstants";

const SANDBOX_PLAN_REFERENCE = "dev/implemented/HARNESS_SANDBOX_PLAN.md";

/** `sandbox: null` (or unset): no sandbox flags, the harness's own settings apply. */
export function harnessSettingSandbox(detail?: string): SandboxApplication {
  return {
    cliArgs: [],
    diagnostics: [],
    effective: {
      kind: EFFECTIVE_SANDBOX_KINDS.HARNESS,
      ...(detail ? { detail } : {}),
    },
  };
}

export function nativeSandboxCapabilities(
  reference: string,
  verifiedVersions: readonly string[],
  fidelity: "exact" | "partial",
  caveatCode: SandboxCaveatCode
): SandboxCapabilityDescriptor {
  return {
    terminal: {
      fidelity,
      mechanism: "native",
      caveatCode,
      verification: {
        kind: "manual",
        reference: `${SANDBOX_PLAN_REFERENCE}#${reference}`,
        basis: "cli-version",
        verifiedVersions: [...verifiedVersions],
      },
    },
  };
}

/** A harness ctrlyoke cannot contain; its caveat says why. */
export function unsupportedSandboxCapabilities(
  caveatCode: SandboxCaveatCode,
  reference = `${SANDBOX_PLAN_REFERENCE}#the-other-harnesses`
): SandboxCapabilityDescriptor {
  return {
    terminal: {
      fidelity: "unsupported",
      mechanism: "none",
      caveatCode,
      verification: {
        kind: "manual",
        reference,
        basis: "cli-version",
        verifiedVersions: [],
      },
    },
  };
}

/** How a harness that can't sandbox turns a sandbox the user enabled off. */
export interface SandboxOffSwitch {
  cliArgs: string[];
  env?: Record<string, string>;
  /** Dry Run detail, e.g. "Copilot --no-sandbox". */
  detail: string;
}

/**
 * Sandbox mapper for a harness ctrlyoke cannot contain (decision 4 in
 * `HARNESS_SANDBOX_PLAN.md`):
 * - `true` written in the workflow or step refuses to launch;
 * - `true` inherited from `defaults.sandbox` is skipped with a warning, so the
 *   sandbox can be on globally while several harnesses are in use;
 * - `false` emits the harness's off switch, when it has one;
 * - `null` passes nothing.
 */
export class UnsupportedSandboxMapper implements ISandboxMapper {
  constructor(
    private readonly harnessId: HarnessId,
    readonly capabilities: SandboxCapabilityDescriptor,
    private readonly offSwitch?: SandboxOffSwitch
  ) {}

  async prepare(
    request: SandboxRequest | undefined,
    context: SandboxContext
  ): Promise<SandboxApplication> {
    if (request === true) {
      const diagnostic = sandboxUnsupportedDiagnostic({
        harnessId: this.harnessId,
        fromDefaults: context.requestFromDefaults,
        caveatCode: this.capabilities.terminal.caveatCode,
      });
      return {
        cliArgs: [],
        diagnostics: [diagnostic],
        effective: { kind: EFFECTIVE_SANDBOX_KINDS.HARNESS },
      };
    }
    if (request === false) {
      return this.offSwitch
        ? {
            cliArgs: [...this.offSwitch.cliArgs],
            ...(this.offSwitch.env ? { env: { ...this.offSwitch.env } } : {}),
            diagnostics: [],
            effective: {
              kind: EFFECTIVE_SANDBOX_KINDS.OFF,
              detail: this.offSwitch.detail,
            },
          }
        : {
            cliArgs: [],
            diagnostics: [],
            effective: {
              kind: EFFECTIVE_SANDBOX_KINDS.OFF,
              detail: "no sandbox to turn off",
            },
          };
    }
    return harnessSettingSandbox();
  }
}
