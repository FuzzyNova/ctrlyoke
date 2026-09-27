import * as assert from "assert";
import * as path from "path";
import { suite, test, teardown } from "mocha";
import { configService } from "../../config/CtrlYokeConfigService";
import type { ConfigBackend } from "../../config/CtrlYokeConfigService";
import {
  ConfigurationUtils,
  secondsToMs,
} from "../../utils/ConfigurationUtils";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";
import {
  PERMISSION_MODES,
  STATUS_LINE_HARNESS_IDS,
} from "../../types/DashboardConstants";
import { ExternalRootsTrustStore } from "../../config/ExternalRootsTrustStore";

function makeBackend(data: PartialCtrlYokeSettings): ConfigBackend {
  return {
    getAll: () => data,
    set: async () => {},
  };
}

/** In-memory fake so tests never touch the real ~/.ctrlyoke trust store file. */
function makeFakeTrustStore(decisions: Record<string, "allow" | "deny">) {
  const keyFor = (scopeIdentity: string, root: string) =>
    `${scopeIdentity}::${ExternalRootsTrustStore.canonicalizeRoot(root)}`;
  const getDecision = (scopeIdentity: string, root: string) =>
    decisions[keyFor(scopeIdentity, root)] ??
    decisions[`${scopeIdentity}::${root}`];
  return {
    getApprovedRoots: (scopeIdentity: string, roots: readonly string[]) =>
      roots.filter((root) => getDecision(scopeIdentity, root) === "allow"),
    getPendingRoots: (scopeIdentity: string, roots: readonly string[]) =>
      roots.filter((root) => getDecision(scopeIdentity, root) === undefined),
  };
}

