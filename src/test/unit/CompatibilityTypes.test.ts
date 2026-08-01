import * as assert from "assert";
import { suite, test } from "mocha";
import {
  CAPABILITY_DOMAINS,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_BASES,
  CAPABILITY_VERIFICATION_KINDS,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  COMPATIBILITY_SOURCE_TIERS,
} from "../../types/DashboardConstants";
import type {
  CapabilityDomain,
  CapabilityFidelity,
  CapabilityMechanism,
  CapabilityVerificationBasis,
  CapabilityVerificationKind,
  CapabilityVerificationStatus,
  CompatibilityDiagnosticSeverity,
  CompatibilitySourceTier,
} from "../../types/CompatibilityTypes";

function assertUniqueValues(values: readonly string[]): void {
  assert.strictEqual(new Set(values).size, values.length);
}

suite("Compatibility shared vocabulary", () => {
  test("keeps each constant object exhaustive and mutually consistent", () => {
    const domains: CapabilityDomain[] = Object.values(CAPABILITY_DOMAINS);
    const fidelities: CapabilityFidelity[] = Object.values(
      CAPABILITY_FIDELITIES
    );
    const mechanisms: CapabilityMechanism[] = Object.values(
      CAPABILITY_MECHANISMS
    );
    const verificationStatuses: CapabilityVerificationStatus[] = Object.values(
      CAPABILITY_VERIFICATION_STATUSES
    );
    const verificationKinds: CapabilityVerificationKind[] = Object.values(
      CAPABILITY_VERIFICATION_KINDS
    );
    const verificationBases: CapabilityVerificationBasis[] = Object.values(
      CAPABILITY_VERIFICATION_BASES
    );
    const severities: CompatibilityDiagnosticSeverity[] = Object.values(
      COMPATIBILITY_DIAGNOSTIC_SEVERITIES
    );
    const sourceTiers: CompatibilitySourceTier[] = Object.values(
      COMPATIBILITY_SOURCE_TIERS
    );

    const constantValueGroups: readonly (readonly string[])[] = [
      domains,
      fidelities,
      mechanisms,
      verificationStatuses,
      verificationKinds,
      verificationBases,
      severities,
      sourceTiers,
    ];

    for (const values of constantValueGroups) {
      assertUniqueValues(values);
      for (const value of values) {
        assert.ok(values.includes(value));
      }
    }
  });
});
