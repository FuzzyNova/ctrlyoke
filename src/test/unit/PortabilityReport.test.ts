import * as assert from "assert";
import { suite, test } from "mocha";
import {
  CAPABILITY_DOMAINS,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_SOURCE_TIERS,
  FINAL_STEP_PHASES,
  HARNESS_IDS,
  HOOK_EVENT_ORDER,
  type HarnessId,
  type HookEvent,
} from "../../types/DashboardConstants";
import type {
  CapabilityDeclaration,
  EffectiveCapabilityState,
  HarnessCapabilityRegistrySnapshot,
  InstalledHarnessCapabilities,
} from "../../types/CompatibilityTypes";
import type { PromptFile } from "../../types/CtrlYokeTypes";
import { resolveExecutionProperties } from "../../types/ExecutionPropertyResolver";
import type { ExecutionPropertyDefaults } from "../../types/ExecutionPropertyResolver";
import type { CompatibilityExecutionTarget } from "../../types/CompatibilityAnalyzer";
import {
  buildPortabilityReport,
  PORTABILITY_ROW_STATUSES,
} from "../../types/PortabilityReport";

const defaults = {
  harness: HARNESS_IDS.CLAUDE_CLI,
  modelsByHarness: {},
  additionalArgsByHarness: {},
  executionMode: "headless" as const,
  resumeSession: false,
};

function createState(
  fidelity: EffectiveCapabilityState["fidelity"] = CAPABILITY_FIDELITIES.EXACT,
  mechanism: EffectiveCapabilityState["mechanism"] = CAPABILITY_MECHANISMS.NATIVE,
  verification: EffectiveCapabilityState["verification"] = CAPABILITY_VERIFICATION_STATUSES.VERIFIED
): EffectiveCapabilityState {
  return { fidelity, mechanism, verification };
}

function createDeclaration(
  state: EffectiveCapabilityState
): CapabilityDeclaration {
  return {
    fidelity: state.fidelity,
    mechanism: state.mechanism,
    ...(state.fidelity === CAPABILITY_FIDELITIES.UNSUPPORTED
      ? {}
      : {
          verification: {
            kind: "manual" as const,
            reference: "test",
            basis: "cli-version" as const,
            verifiedVersions: ["1.0.0"],
          },
        }),
  };
}

function installed(
  harnessId: HarnessId,
  options: {
    available?: boolean;
    permissions?: EffectiveCapabilityState;
    hooks?: EffectiveCapabilityState;
    mcp?: EffectiveCapabilityState;
    images?: EffectiveCapabilityState;
  } = {}
): InstalledHarnessCapabilities {
  const permissionState = options.permissions ?? createState();
  const hookState = options.hooks ?? createState();
  const mcpState = options.mcp ?? createState();
  const imageState = options.images ?? createState();
  const hookStates = Object.fromEntries(
    HOOK_EVENT_ORDER.map((event) => [event, hookState])
  ) as Record<HookEvent, EffectiveCapabilityState>;
  const hookDeclarations = Object.fromEntries(
    HOOK_EVENT_ORDER.map((event) => [event, createDeclaration(hookState)])
  ) as Record<HookEvent, CapabilityDeclaration>;

  return {
    available: options.available ?? true,
    version: "1.0.0",
    descriptor: {
      harnessId,
      permissions: {
        mode: createDeclaration(permissionState),
        allowedTools: createDeclaration(permissionState),
        deniedTools: createDeclaration(permissionState),
      },
      hooks: hookDeclarations,
      mcp: {
        perServerToolFiltering: createDeclaration(mcpState),
      },
      promptInputs: { images: createDeclaration(imageState) },
    },
    effective: {
      permissions: {
        mode: permissionState,
        allowedTools: permissionState,
        deniedTools: permissionState,
      },
      hooks: hookStates,
      mcp: { perServerToolFiltering: mcpState },
      promptInputs: { images: imageState },
    },
  };
}