suite("ConfigurationUtils — allowed external file roots", () => {
  test("secondsToMs converts fractions and preserves zero and omission", () => {
    assert.strictEqual(secondsToMs(0.25), 250);
    assert.strictEqual(secondsToMs(0), 0);
    assert.strictEqual(secondsToMs(undefined), undefined);
  });

  teardown(() => {
    // CtrlYokeConfigService has no "unset backend" method; reassigning
    // undefined-shaped backends keeps other suites (which construct their
    // own CtrlYokeConfigService instances) unaffected, but this suite
    // deliberately uses the shared singleton like CliProviderUtils.test.ts
    // does, so restore it to empty backends afterward.
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
  });

  test("getTrustedExternalRootsByScope splits user vs workspace roots", () => {
    configService.setUserBackend(
      makeBackend({
        permissions: { trustedExternalRoots: ["/home/user/logs"] },
      })
    );
    configService.setWorkspaceBackend(
      makeBackend({
        permissions: { trustedExternalRoots: ["/shared/logs"] },
      })
    );

    const { user, workspace } =
      ConfigurationUtils.getTrustedExternalRootsByScope();
    assert.deepStrictEqual(user, ["/home/user/logs"]);
    assert.deepStrictEqual(workspace, ["/shared/logs"]);
  });

  test("getTrustedExternalRoots unions both scopes (not array-replace)", () => {
    configService.setUserBackend(
      makeBackend({
        permissions: { trustedExternalRoots: ["/home/user/logs"] },
      })
    );
    configService.setWorkspaceBackend(
      makeBackend({
        permissions: { trustedExternalRoots: ["/shared/logs"] },
      })
    );

    const all = ConfigurationUtils.getTrustedExternalRoots();
    assert.deepStrictEqual(
      [...all].sort(),
      ["/home/user/logs", "/shared/logs"].sort()
    );
  });

  test("getEffectiveApprovedExternalFileRoots trusts every user-scope root without a trust-store decision", () => {
    configService.setUserBackend(
      makeBackend({
        permissions: { trustedExternalRoots: ["/home/user/logs"] },
      })
    );
    configService.setWorkspaceBackend(makeBackend({}));
    const fakeStore = makeFakeTrustStore({});

    const effective = ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
      "workspace-id",
      undefined,
      fakeStore
    );
    assert.deepStrictEqual(effective, ["/home/user/logs"]);
  });

  test("getEffectiveApprovedExternalFileRoots excludes unapproved workspace-scope roots", () => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(
      makeBackend({
        permissions: { trustedExternalRoots: ["/shared/logs"] },
      })
    );
    const fakeStore = makeFakeTrustStore({}); // no decision recorded

    const effective = ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
      "workspace-id",
      undefined,
      fakeStore
    );
    assert.deepStrictEqual(effective, []);
  });

  test("getEffectiveApprovedExternalFileRoots includes an approved workspace-scope root", () => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(
      makeBackend({
        permissions: { trustedExternalRoots: ["/shared/logs"] },
      })
    );
    const fakeStore = makeFakeTrustStore({
      "workspace-id::/shared/logs": "allow",
    });

    const effective = ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
      "workspace-id",
      undefined,
      fakeStore
    );
    assert.deepStrictEqual(effective, ["/shared/logs"]);
  });

  test("getPendingWorkspaceExternalFileRoots reports only never-decided workspace roots", () => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(
      makeBackend({
        permissions: {
          trustedExternalRoots: ["/shared/logs", "/shared/other"],
        },
      })
    );
    const fakeStore = makeFakeTrustStore({
      "workspace-id::/shared/logs": "allow",
    });

    const pending = ConfigurationUtils.getPendingWorkspaceExternalFileRoots(
      "workspace-id",
      fakeStore
    );
    assert.deepStrictEqual(pending, ["/shared/other"]);
  });

  test("getEffectiveApprovedExternalFileRoots inherits, replaces, or disables", () => {
    const userRoot = "C:\\trusted\\user";
    const workspaceRoot = "C:\\trusted\\workspace";
    const workflowRoot = "C:\\trusted\\workflow";
    const fakeStore = makeFakeTrustStore({
      "workspace-id::C:\\trusted\\workspace": "allow",
      "workflow-id::C:\\trusted\\workflow": "allow",
    });
    configService.setUserBackend(
      makeBackend({
        permissions: { trustedExternalRoots: [userRoot] },
      })
    );
    configService.setWorkspaceBackend(
      makeBackend({
        permissions: { trustedExternalRoots: [workspaceRoot] },
      })
    );

    assert.deepStrictEqual(
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
        "workspace-id",
        undefined,
        fakeStore
      ),
      [userRoot, workspaceRoot]
    );
    assert.deepStrictEqual(
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
        "workspace-id",
        { identity: "workflow-id", declaredRoots: [workflowRoot] },
        fakeStore
      ),
      [workflowRoot]
    );
    assert.deepStrictEqual(
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
        "workspace-id",
        { identity: "workflow-id", declaredRoots: null },
        fakeStore
      ),
      []
    );
  });

  test("deduplicates equivalent roots across base and workflow scopes", () => {
    const root = process.cwd();
    const equivalentRoot = root.replace(/\\/g, "/").toLowerCase();
    const workflowRoot = path.join(root, "src");
    const equivalentWorkflowRoot = workflowRoot
      .replace(/\\/g, "/")
      .toLowerCase();
    const fakeStore = makeFakeTrustStore({
      [`workspace-id::${ExternalRootsTrustStore.canonicalizeRoot(
        equivalentRoot
      )}`]: "allow",
      [`workflow-id::${ExternalRootsTrustStore.canonicalizeRoot(
        equivalentWorkflowRoot
      )}`]: "allow",
    });
    configService.setUserBackend(
      makeBackend({
        permissions: { trustedExternalRoots: [root] },
      })
    );
    configService.setWorkspaceBackend(
      makeBackend({
        permissions: { trustedExternalRoots: [equivalentRoot] },
      })
    );

    assert.strictEqual(ConfigurationUtils.getTrustedExternalRoots().length, 1);

    const inherited = ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
      "workspace-id",
      undefined,
      fakeStore
    );
    assert.strictEqual(inherited.length, 1);

    const workflowRoots =
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
        "workspace-id",
        {
          identity: "workflow-id",
          declaredRoots: [workflowRoot, equivalentWorkflowRoot],
        },
        fakeStore
      );
    assert.strictEqual(workflowRoots.length, 1);
  });

  test("getPendingWorkflowExternalFileRoots excludes broader-scope approvals", () => {
    const approvedAtWorkspace = process.cwd();
    const equivalentRequested = approvedAtWorkspace
      .replace(/\\/g, "/")
      .toLowerCase();
    const workflowOnly = `${approvedAtWorkspace}\\workflow-root`;
    const fakeStore = makeFakeTrustStore({
      [`workspace-id::${ExternalRootsTrustStore.canonicalizeRoot(
        approvedAtWorkspace
      )}`]: "allow",
    });
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(
      makeBackend({
        permissions: { trustedExternalRoots: [approvedAtWorkspace] },
      })
    );

    const pending = ConfigurationUtils.getPendingWorkflowExternalFileRoots(
      "workspace-id",
      "workflow-id",
      [equivalentRequested, workflowOnly],
      fakeStore
    );
    assert.deepStrictEqual(pending, [workflowOnly]);
  });
});

