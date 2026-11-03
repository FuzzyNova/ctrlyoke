import type { SandboxCapabilityDescriptor } from "./interfaces/ISandboxMapper";
import type { SandboxCaveatCode } from "../../../types/CompatibilityTypes";
import {
  EFFECTIVE_SANDBOX_KINDS,
  type EffectiveSandboxKind,
} from "../../../types/DashboardConstants";

const SANDBOX_PLAN_REFERENCE = "dev/implemented/HARNESS_SANDBOX_PLAN.md";

/** What a step's `sandbox` request means before harness detail: on, off or the harness's own behavior. */
export function effectiveSandboxKind(
  request: boolean | undefined
): EffectiveSandboxKind {
  return request === true
    ? EFFECTIVE_SANDBOX_KINDS.ON
    : request === false
      ? EFFECTIVE_SANDBOX_KINDS.OFF
      : EFFECTIVE_SANDBOX_KINDS.HARNESS;
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
