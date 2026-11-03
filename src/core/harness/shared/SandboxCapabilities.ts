import type { SandboxCapabilityDescriptor } from "./interfaces/ISandboxMapper";
import { SANDBOX_CAVEAT_CODE } from "../../../types/CompatibilityTypes";

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