suite("ConfigurationUtils — context resolution failure mode", () => {
  teardown(() => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
  });

  test("reads the configured mode and falls back to warn", () => {
    configService.setUserBackend(
      makeBackend({ execution: { contextResolutionFailure: "fail" } })
    );
    assert.strictEqual(
      ConfigurationUtils.getContextResolutionFailureMode(),
      "fail"
    );

    configService.setUserBackend(makeBackend({}));
    assert.strictEqual(
      ConfigurationUtils.getContextResolutionFailureMode(),
      "warn"
    );
  });
});

suite("ConfigurationUtils — spawn tool permissions", () => {
  teardown(() => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
  });

  const custom = {
    mode: PERMISSION_MODES.CUSTOM,
    allowedTools: ["write"],
    deniedTools: [],
  };

  test("passes a resolved config through unchanged", () => {
    assert.deepStrictEqual(
      ConfigurationUtils.resolveSpawnToolPermissions(custom),
      custom
    );
  });

  test("returns null for an explicit null and for mode none", () => {
    assert.strictEqual(
      ConfigurationUtils.resolveSpawnToolPermissions(null),
      null
    );
    assert.strictEqual(
      ConfigurationUtils.resolveSpawnToolPermissions({
        ...custom,
        mode: PERMISSION_MODES.NONE,
      }),
      null
    );
  });

  test("falls back to the settings default, including a none default", () => {
    configService.setUserBackend(
      makeBackend({
        defaults: {
          toolPermissions: { mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL },
        },
      })
    );
    assert.strictEqual(
      ConfigurationUtils.resolveSpawnToolPermissions(undefined)?.mode,
      PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL
    );

    configService.setUserBackend(
      makeBackend({
        defaults: { toolPermissions: { mode: PERMISSION_MODES.NONE } },
      })
    );
    assert.strictEqual(
      ConfigurationUtils.resolveSpawnToolPermissions(undefined),
      null
    );
  });
});

suite("ConfigurationUtils — dynamic queue settings", () => {
  teardown(() => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
  });

  test("returns the default maximum parallel step count", () => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));

    assert.strictEqual(
      ConfigurationUtils.getDynamicQueueConfig().maxParallelSteps,
      6
    );
  });

  test("reads maxParallelSteps from the merged queue settings", () => {
    configService.setUserBackend(
      makeBackend({ queue: { maxParallelSteps: 3 } })
    );
    configService.setWorkspaceBackend(makeBackend({}));

    assert.strictEqual(
      ConfigurationUtils.getDynamicQueueConfig().maxParallelSteps,
      3
    );
  });
});

suite("ConfigurationUtils — statusline tracking", () => {
  teardown(() => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
  });

  test("defaults to enabled", () => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));

    assert.strictEqual(
      ConfigurationUtils.getStatusLineHarnessSettings(
        STATUS_LINE_HARNESS_IDS.ANTIGRAVITY
      ).enabled,
      true
    );
  });

  test("reads the effective value from the config hierarchy", () => {
    configService.setUserBackend(
      makeBackend({
        permissions: {},
        statusLine: {
          byHarness: {
            "antigravity-cli": {
              enabled: false,
              customCommand: "",
              useCtrlyokeStyle: true,
            },
          },
        },
      })
    );
    configService.setWorkspaceBackend(makeBackend({}));
    assert.strictEqual(
      ConfigurationUtils.getStatusLineHarnessSettings(
        STATUS_LINE_HARNESS_IDS.ANTIGRAVITY
      ).enabled,
      false
    );

    configService.setWorkspaceBackend(
      makeBackend({
        permissions: {},
        statusLine: {
          byHarness: {
            "antigravity-cli": {
              enabled: true,
              customCommand: "",
              useCtrlyokeStyle: true,
            },
          },
        },
      })
    );
    assert.strictEqual(
      ConfigurationUtils.getStatusLineHarnessSettings(
        STATUS_LINE_HARNESS_IDS.ANTIGRAVITY
      ).enabled,
      false
    );
  });
});

suite("ConfigurationUtils — cost settings", () => {
  teardown(() => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
  });

  test("reads user pricing overrides and keeps cost visible by default", () => {
    configService.setUserBackend(
      makeBackend({
        modelPricing: {
          "claude-cli": {
            "byo-model": { inputPerMTok: 3, outputPerMTok: 15 },
          },
        },
        ui: { showCostEstimates: true },
      })
    );

    assert.deepStrictEqual(
      ConfigurationUtils.getModelPricingOverride("claude-cli", "byo-model"),
      { inputPerMTok: 3, outputPerMTok: 15 }
    );
    assert.strictEqual(ConfigurationUtils.shouldShowCostEstimates(), true);
  });

  test("reads the hide-cost setting", () => {
    configService.setUserBackend(
      makeBackend({ ui: { showCostEstimates: false } })
    );
    assert.strictEqual(ConfigurationUtils.shouldShowCostEstimates(), false);
  });
});
