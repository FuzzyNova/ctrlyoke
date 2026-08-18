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
import { buildPortabilityReport } from "../types/PortabilityReport";
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

export interface CliCompatibilityAnalysisOptions {
  /** Use the installed-harness projection for the all-installed target. */
  allInstalled?: boolean;
}

const LOSSY_DIAGNOSTIC_CODES = new Set<string>([
  COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNSUPPORTED,
  COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_PARTIAL,
  COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_NOT_ENFORCED,
  COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_PARTIAL,
  COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_NOT_ENFORCED,
  COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_PARTIAL,
  COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_TRANSLATION_LOSSY,
  COMPATIBILITY_DIAGNOSTIC_CODES.MCP_FILTERING_UNSUPPORTED,
  COMPATIBILITY_DIAGNOSTIC_CODES.MCP_FILTERING_PARTIAL,
  COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_UNSUPPORTED,
  COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_PARTIAL,
  COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_UNSUPPORTED,
  COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_PARTIAL,
]);

const UNVERIFIED_DIAGNOSTIC_CODES = new Set<string>([
  COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_UNVERIFIED,
  COMPATIBILITY_DIAGNOSTIC_CODES.ALLOWED_TOOLS_UNVERIFIED,
  COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_UNVERIFIED,
  COMPATIBILITY_DIAGNOSTIC_CODES.MCP_FILTERING_UNVERIFIED,
  COMPATIBILITY_DIAGNOSTIC_CODES.IMAGE_INPUT_UNVERIFIED,
  COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_UNVERIFIED,
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
    PropertyResolver.resolveTarget(prompt, file),
  options: CliCompatibilityAnalysisOptions = {}
): CliCompatibilityAnalysis {
  const consumers = enumerateCompatibilityTargets(workflow, resolveTarget);
  if (options.allInstalled) {
    const report = buildPortabilityReport({
      workflow,
      capabilities,
      resolveTarget,
    });
    return {
      diagnostics: report.rows.flatMap((row) =>
        row.diagnostics.map(
          ({ identity: _identity, ...diagnostic }) => diagnostic
        )
      ),
      consumerCount: consumers.length,
    };
  }

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
