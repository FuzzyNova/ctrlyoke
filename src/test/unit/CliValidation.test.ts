import * as assert from "assert";
import { suite, test } from "mocha";

import {
  analyzeCliCompatibility,
  hasCliValidationFailures,
  parseCliValidateStrictPolicy,
  selectCliValidationHarnesses,
} from "../../cli/CliValidation";
import {
  CAPABILITY_DOMAINS,
  CLI_VALIDATE_STRICT_POLICIES,
  CLI_VALIDATE_TARGET_KINDS,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  type HarnessId,
} from "../../types/DashboardConstants";
import type {
  CompatibilityDiagnostic,
  EffectiveCapabilityState,
  HarnessCapabilityRegistrySnapshot,
  InstalledHarnessCapabilities,
} from "../../types/CompatibilityTypes";
import type { PromptFile, PromptStep } from "../../types/CtrlYokeTypes";
import type { ResolvedExecutionTarget } from "../../types/ExecutionPropertyResolver";

function installed(
  harnessId: HarnessId,
  available: boolean,
  fidelity: "exact" | "unsupported",
  verification: "verified" | "unknown" = "verified"
): InstalledHarnessCapabilities {
  const state = {
    fidelity,
    mechanism: fidelity === "unsupported" ? "none" : "native",
    verification,
  } as const;
  const declaration = {
    fidelity,
    mechanism: state.mechanism,
    verification: {
      kind: "manual" as const,
      reference: "test",
      basis: "cli-version" as const,
      verifiedVersions: ["1.0.0"],
    },
  };
  return {
    available,
    version: available ? "1.0.0" : undefined,
    descriptor: {
      harnessId,
      permissions: {
        mode: declaration,
        allowedTools: declaration,
        deniedTools: declaration,
      },
    },
    effective: {
      permissions: {
        mode: state,
        allowedTools: state,
        deniedTools: state,
      },
    },
  };
}

function snapshot(
  overrides: Partial<Record<HarnessId, InstalledHarnessCapabilities>> = {}
): HarnessCapabilityRegistrySnapshot {
  const harnesses = {} as Record<HarnessId, InstalledHarnessCapabilities>;
  for (const harnessId of Object.values(HARNESS_IDS) as HarnessId[]) {
    harnesses[harnessId] =
      overrides[harnessId] ?? installed(harnessId, true, "exact");
  }
  return {
    schemaVersion: 1,
    enabledDomains: [CAPABILITY_DOMAINS.PERMISSIONS],
    harnesses,
  };
}

const resolver = (
  prompt: PromptStep,
  workflow: PromptFile
): ResolvedExecutionTarget => ({
  properties: {
    harness: prompt.harness ?? workflow.harness ?? HARNESS_IDS.CLAUDE_CLI,
    model: "model",
    executionMode: "headless",
    resumeSession: false,
    mcpServers: [],
    hooks: null,
    toolPermissions: workflow.toolPermissions
      ? {
          mode: workflow.toolPermissions.mode ?? "allowAll",
          allowedTools: workflow.toolPermissions.allowedTools ?? [],
          deniedTools: workflow.toolPermissions.deniedTools ?? [],
        }
      : null,
  },
  sources: { toolPermissions: "workflow" },
});

suite("CliValidation", () => {
  test("rejects invalid strict policies and accepts the documented values", () => {
    assert.strictEqual(
      parseCliValidateStrictPolicy(CLI_VALIDATE_STRICT_POLICIES.LOSSY),
      CLI_VALIDATE_STRICT_POLICIES.LOSSY
    );
    assert.throws(
      () => parseCliValidateStrictPolicy("strictly-everything"),
      /Invalid strict policy/
    );
  });

  test("filters unavailable harnesses from the all-installed target", () => {
    const capabilities = snapshot({
      [HARNESS_IDS.CODEX_CLI]: installed(HARNESS_IDS.CODEX_CLI, false, "exact"),
    });
    assert.deepStrictEqual(
      selectCliValidationHarnesses(
        { kind: CLI_VALIDATE_TARGET_KINDS.ALL_INSTALLED_HARNESSES },
        capabilities
      ),
      [
        HARNESS_IDS.COPILOT_CLI,
        HARNESS_IDS.CLAUDE_CLI,
        HARNESS_IDS.OPENCODE_CLI,
        HARNESS_IDS.QWEN_CLI,
        HARNESS_IDS.ANTIGRAVITY_CLI,
      ]
    );
  });

  test("retargets inherited properties across AI consumers, excluding scripts", () => {
    const workflow: PromptFile = {
      harness: HARNESS_IDS.CLAUDE_CLI,
      toolPermissions: {
        mode: "custom",
        allowedTools: ["shell(git:*)"],
        deniedTools: ["shell(rm:*)"],
      },
      steps: [
        { name: "prompt", prompt: "Do work" },
        { name: "script", type: "script", script: "echo no AI" },
      ],
      finalStep: { name: "finish", prompt: "Finish" },
    };
    const result = analyzeCliCompatibility(
      workflow,
      snapshot({
        [HARNESS_IDS.CODEX_CLI]: installed(
          HARNESS_IDS.CODEX_CLI,
          true,
          "unsupported"
        ),
      }),
      [HARNESS_IDS.CODEX_CLI],
      resolver
    );

    assert.strictEqual(result.consumerCount, 2);
    assert.ok(
      result.diagnostics.every(
        (diagnostic) => diagnostic.harnessId === HARNESS_IDS.CODEX_CLI
      )
    );
    assert.deepStrictEqual(
      [...new Set(result.diagnostics.map((diagnostic) => diagnostic.consumer))],
      [
        { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        { kind: FINAL_STEP_PHASES.FINAL_STEP },
      ]
    );
    assert.ok(
      result.diagnostics.every(
        (diagnostic) => diagnostic.sourceTier === "workflow"
      )
    );
    assert.ok(result.diagnostics.every((diagnostic) => diagnostic.remediation));
  });

  test("strict policies fail on errors and selected warning classes", () => {
    const state: EffectiveCapabilityState = {
      fidelity: "unsupported",
      mechanism: "none",
      verification: "unknown",
    };
    const diagnostic = (
      code: CompatibilityDiagnostic["code"],
      severity: CompatibilityDiagnostic["severity"]
    ): CompatibilityDiagnostic => ({
      code,
      severity,
      harnessId: HARNESS_IDS.CODEX_CLI,
      capability: "deniedTools",
      state,
      message: "test",
    });
    const warning = diagnostic(
      "compatibility.permissions.deniedTools.notEnforced",
      COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING
    );
    const unverified = diagnostic(
      "compatibility.permissions.deniedTools.unverified",
      COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING
    );
    const error = diagnostic(
      "other",
      COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR
    );

    assert.strictEqual(hasCliValidationFailures([warning], undefined), false);
    assert.strictEqual(
      hasCliValidationFailures([warning], CLI_VALIDATE_STRICT_POLICIES.LOSSY),
      true
    );
    assert.strictEqual(
      hasCliValidationFailures(
        [unverified],
        CLI_VALIDATE_STRICT_POLICIES.UNVERIFIED
      ),
      true
    );
    assert.strictEqual(hasCliValidationFailures([error]), true);
  });
});
