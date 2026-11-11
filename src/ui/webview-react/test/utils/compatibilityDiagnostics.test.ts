import { describe, expect, it } from "vitest";
import {
  diagnosticsForPermissions,
  sandboxSupportDiagnostic,
  workflowPermissionDiagnostic,
} from "@utils/compatibilityDiagnostics";
import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  HARNESS_IDS,
  PERMISSION_CAPABILITY_KEYS,
} from "@root/types/DashboardConstants";
import type { CompatibilityExecutionTarget } from "@root/types/CompatibilityAnalyzer";
import {
  COMPATIBILITY_DIAGNOSTIC_CODES,
  type CompatibilityDiagnostic,
  HOOK_CAVEAT_CODES,
  MCP_CAVEAT_CODES,
  PERMISSION_CAVEAT_CODES,
  getCompatibilityCaveatMessage,
  isAdvisoryCaveat,
  type HarnessCapabilityRegistrySnapshot,
} from "@root/types/CompatibilityTypes";
import type { HarnessId } from "@root/types/DashboardConstants";

describe("diagnosticsForPermissions", () => {
  it("keeps permission diagnostics in input order and excludes other capabilities", () => {
    const permissionCapabilities = [
      PERMISSION_CAPABILITY_KEYS.MODE,
      PERMISSION_CAPABILITY_KEYS.ALLOWED_TOOLS,
      PERMISSION_CAPABILITY_KEYS.DENIED_TOOLS,
    ];
    const diagnostics = [
      ...permissionCapabilities.map((capability) => ({
        capability,
      } as CompatibilityDiagnostic)),
      { capability: "terminal" } as CompatibilityDiagnostic,
    ];

    expect(diagnosticsForPermissions(diagnostics)).toEqual(
      diagnostics.slice(0, permissionCapabilities.length)
    );
  });
});

function target(
  mode: string,
  allowedTools: string[],
  deniedTools: string[],
  harness: HarnessId = HARNESS_IDS.CODEX_CLI
): CompatibilityExecutionTarget {
  return {
    consumer: { kind: "queue", stepIndex: 0 },
    resolved: {
      properties: {
        harness,
        model: "",
        executionMode: "headless",
        resumeSession: false,
        mcpServers: null,
        hooks: null,
        toolPermissions: {
          mode: mode as never,
          allowedTools,
          deniedTools,
        },
      },
      sources: {},
    },
  };
}

