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
  HOOK_EVENT_ORDER,
  type HookEvent,
  type HarnessId,
} from "../../types/DashboardConstants";
import {
  COMPATIBILITY_DIAGNOSTIC_CODES,
  getCompatibilityCaveatMessage,
  type HarnessCapabilityRegistrySnapshot,
  type InstalledHarnessCapabilities,
} from "../../types/CompatibilityTypes";
import { CODEX_PERMISSION_CAPABILITIES } from "../../core/harness/codex/CodexToolPermissionMapper";
import type { PromptFile } from "../../types/CtrlYokeTypes";
import { mergeServerDeniedTools } from "../../types/ToolPermissionUtils";

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
  const hookState = Object.fromEntries(
    HOOK_EVENT_ORDER.map((event) => [event, state])
  ) as Record<HookEvent, typeof state>;
  const hookDeclarations = Object.fromEntries(
    HOOK_EVENT_ORDER.map((event) => [event, declaration])
  ) as Record<HookEvent, typeof declaration>;
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
      hooks: hookDeclarations,
      mcp: { perServerToolFiltering: declaration },
    },
    effective: {
      permissions: {
        mode: state,
        allowedTools: state,
        deniedTools: state,
      },
      hooks: hookState,
      mcp: { perServerToolFiltering: state },
    },
  };
}

