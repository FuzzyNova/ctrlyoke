import {
  CLI_VALIDATE_STRICT_POLICIES,
  CLI_VALIDATE_TARGET_KINDS,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  HARNESS_IDS,
  type CliValidateStrictPolicy,
  type HarnessId,
} from "../types/DashboardConstants";
import {
  analyzeCompatibility,
  enumerateCompatibilityTargets,
  retargetCompatibilityTargets,
  type CompatibilityTargetResolver,
} from "../types/CompatibilityAnalyzer";
import type {
  CompatibilityDiagnostic,
  HarnessCapabilityRegistrySnapshot,
} from "../types/CompatibilityTypes";
import { COMPATIBILITY_DIAGNOSTIC_CODES } from "../types/CompatibilityTypes";
import type { PromptFile } from "../types/CtrlYokeTypes";
import { PropertyResolver } from "../utils/PropertyResolver";

export type CliValidationTarget =
  | {
      kind: typeof CLI_VALIDATE_TARGET_KINDS.HARNESS;
      harness: HarnessId;
    }
  | {
      kind: typeof CLI_VALIDATE_TARGET_KINDS.ALL_INSTALLED_HARNESSES;
    };

export interface CliCompatibilityAnalysis {
  diagnostics: CompatibilityDiagnostic[];
  consumerCount: number;
}

const LOSSY_DIAGNOSTIC_CODES = new Set<string>([
  COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNSUPPORTED,
  COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_PARTIAL,
  COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_NOT_ENFORCED,
  COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_PARTIAL,
  COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_NOT_ENFORCED,
  COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_PARTIAL,
  COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_TRANSLATION_LOSSY,
]);

const UNVERIFIED_DIAGNOSTIC_CODES = new Set<string>([
  COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNVERIFIED,
  COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_UNVERIFIED,
  COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_UNVERIFIED,
]);

export function parseCliValidateStrictPolicy(
  value: string
): CliValidateStrictPolicy {
  if (
    (Object.values(CLI_VALIDATE_STRICT_POLICIES) as string[]).includes(value)
  ) {
    return value as CliValidateStrictPolicy;
  }
  throw new Error(
    `Invalid strict policy: ${value}. Expected lossy, unverified, or all.`
  );
}

export function assertCliValidateHarnessId(
  value: string
): asserts value is HarnessId {
  if (!(Object.values(HARNESS_IDS) as string[]).includes(value)) {
    throw new Error(`Invalid harness: ${value}`);
  }
}

export function selectCliValidationHarnesses(
  target: CliValidationTarget,
  capabilities: HarnessCapabilityRegistrySnapshot
): HarnessId[] {
  if (target.kind === CLI_VALIDATE_TARGET_KINDS.HARNESS) {
    return [target.harness];
  }

  return (Object.values(HARNESS_IDS) as HarnessId[]).filter(
    (harnessId) => capabilities.harnesses[harnessId]?.available === true
  );
}

export function analyzeCliCompatibility(
  workflow: PromptFile,
  capabilities: HarnessCapabilityRegistrySnapshot,
  harnesses: readonly HarnessId[],
  resolveTarget: CompatibilityTargetResolver = (prompt, file) =>
    PropertyResolver.resolveTarget(prompt, file)
): CliCompatibilityAnalysis {
  const consumers = enumerateCompatibilityTargets(workflow, resolveTarget);
  const executionTargets = harnesses.flatMap((harnessId) =>
    retargetCompatibilityTargets(consumers, harnessId)
  );
  return {
    diagnostics: analyzeCompatibility({
      workflow,
      executionTargets,
      capabilities,
    }),
    consumerCount: consumers.length,
  };
}

export function isCliValidationFailure(
  diagnostic: CompatibilityDiagnostic,
  strictPolicy?: CliValidateStrictPolicy
): boolean {
  if (diagnostic.severity === COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR) {
    return true;
  }
  if (!strictPolicy) {
    return false;
  }

  const isLossy = LOSSY_DIAGNOSTIC_CODES.has(diagnostic.code);
  const isUnverified = UNVERIFIED_DIAGNOSTIC_CODES.has(diagnostic.code);
  return (
    (strictPolicy === CLI_VALIDATE_STRICT_POLICIES.LOSSY && isLossy) ||
    (strictPolicy === CLI_VALIDATE_STRICT_POLICIES.UNVERIFIED &&
      isUnverified) ||
    (strictPolicy === CLI_VALIDATE_STRICT_POLICIES.ALL &&
      (isLossy || isUnverified))
  );
}

export function hasCliValidationFailures(
  diagnostics: readonly CompatibilityDiagnostic[],
  strictPolicy?: CliValidateStrictPolicy
): boolean {
  return diagnostics.some((diagnostic) =>
    isCliValidationFailure(diagnostic, strictPolicy)
  );
}
