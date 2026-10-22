/**
 * Which live harness test backs each published capability claim.
 *
 * Shared by `capabilities.harness.test.ts` (`CAPABILITY_SUITE_REFERENCE`),
 * which proves the claims against real CLIs, and the
 * `HarnessCapabilityRegistry` unit test, which requires every claim's
 * `verification` to name a harness test unless it is listed below.
 */

import type {
  CapabilityDeclaration,
  HarnessCapabilityFacts,
} from "../../types/CompatibilityTypes";
import {
  CAPABILITY_FIDELITIES,
  type HarnessId,
} from "../../types/DashboardConstants";

/** `domain.key` path of a capability declaration, e.g. `hooks.stop`. */
export type CapabilityPath = string;

/** Every declaration in `capabilities` that is not `unsupported`, by path. */
export function collectClaims(
  capabilities: HarnessCapabilityFacts | undefined
): Map<CapabilityPath, CapabilityDeclaration> {
  const claims = new Map<CapabilityPath, CapabilityDeclaration>();
  const walk = (value: unknown, prefix: string): void => {
    if (!value || typeof value !== "object") return;
    if ("fidelity" in value && "mechanism" in value) {
      const declaration = value as CapabilityDeclaration;
      if (declaration.fidelity !== CAPABILITY_FIDELITIES.UNSUPPORTED) {
        claims.set(prefix, declaration);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      walk(child, prefix ? `${prefix}.${key}` : key);
    }
  };
  walk(capabilities, "");
  return claims;
}

/**
 * Claims the suite cannot trigger with a short, cheap case. Their
 * declarations stay `kind: "manual"`, and the suite reports instead of
 * asserting them.
 */
export const UNPROVEN_CLAIMS: Partial<
  Record<HarnessId, Partial<Record<CapabilityPath, string>>>
> = {
  "copilot-cli": {
    "hooks.error":
      "errorOccurred fires only for a model-call or tool-execution failure inside a session; an unknown model is rejected before the session starts, and a failing tool call is an ordinary tool result.",
  },
};

/**
 * Claims the suite proves wrong today. The suite still asserts them, so it
 * stays red until the bug is fixed; their declarations stay `kind: "manual"`
 * meanwhile. Each value is the bug document.
 */
export const KNOWN_BROKEN_CLAIMS: Partial<
  Record<HarnessId, Partial<Record<CapabilityPath, string>>>
> = {
  "opencode-cli": {
    "hooks.permissionRequest":
      "dev/bugs/backlog/opencode-permission-request-hook-never-fires.md",
    "mcp.perServerToolFiltering":
      "dev/bugs/backlog/opencode-mcp-tool-deny-rules-never-match.md",
  },
};