function snapshot(
  overrides: Partial<Record<HarnessId, InstalledHarnessCapabilities>> = {}
): HarnessCapabilityRegistrySnapshot {
  const harnesses = {} as Record<HarnessId, InstalledHarnessCapabilities>;
  for (const harnessId of Object.values(HARNESS_IDS) as HarnessId[]) {
    harnesses[harnessId] =
      overrides[harnessId] ?? installed(harnessId, true, "exact", "verified");
  }
  return {
    schemaVersion: 1,
    enabledDomains: [
      CAPABILITY_DOMAINS.PERMISSIONS,
      CAPABILITY_DOMAINS.HOOKS,
      CAPABILITY_DOMAINS.MCP,
    ],
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
    assert.ok(
      diagnostics.every((diagnostic) => diagnostic.severity === "warning")
    );
    assert.ok(
      diagnostics.every((diagnostic) =>
        diagnostic.message.includes("NOT ENFORCED")
      )
    );
  });

  test("does not warn for an unused workflow harness default", () => {
    const workflow = mixedWorkflow({
      steps: [{ prompt: "Claude target", harness: HARNESS_IDS.CLAUDE_CLI }],
    });
    const diagnostics = analyze(
      workflow,
      snapshot({
        [HARNESS_IDS.CODEX_CLI]: installed(
          HARNESS_IDS.CODEX_CLI,
          true,
          "unsupported",
          "verified"
        ),
      })
    );
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
        steps: [{ prompt: "Claude target", harness: HARNESS_IDS.CLAUDE_CLI }],
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
    assert.ok(
      !diagnostics.some((diagnostic) => diagnostic.capability === "hooks")
    );
  });

  test("analyzes unsupported MCP denials in the MCP domain", () => {
    const toolPermissions = {
      mode: "custom" as const,
      allowedTools: [],
      deniedTools: [],
    };
    const workflow = mixedWorkflow({
      harness: HARNESS_IDS.ANTIGRAVITY_CLI,
      toolPermissions,
      mcpServers: [{ id: "ctrlyoke", deniedTools: ["append_queue"] }],
      steps: [{ prompt: "Antigravity target" }],
    });
    const merged = mergeServerDeniedTools(toolPermissions, workflow.mcpServers);
    assert.deepStrictEqual(merged?.deniedTools, [
      "mcp__ctrlyoke__append_queue",
    ]);

    const diagnostics = analyze(
      workflow,
      snapshot({
        [HARNESS_IDS.ANTIGRAVITY_CLI]: installed(
          HARNESS_IDS.ANTIGRAVITY_CLI,
          true,
          "unsupported",
          "verified"
        ),
      })
    );
    assert.deepStrictEqual(
      diagnostics
        .filter(
          (diagnostic) => diagnostic.capability === "perServerToolFiltering"
        )
        .map(({ code, capability, sourceTier, propertyPointer }) => ({
          code,
          capability,
          sourceTier,
          propertyPointer,
        })),
      [
        {
          code: "compatibility.mcp.perServerToolFiltering.unsupported",
          capability: "perServerToolFiltering",
          sourceTier: "workflow",
          propertyPointer: "/mcpServers/0/deniedTools",
        },
      ]
    );
    assert.strictEqual(
      diagnostics.some((diagnostic) => diagnostic.capability === "deniedTools"),
      false
    );
  });

  test("points prompt-authored MCP denials at the prompt mcpServers entry", () => {
    const workflow = mixedWorkflow({
      harness: HARNESS_IDS.ANTIGRAVITY_CLI,
      toolPermissions: {
        mode: "custom",
        allowedTools: [],
        deniedTools: [],
      },
      steps: [
        {
          prompt: "Antigravity target",
          mcpServers: [{ id: "ctrlyoke", deniedTools: ["append_queue"] }],
        },
      ],
    });
    const diagnostics = analyze(
      workflow,
      snapshot({
        [HARNESS_IDS.ANTIGRAVITY_CLI]: installed(
          HARNESS_IDS.ANTIGRAVITY_CLI,
          true,
          "unsupported",
          "verified"
        ),
      })
    );
    const denial = diagnostics.find(
      (diagnostic) => diagnostic.capability === "perServerToolFiltering"
    );
    assert.ok(denial);
    assert.strictEqual(denial.sourceTier, "prompt");
    assert.strictEqual(
      denial.propertyPointer,
      "/steps/0/mcpServers/0/deniedTools"
    );
  });

  test("diagnoses every server filter with its authored pointer", () => {
    const workflow = mixedWorkflow({
      harness: HARNESS_IDS.ANTIGRAVITY_CLI,
      toolPermissions: undefined,
      mcpServers: [
        { id: "first", deniedTools: ["one"] },
        { id: "second", deniedTools: ["two"] },
      ],
      steps: [{ prompt: "Antigravity target" }],
    });
    const diagnostics = analyze(
      workflow,
      snapshot({
        [HARNESS_IDS.ANTIGRAVITY_CLI]: installed(
          HARNESS_IDS.ANTIGRAVITY_CLI,
          true,
          "unsupported",
          "verified"
        ),
      })
    ).filter(
      (diagnostic) => diagnostic.capability === "perServerToolFiltering"
    );

    assert.deepStrictEqual(
      diagnostics.map((diagnostic) => ({
        sourceTier: diagnostic.sourceTier,
        propertyPointer: diagnostic.propertyPointer,
      })),
      [
        {
          sourceTier: "workflow",
          propertyPointer: "/mcpServers/0/deniedTools",
        },
        {
          sourceTier: "workflow",
          propertyPointer: "/mcpServers/1/deniedTools",
        },
      ]
    );
  });

  test("does not turn Codex native server denials into a general permission warning", () => {
    const codex = installed(
      HARNESS_IDS.CODEX_CLI,
      true,
      "unsupported",
      "verified"
    );
    const exactMcp = codex.descriptor.mcp!.perServerToolFiltering;
    codex.descriptor.mcp = { perServerToolFiltering: exactMcp };
    codex.effective.mcp = {
      perServerToolFiltering: {
        fidelity: "exact",
        mechanism: "native",
        verification: "verified",
      },
    };
    const diagnostics = analyze(
      mixedWorkflow({
        harness: HARNESS_IDS.CODEX_CLI,
        mcpServers: [{ id: "codex", deniedTools: ["server_tool"] }],
        steps: [{ prompt: "Codex target" }],
      }),
      snapshot({ [HARNESS_IDS.CODEX_CLI]: codex })
    );

    assert.strictEqual(
      diagnostics.some(
        (diagnostic) => diagnostic.capability === "perServerToolFiltering"
      ),
      false
    );
    assert.deepStrictEqual(
      diagnostics.map((diagnostic) => diagnostic.capability),
      ["mode", "allowedTools", "deniedTools"]
    );
  });

  test("is silent when no server filter is authored", () => {
    const diagnostics = analyze(
      mixedWorkflow({
        harness: HARNESS_IDS.ANTIGRAVITY_CLI,
        toolPermissions: undefined,
        mcpServers: [{ id: "server" }],
        steps: [{ prompt: "Antigravity target" }],
      }),
      snapshot({
        [HARNESS_IDS.ANTIGRAVITY_CLI]: installed(
          HARNESS_IDS.ANTIGRAVITY_CLI,
          true,
          "unsupported",
          "verified"
        ),
      })
    );
    assert.deepStrictEqual(diagnostics, []);
  });

  test("warns that Antigravity allowAll is only partially translated", () => {
    const workflow = mixedWorkflow({
      harness: HARNESS_IDS.ANTIGRAVITY_CLI,
      toolPermissions: {
        mode: "allowAll",
        allowedTools: [],
        deniedTools: [],
      },
      steps: [{ prompt: "Antigravity target" }],
    });
    const diagnostics = analyze(
      workflow,
      snapshot({
        [HARNESS_IDS.ANTIGRAVITY_CLI]: installed(
          HARNESS_IDS.ANTIGRAVITY_CLI,
          true,
          "partial",
          "verified"
        ),
      })
    );

    assert.deepStrictEqual(
      diagnostics.map(({ code, capability, harnessId }) => ({
        code,
        capability,
        harnessId,
      })),
      [
        {
          code: COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_PARTIAL,
          capability: "mode",
          harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
        },
      ]
    );
  });

  test("keeps the allowAll deny-list warning visible on Antigravity", () => {
    const workflow = mixedWorkflow({
      harness: HARNESS_IDS.ANTIGRAVITY_CLI,
      toolPermissions: {
        mode: "allowAll",
        allowedTools: [],
        deniedTools: ["shell(rm:*)"],
      },
      steps: [{ prompt: "Antigravity target" }],
    });
    const antigravity = installed(
      HARNESS_IDS.ANTIGRAVITY_CLI,
      true,
      "partial",
      "verified"
    );
    antigravity.effective!.permissions!.deniedTools = {
      fidelity: "unsupported",
      mechanism: "none",
      verification: "verified",
    };
    const diagnostics = analyze(
      workflow,
      snapshot({ [HARNESS_IDS.ANTIGRAVITY_CLI]: antigravity })
    );

    assert.deepStrictEqual(
      diagnostics.map(({ code, capability }) => ({ code, capability })),
      [
        {
          code: COMPATIBILITY_DIAGNOSTIC_CODES.PERMISSION_MODE_PARTIAL,
          capability: "mode",
        },
        {
          code: COMPATIBILITY_DIAGNOSTIC_CODES.DENIED_TOOLS_NOT_ENFORCED,
          capability: "deniedTools",
        },
      ]
    );
  });

  test("suppresses every diagnostic when mode is dangerouslyAllowAll, even with stale leftover lists", () => {
    const workflow = mixedWorkflow({
      toolPermissions: {
        mode: "dangerouslyAllowAll",
        allowedTools: ["shell(git:*)"],
        deniedTools: ["shell(rm:*)"],
      },
      mcpServers: [{ id: "ctrlyoke", deniedTools: ["append_queue"] }],
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
                verification: "unknown",
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
    assert.deepStrictEqual(diagnostics, []);
  });

  test("suppresses every diagnostic when mode is none", () => {
    const workflow = mixedWorkflow({
      toolPermissions: {
        mode: "none",
        allowedTools: ["shell(git:*)"],
        deniedTools: ["shell(rm:*)"],
      },
      steps: [{ prompt: "Codex target" }],
    });
    const diagnostics = analyze(
      workflow,
      snapshot({
        [HARNESS_IDS.CODEX_CLI]: installed(
          HARNESS_IDS.CODEX_CLI,
          true,
          "unsupported",
          "verified"
        ),
      })
    );
    assert.deepStrictEqual(diagnostics, []);
    assert.strictEqual(
      mergeServerDeniedTools(null, [
        { id: "ctrlyoke", deniedTools: ["append_queue"] },
      ]),
      null
    );
  });

  test("folds the caveat reason into a permanently unsupported capability's message and omits 'unverified'", () => {
    // A permanently unsupported capability (Codex's granular tool lists) is an
    // architectural fact, not a claim that erodes when the installed CLI
    // version falls outside the verified range. Even with `verification:
    // "unknown"`, the message must explain *why* it's unsupported rather than
    // implying ctrlyoke merely hasn't checked.
    const workflow = mixedWorkflow({
      steps: [{ prompt: "Codex target" }],
    });
    const diagnostics = analyze(
      workflow,
      snapshot({
        [HARNESS_IDS.CODEX_CLI]: {
          available: true,
          version: "999.0.0",
          descriptor: {
            harnessId: HARNESS_IDS.CODEX_CLI,
            permissions: CODEX_PERMISSION_CAPABILITIES,
          },
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
                verification: "unknown",
              },
              deniedTools: {
                fidelity: "unsupported",
                mechanism: "none",
                verification: "unknown",
              },
            },
          },
        },
      })
    );

    assert.ok(
      !diagnostics.some((diagnostic) =>
        diagnostic.code.endsWith(".unverified")
      ),
      "an unsupported capability must not also be flagged unverified"
    );

    const allowedToolsDiagnostics = diagnostics.filter(
      (diagnostic) => diagnostic.capability === "allowedTools"
    );
    assert.strictEqual(allowedToolsDiagnostics.length, 1);
    assert.strictEqual(
      allowedToolsDiagnostics[0].code,
      "compatibility.permissions.allowedTools.notEnforced"
    );
    const caveat = getCompatibilityCaveatMessage(
      CODEX_PERMISSION_CAPABILITIES.allowedTools.caveatCode
    );
    assert.ok(caveat);
    assert.ok(allowedToolsDiagnostics[0].message.includes(caveat!));
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
    assert.ok(
      diagnostics.some((diagnostic) => diagnostic.code.endsWith("partial"))
    );
    assert.ok(
      diagnostics.some((diagnostic) => diagnostic.code.endsWith("unverified"))
    );
    assert.ok(
      diagnostics.every((diagnostic) => diagnostic.severity === "warning")
    );
  });

  test("warns only for configured hook events and preserves source pointers", () => {
    const workflow = mixedWorkflow({
      steps: [
        {
          prompt: "Target",
          harness: HARNESS_IDS.CODEX_CLI,
          hooks: [{ event: "error", command: "node ./hook.js" }],
        },
      ],
    });
    const codex = installed(HARNESS_IDS.CODEX_CLI, true, "exact", "verified");
    codex.descriptor.hooks!.error = {
      ...codex.descriptor.hooks!.error,
      fidelity: "unsupported",
      mechanism: "none",
    };
    codex.effective!.hooks!.error = {
      fidelity: "unsupported",
      mechanism: "none",
      verification: "verified",
    };
    const diagnostics = analyze(
      workflow,
      snapshot({ [HARNESS_IDS.CODEX_CLI]: codex })
    );

    assert.deepStrictEqual(
      diagnostics
        .filter((diagnostic) => diagnostic.capability === "error")
        .map(({ code, sourceTier, propertyPointer, consumer }) => ({
          code,
          sourceTier,
          propertyPointer,
          consumer,
        })),
      [
        {
          code: COMPATIBILITY_DIAGNOSTIC_CODES.HOOK_EVENT_UNSUPPORTED,
          sourceTier: "prompt",
          propertyPointer: "/steps/0/hooks/0/event",
          consumer: { kind: FINAL_STEP_PHASES.QUEUE, stepIndex: 0 },
        },
      ]
    );
    assert.ok(
      diagnostics
        .find((diagnostic) => diagnostic.capability === "error")
        ?.message.toLowerCase()
        .includes("error")
    );
    assert.ok(diagnostics[0].remediation);

    const unused = analyze(
      mixedWorkflow({
        steps: [{ prompt: "Target", harness: HARNESS_IDS.CODEX_CLI }],
      }),
      snapshot({ [HARNESS_IDS.CODEX_CLI]: codex })
    );
    assert.ok(!unused.some((diagnostic) => diagnostic.capability === "error"));
  });
});