function snapshot(
  overrides: Partial<Record<HarnessId, InstalledHarnessCapabilities>> = {}
): HarnessCapabilityRegistrySnapshot {
  const harnesses = {} as Record<HarnessId, InstalledHarnessCapabilities>;
  for (const harnessId of Object.values(HARNESS_IDS) as HarnessId[]) {
    harnesses[harnessId] = overrides[harnessId] ?? installed(harnessId);
  }
  return {
    schemaVersion: 1,
    enabledDomains: [
      CAPABILITY_DOMAINS.PERMISSIONS,
      CAPABILITY_DOMAINS.PROMPT_INPUTS,
      CAPABILITY_DOMAINS.HOOKS,
      CAPABILITY_DOMAINS.MCP,
    ],
    harnesses,
  };
}

function buildReport(
  workflow: PromptFile,
  capabilities: HarnessCapabilityRegistrySnapshot,
  imageFileRefs?: (target: CompatibilityExecutionTarget) => readonly string[],
  propertyDefaults: ExecutionPropertyDefaults = defaults
) {
  return buildPortabilityReport({
    workflow,
    capabilities,
    resolveTarget: (prompt, file) => {
      return resolveExecutionProperties(prompt, file, {
        defaults: propertyDefaults,
        hostCanProvidePty: false,
      });
    },
    ...(imageFileRefs ? { imageFileRefs } : {}),
  });
}