const unsupportedSnapshot: HarnessCapabilityRegistrySnapshot = {
  schemaVersion: 1,
  enabledDomains: ["permissions"],
  harnesses: {
    [HARNESS_IDS.CODEX_CLI]: {
      available: true,
      version: "1.0.0",
      descriptor: { harnessId: HARNESS_IDS.CODEX_CLI },
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
  } as unknown as HarnessCapabilityRegistrySnapshot["harnesses"],
};

const claudePartialSnapshot: HarnessCapabilityRegistrySnapshot = {
  schemaVersion: 1,
  enabledDomains: ["permissions"],
  harnesses: {
    [HARNESS_IDS.CLAUDE_CLI]: {
      available: true,
      version: "1.0.0",
      descriptor: {
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        permissions: {
          allowedTools: {
            fidelity: "partial",
            mechanism: "native",
            verification: "verified",
            caveatCode: "permissions.claudePreapprovedSettings",
          },
        },
      },
      effective: {
        permissions: {
          mode: {
            fidelity: "exact",
            mechanism: "native",
            verification: "verified",
          },
          allowedTools: {
            fidelity: "partial",
            mechanism: "native",
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
  } as unknown as HarnessCapabilityRegistrySnapshot["harnesses"],
};

describe("workflowPermissionDiagnostic", () => {
  it.each([
    [HARNESS_IDS.CODEX_CLI, "Codex"],
    ["unknown-cli" as HarnessId, "unknown-cli"],
  ])("uses the shared short label for %s", (harnessId, label) => {
    const result = workflowPermissionDiagnostic(
      "allowedTools",
      [target("custom", ["shell(git:*)"], [], harnessId)],
      unsupportedSnapshot
    );

    expect(result?.message).toContain(`Ignored by 1 ${label} step`);
  });

  it("ignores leftover lists on a target whose resolved mode is dangerouslyAllowAll", () => {
    const targets = [
      target("dangerouslyAllowAll", ["shell(git:*)"], ["shell(rm:*)"]),
    ];
    expect(
      workflowPermissionDiagnostic("allowedTools", targets, unsupportedSnapshot)
    ).toBeUndefined();
    expect(
      workflowPermissionDiagnostic("deniedTools", targets, unsupportedSnapshot)
    ).toBeUndefined();
  });

  it("still reports ignored lists for a custom-mode target on an unsupported harness", () => {
    const targets = [target("custom", ["shell(git:*)"], [])];
    expect(
      workflowPermissionDiagnostic("allowedTools", targets, unsupportedSnapshot)
    ).toBeDefined();
  });

  it("words a reason caveat as a single because clause", () => {
    const harness = unsupportedSnapshot.harnesses[HARNESS_IDS.CODEX_CLI]!;
    const snapshot = {
      ...unsupportedSnapshot,
      harnesses: {
        [HARNESS_IDS.CODEX_CLI]: {
          ...harness,
          descriptor: {
            harnessId: HARNESS_IDS.CODEX_CLI,
            permissions: {
              allowedTools: {
                fidelity: "unsupported",
                mechanism: "none",
                verification: "verified",
                caveatCode: PERMISSION_CAVEAT_CODES.SANDBOX_APPROVAL_MODES,
              },
            },
          },
        },
      } as unknown as HarnessCapabilityRegistrySnapshot["harnesses"],
    };
    const message = workflowPermissionDiagnostic(
      "allowedTools",
      [target("custom", ["shell(git:*)"], [])],
      snapshot
    )?.message;
    expect(message).toContain(
      "Ignored by 1 Codex step because this harness uses sandbox/approval modes"
    );
    expect(message).not.toContain("because because");
  });

  it("writes every reason caveat as a because clause", () => {
    const codes = [
      ...Object.values(PERMISSION_CAVEAT_CODES),
      ...Object.values(MCP_CAVEAT_CODES),
      ...Object.values(HOOK_CAVEAT_CODES),
    ];
    for (const code of codes) {
      const message = getCompatibilityCaveatMessage(code);
      expect(message, code).toBeDefined();
      expect(message!.startsWith("because "), code).toBe(
        !isAdvisoryCaveat(code)
      );
    }
  });

  it("reports Claude partial allowed tools as enforced with an informational caveat", () => {
    const targets = [
      target("custom", ["shell(npm test)"], [], HARNESS_IDS.CLAUDE_CLI),
      target("custom", ["write"], [], HARNESS_IDS.CLAUDE_CLI),
    ];
    expect(
      workflowPermissionDiagnostic(
        "allowedTools",
        targets,
        claudePartialSnapshot
      )
    ).toEqual({
      severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.INFO,
      message:
        "Enforced for 2 Claude Code steps, but Claude's own settings allow rules can add to this list in headless mode.",
    });
  });
});

describe("sandboxSupportDiagnostic", () => {
  const diagnostic = (code: string) =>
    ({
      code,
      severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR,
      harnessId: HARNESS_IDS.QWEN_CLI,
      capability: "terminal",
      message: code,
    }) as CompatibilityDiagnostic;

  it("picks the sandbox support diagnostic and ignores the rest", () => {
    const other = diagnostic(
      COMPATIBILITY_DIAGNOSTIC_CODES.MCP_FILTERING_PARTIAL
    );
    const sandbox = diagnostic(
      COMPATIBILITY_DIAGNOSTIC_CODES.SANDBOX_UNSUPPORTED
    );
    expect(sandboxSupportDiagnostic([other, sandbox])).toBe(sandbox);
    expect(sandboxSupportDiagnostic([other])).toBeUndefined();
  });
});
