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
  PERMISSION_CAPABILITY_KEYS,
} from "../../types/DashboardConstants";
import { getCompatibilityCaveatMessage } from "../../types/CompatibilityTypes";
import { CODEX_PERMISSION_CAPABILITIES } from "../../core/harness/codex/CodexToolPermissionMapper";
import { ANTIGRAVITY_PERMISSION_CAPABILITIES } from "../../core/harness/antigravity/AntigravityToolPermissionMapper";
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

suite("Compatibility caveat codes", () => {
  test("mode-only harnesses declare a caveat that resolves to shared prose", () => {
    // The reason a harness cannot enforce a list is a harness-owned fact. If
    // these declarations lose their caveatCode, a consumer is forced back into
    // a hardcoded harness switch to explain the limitation.
    const modeOnly = [
      CODEX_PERMISSION_CAPABILITIES,
      ANTIGRAVITY_PERMISSION_CAPABILITIES,
    ];

    for (const descriptor of modeOnly) {
      for (const key of [
        PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS,
        PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS,
      ] as const) {
        const declaration = descriptor[key];
        assert.strictEqual(
          declaration.fidelity,
          CAPABILITY_FIDELITIES.UNSUPPORTED
        );
        assert.ok(
          declaration.caveatCode,
          `${key} must declare a caveatCode explaining why it is unsupported`
        );
        assert.ok(
          getCompatibilityCaveatMessage(declaration.caveatCode),
          `${key} caveatCode must resolve to shared prose`
        );
      }
    }
  });

  test("an unknown caveat code yields no invented reason", () => {
    assert.strictEqual(getCompatibilityCaveatMessage(undefined), undefined);
    assert.strictEqual(getCompatibilityCaveatMessage("not-a-code"), undefined);
  });
});