suite("PortabilityReport", () => {
  test("retargets mixed consumers while preserving provenance, exclusions, nulls, and authored immutability", () => {
    const workflow: PromptFile = {
      harness: HARNESS_IDS.CLAUDE_CLI,
      toolPermissions: {
        mode: "custom",
        allowedTools: ["shell(git:*)"],
        deniedTools: ["shell(rm:*)"],
      },
      hooks: [{ event: "error", command: "node ./workflow-hook.js" }],
      steps: [
        {
          prompt: "Prompt override",
          harness: HARNESS_IDS.CODEX_CLI,
          toolPermissions: {
            mode: "custom",
            allowedTools: ["shell(npm:*)"],
            deniedTools: [],
          },
        },
        { prompt: "Inherited workflow value" },
        {
          prompt: "Explicitly disabled",
          enabled: false,
          toolPermissions: null,
        },
        { type: "script", script: "echo no AI" },
      ],
      finalStep: { prompt: "Final inherited value" },
    };
    const authored = structuredClone(workflow);
    const capabilities = snapshot({
      [HARNESS_IDS.CODEX_CLI]: installed(HARNESS_IDS.CODEX_CLI, {
        permissions: createState(CAPABILITY_FIDELITIES.UNSUPPORTED),
      }),
    });

    const report = buildReport(workflow, capabilities);
    assert.deepStrictEqual(workflow, authored);
    assert.deepStrictEqual(
      report.rows.map((row) => row.harnessId),
      Object.values(HARNESS_IDS)
    );
    const codex = report.rows.find(
      (row) => row.harnessId === HARNESS_IDS.CODEX_CLI
    );
    assert.ok(codex);
    assert.strictEqual(codex.status, PORTABILITY_ROW_STATUSES.UNSUPPORTED);
    const provenance = codex.diagnostics.map(
      ({ consumer, sourceTier, propertyPointer }) => ({
        consumer,
        sourceTier,
        propertyPointer,
      })
    );
    assert.deepStrictEqual(
      provenance.sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      ),
      [
        {
          consumer: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
          sourceTier: "prompt",
          propertyPointer: "/steps/0/toolPermissions/mode",
        },
        {
          consumer: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
          sourceTier: "prompt",
          propertyPointer: "/steps/0/toolPermissions/allowedTools",
        },
        {
          consumer: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
          sourceTier: "workflow",
          propertyPointer: "/toolPermissions/mode",
        },
        {
          consumer: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
          sourceTier: "workflow",
          propertyPointer: "/toolPermissions/allowedTools",
        },
        {
          consumer: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 1 },
          sourceTier: "workflow",
          propertyPointer: "/toolPermissions/deniedTools",
        },
        {
          consumer: { kind: FINAL_STEP_PHASES.FINAL_STEP },
          sourceTier: "workflow",
          propertyPointer: "/toolPermissions/mode",
        },
        {
          consumer: { kind: FINAL_STEP_PHASES.FINAL_STEP },
          sourceTier: "workflow",
          propertyPointer: "/toolPermissions/allowedTools",
        },
        {
          consumer: { kind: FINAL_STEP_PHASES.FINAL_STEP },
          sourceTier: "workflow",
          propertyPointer: "/toolPermissions/deniedTools",
        },
      ].sort((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right))
      )
    );
    assert.ok(
      codex.diagnostics.every(
        (diagnostic) => diagnostic.identity && diagnostic.remediation
      )
    );
  });

  test("combines permissions, hooks, MCP filtering, and images in one structured report", () => {
    const workflow: PromptFile = {
      toolPermissions: {
        mode: "custom",
        allowedTools: ["shell(git:*)"],
        deniedTools: ["shell(rm:*)"],
      },
      mcpServers: [{ id: "server", deniedTools: ["dangerous_tool"] }],
      steps: [
        {
          prompt: "Review the image @diagram.png",
          hooks: [{ event: "error", command: "echo hook" }],
        },
      ],
    };
    const report = buildReport(
      workflow,
      snapshot({
        [HARNESS_IDS.CODEX_CLI]: installed(HARNESS_IDS.CODEX_CLI, {
          permissions: createState(CAPABILITY_FIDELITIES.UNSUPPORTED),
          hooks: createState(CAPABILITY_FIDELITIES.PARTIAL),
          mcp: createState(
            CAPABILITY_FIDELITIES.EXACT,
            CAPABILITY_MECHANISMS.NATIVE,
            CAPABILITY_VERIFICATION_STATUSES.UNKNOWN
          ),
          images: createState(CAPABILITY_FIDELITIES.UNSUPPORTED),
        }),
      }),
      () => ["diagram.png"]
    );
    const row = report.rows.find(
      (candidate) => candidate.harnessId === HARNESS_IDS.CODEX_CLI
    );
    assert.ok(row);
    assert.strictEqual(row.status, PORTABILITY_ROW_STATUSES.UNSUPPORTED);
    assert.ok(row.unverified);
    assert.deepStrictEqual(
      new Set(row.diagnostics.map((diagnostic) => diagnostic.capability)),
      new Set([
        "mode",
        "allowedTools",
        "deniedTools",
        "error",
        "perServerToolFiltering",
        "images",
      ])
    );
  });

  test("retains default provenance and honors explicit null reset semantics", () => {
    const workflow: PromptFile = {
      steps: [
        { prompt: "Use the default permission value" },
        { prompt: "Reset the default", toolPermissions: null },
      ],
    };
    const report = buildReport(
      workflow,
      snapshot({
        [HARNESS_IDS.CODEX_CLI]: installed(HARNESS_IDS.CODEX_CLI, {
          permissions: createState(CAPABILITY_FIDELITIES.UNSUPPORTED),
        }),
      }),
      undefined,
      {
        ...defaults,
        toolPermissions: {
          mode: "custom",
          allowedTools: ["shell(git:*)"],
          deniedTools: [],
        },
      }
    );
    const codex = report.rows.find(
      (row) => row.harnessId === HARNESS_IDS.CODEX_CLI
    );
    assert.ok(codex);
    assert.ok(codex.diagnostics.length > 0);
    assert.ok(
      codex.diagnostics.every(
        (diagnostic) =>
          diagnostic.sourceTier === COMPATIBILITY_SOURCE_TIERS.DEFAULTS &&
          diagnostic.propertyPointer === undefined
      )
    );
    assert.ok(
      !codex.diagnostics.some(
        (diagnostic) =>
          diagnostic.consumer?.kind === FINAL_STEP_PHASES.QUEUE &&
          diagnostic.consumer.stepIndex === 1
      )
    );
  });

  test("distinguishes lossy and unverified rows from ready rows", () => {
    const workflow: PromptFile = {
      toolPermissions: {
        mode: "custom",
        allowedTools: ["shell(git:*)"],
        deniedTools: [],
      },
      steps: [{ prompt: "One consumer" }],
    };
    const report = buildReport(
      workflow,
      snapshot({
        [HARNESS_IDS.CLAUDE_CLI]: installed(HARNESS_IDS.CLAUDE_CLI, {
          permissions: createState(CAPABILITY_FIDELITIES.PARTIAL),
        }),
        [HARNESS_IDS.CODEX_CLI]: installed(HARNESS_IDS.CODEX_CLI, {
          permissions: createState(
            CAPABILITY_FIDELITIES.EXACT,
            CAPABILITY_MECHANISMS.NATIVE,
            CAPABILITY_VERIFICATION_STATUSES.UNKNOWN
          ),
        }),
      })
    );
    assert.strictEqual(
      report.rows.find((row) => row.harnessId === HARNESS_IDS.CLAUDE_CLI)
        ?.status,
      PORTABILITY_ROW_STATUSES.LOSSY
    );
    const unverified = report.rows.find(
      (row) => row.harnessId === HARNESS_IDS.CODEX_CLI
    );
    assert.ok(unverified);
    assert.strictEqual(unverified.status, PORTABILITY_ROW_STATUSES.READY);
    assert.strictEqual(unverified.unverified, true);
    assert.strictEqual(
      report.rows.find((row) => row.harnessId === HARNESS_IDS.COPILOT_CLI)
        ?.status,
      PORTABILITY_ROW_STATUSES.READY
    );
  });

  test("reports workspace-config and mixed mechanisms as disclosed side effects", () => {
    const workflow: PromptFile = {
      hooks: [{ event: "sessionStart", command: "echo hook" }],
      steps: [{ prompt: "Use the configured hook" }],
    };
    const report = buildReport(
      workflow,
      snapshot({
        [HARNESS_IDS.CLAUDE_CLI]: installed(HARNESS_IDS.CLAUDE_CLI, {
          hooks: createState(
            CAPABILITY_FIDELITIES.EXACT,
            CAPABILITY_MECHANISMS.WORKSPACE_CONFIG
          ),
        }),
        [HARNESS_IDS.CODEX_CLI]: installed(HARNESS_IDS.CODEX_CLI, {
          hooks: createState(
            CAPABILITY_FIDELITIES.PARTIAL,
            CAPABILITY_MECHANISMS.MIXED
          ),
        }),
      })
    );
    const claude = report.rows.find(
      (row) => row.harnessId === HARNESS_IDS.CLAUDE_CLI
    );
    const codex = report.rows.find(
      (row) => row.harnessId === HARNESS_IDS.CODEX_CLI
    );
    assert.ok(claude && codex);
    assert.strictEqual(
      claude.status,
      PORTABILITY_ROW_STATUSES.WORKSPACE_SIDE_EFFECTS
    );
    assert.strictEqual(claude.diagnostics.length, 0);
    assert.strictEqual(claude.workspaceSideEffects.length, 1);
    assert.strictEqual(codex.status, PORTABILITY_ROW_STATUSES.LOSSY);
    assert.strictEqual(codex.workspaceSideEffects.length, 1);
  });

  test("excludes unavailable harnesses, orders output deterministically, and has no findings for unused capabilities", () => {
    const workflow: PromptFile = {
      steps: [
        { type: "script", script: "echo script" },
        { prompt: "disabled", enabled: false },
      ],
    };
    const unavailable = installed(HARNESS_IDS.CODEX_CLI, {
      available: false,
    });
    const capabilities = snapshot({
      [HARNESS_IDS.CODEX_CLI]: unavailable,
    });
    const first = buildReport(workflow, capabilities);
    const second = buildReport(workflow, capabilities);
    assert.deepStrictEqual(first, second);
    assert.deepStrictEqual(
      first.rows.map((row) => row.harnessId),
      (Object.values(HARNESS_IDS) as HarnessId[]).filter(
        (harnessId) => harnessId !== HARNESS_IDS.CODEX_CLI
      )
    );
    assert.deepStrictEqual(first.excludedHarnesses, [HARNESS_IDS.CODEX_CLI]);
    assert.ok(
      first.rows.every(
        (row) =>
          row.status === PORTABILITY_ROW_STATUSES.READY &&
          row.diagnostics.length === 0 &&
          row.workspaceSideEffects.length === 0
      )
    );
  });
});
