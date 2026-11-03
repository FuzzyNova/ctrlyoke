import type { SandboxCapabilityDescriptor } from "./interfaces/ISandboxMapper";
import { SANDBOX_CAVEAT_CODE } from "../../../types/CompatibilityTypes";
import {
  EFFECTIVE_SANDBOX_KINDS,
  type EffectiveSandboxKind,
} from "../../../types/DashboardConstants";

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

export function partialSandboxCapabilities(
  reference: string,
  verifiedVersions: readonly string[] = []
): SandboxCapabilityDescriptor {
  return {
    terminal: {
      fidelity: "partial",
      mechanism: "native",
      caveatCode: SANDBOX_CAVEAT_CODE.NETWORK_FOLLOWS_HARNESS_POLICY,
      verification: {
        kind: "manual",
        reference: `dev/backlog/HARNESS_SANDBOX_PLAN.md#${reference}`,
        basis: "cli-version",
        verifiedVersions: [...verifiedVersions],
      },
    },
  };
}
