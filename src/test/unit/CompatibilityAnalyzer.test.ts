import * as assert from "assert";
import { suite, test } from "mocha";
import {
  enumerateCompatibilityTargets,
  analyzeCompatibility,
} from "../../types/CompatibilityAnalyzer";
import { resolveExecutionProperties } from "../../types/ExecutionPropertyResolver";
import {
  CAPABILITY_DOMAINS,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  type HarnessId,
} from "../../types/DashboardConstants";
import type {
  HarnessCapabilityRegistrySnapshot,
  InstalledHarnessCapabilities,
} from "../../types/CompatibilityTypes";
import type { PromptFile } from "../../types/CtrlYokeTypes";

const defaults = {
  harness: HARNESS_IDS.CODEX_CLI,
  modelsByHarness: {},
  additionalArgsByHarness: {},
  executionMode: "headless" as const,
  resumeSession: false,
};

function installed(
  harnessId: HarnessId,
  available: boolean,
  fidelity: "exact" | "partial" | "unsupported",
  verification: "verified" | "unknown"
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
    version: "1.0.0",
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
      overrides[harnessId] ??
      installed(harnessId, true, "exact", "verified");
  }
  return {
    schemaVersion: 1,
    enabledDomains: [CAPABILITY_DOMAINS.PERMISSIONS],
    harnesses,
  };
}

function analyze(workflow: PromptFile, capabilities = snapshot()) {
  const targets = enumerateCompatibilityTargets(workflow, (prompt, file) =>
    resolveExecutionProperties(prompt, file, {
      defaults,
      hostCanProvidePty: false,
    })
  );
  return analyzeCompatibility({
    workflow,
    executionTargets: targets,
    capabilities,
  });
}

function mixedWorkflow(overrides: Partial<PromptFile> = {}): PromptFile {
  return {
    harness: HARNESS_IDS.CODEX_CLI,
    toolPermissions: {
      mode: "custom",
      allowedTools: ["shell(git:*)"],
      deniedTools: ["shell(rm:*)"],
    },
    steps: [
      { prompt: "Claude target", harness: HARNESS_IDS.CLAUDE_CLI },
      { prompt: "Codex target" },
      { type: "script", script: "echo script" },
    ],
    ...overrides,
  };
}

suite("CompatibilityAnalyzer", () => {
  test("resolves mixed harness consumers independently", () => {
    const diagnostics = analyze(
      mixedWorkflow(),
      snapshot({
        [HARNESS_IDS.CLAUDE_CLI]: installed(
          HARNESS_IDS.CLAUDE_CLI,
          true,
          "exact",
          "verified"
        ),
        [HARNESS_IDS.CODEX_CLI]: {
          ...installed(
            HARNESS_IDS.CODEX_CLI,
            true,
            "exact",
            "verified"
          ),
          effective: {
            permissions: {
              mode: {
                fidelity: "exact",
                mechanism: "native",
                verification: "verified",
              },
              allowedTools: {
                fidelity: "unsupported",
                mechanism: "none",
                verification: "verified",
              },
              deniedTools: {
                fidelity: "unsupported",
                mechanism: "none",
                verification: "verified",
              },
            },
          },
        },
      })
    );

    assert.deepStrictEqual(
      diagnostics.map(({ code, consumer, harnessId, sourceTier }) => ({
        code,
        consumer,
        harnessId,
        sourceTier,
      })),
      [
        {
          code: "compatibility.permissions.allowedTools.notEnforced",
          consumer: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
          harnessId: HARNESS_IDS.CODEX_CLI,
          sourceTier: "workflow",
        },
        {
          code: "compatibility.permissions.deniedTools.notEnforced",
          consumer: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
          harnessId: HARNESS_IDS.CODEX_CLI,
          sourceTier: "workflow",
        },
      ]
    );
    assert.ok(diagnostics.every((diagnostic) => diagnostic.severity === "warning"));
    assert.ok(diagnostics.every((diagnostic) => diagnostic.message.includes("NOT ENFORCED")));
  });

  test("does not warn for an unused workflow harness default", () => {
    const workflow = mixedWorkflow({
      steps: [
        { prompt: "Claude target", harness: HARNESS_IDS.CLAUDE_CLI },
      ],
    });
    const diagnostics = analyze(workflow, snapshot({
      [HARNESS_IDS.CODEX_CLI]: installed(
        HARNESS_IDS.CODEX_CLI,
        true,
        "unsupported",
        "verified"
      ),
    }));
    assert.deepStrictEqual(diagnostics, []);
  });

  test("emits a blocking unavailable error only for an actual consumer", () => {
    const unavailableCodex = installed(
      HARNESS_IDS.CODEX_CLI,
      false,
      "exact",
      "verified"
    );
    const claudeOnly = analyze(
      mixedWorkflow({
        steps: [
          { prompt: "Claude target", harness: HARNESS_IDS.CLAUDE_CLI },
        ],
      }),
      snapshot({ [HARNESS_IDS.CODEX_CLI]: unavailableCodex })
    );
    assert.deepStrictEqual(claudeOnly, []);

    const mixed = analyze(
      mixedWorkflow(),
      snapshot({ [HARNESS_IDS.CODEX_CLI]: unavailableCodex })
    );
    assert.strictEqual(
      mixed.filter(
        (diagnostic) => diagnostic.code === "compatibility.harness.unavailable"
      ).length,
      1
    );
    assert.strictEqual(mixed[0].severity, "error");
  });

  test("keeps unmodeled domains silent and evaluates only non-empty lists", () => {
    const workflow = mixedWorkflow({
      toolPermissions: {
        mode: "custom",
        allowedTools: [],
        deniedTools: ["shell(rm:*)"],
      },
      steps: [{ prompt: "Codex target" }],
    });
    const diagnostics = analyze(
      workflow,
      snapshot({
        [HARNESS_IDS.CODEX_CLI]: {
          ...installed(HARNESS_IDS.CODEX_CLI, true, "exact", "verified"),
          effective: {
            permissions: {
              mode: {
                fidelity: "exact",
                mechanism: "native",
                verification: "verified",
              },
              allowedTools: {
                fidelity: "unsupported",
                mechanism: "none",
                verification: "verified",
              },
              deniedTools: {
                fidelity: "unsupported",
                mechanism: "none",
                verification: "verified",
              },
            },
          },
        },
      })
    );
    assert.deepStrictEqual(
      diagnostics.map((diagnostic) => diagnostic.capability),
      ["deniedTools"]
    );
    assert.ok(!diagnostics.some((diagnostic) => diagnostic.capability === "hooks"));
  });

  test("reports partial and unverified facts as warnings", () => {
    const workflow = mixedWorkflow({
      steps: [{ prompt: "Target", harness: HARNESS_IDS.CLAUDE_CLI }],
    });
    const diagnostics = analyze(
      workflow,
      snapshot({
        [HARNESS_IDS.CLAUDE_CLI]: installed(
          HARNESS_IDS.CLAUDE_CLI,
          true,
          "partial",
          "unknown"
        ),
      })
    );
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code.endsWith("partial")));
    assert.ok(diagnostics.some((diagnostic) => diagnostic.code.endsWith("unverified")));
    assert.ok(diagnostics.every((diagnostic) => diagnostic.severity === "warning"));
  });
});
