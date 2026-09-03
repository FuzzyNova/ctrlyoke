import * as assert from "assert";
import * as path from "path";
import { suite, test, teardown } from "mocha";
import { configService } from "../../config/CtrlYokeConfigService";
import type { ConfigBackend } from "../../config/CtrlYokeConfigService";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";
import { STATUS_LINE_TRACKING_PROVIDERS } from "../../types/DashboardConstants";
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
      roots.filter(
        (root) => getDecision(scopeIdentity, root) === "allow"
      ),
    getPendingRoots: (scopeIdentity: string, roots: readonly string[]) =>
      roots.filter(
        (root) => getDecision(scopeIdentity, root) === undefined
      ),
  };
}

suite("ConfigurationUtils — allowed external file roots", () => {
  teardown(() => {
    // CtrlYokeConfigService has no "unset backend" method; reassigning
    // undefined-shaped backends keeps other suites (which construct their
    // own CtrlYokeConfigService instances) unaffected, but this suite
    // deliberately uses the shared singleton like CliProviderUtils.test.ts
    // does, so restore it to empty backends afterward.
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
  });

  test("getAllowedExternalFileRootsByScope splits user vs workspace roots", () => {
    configService.setUserBackend(
      makeBackend({
        permissions: { allowedExternalFileRoots: ["/home/user/logs"] },
      })
    );
    configService.setWorkspaceBackend(
      makeBackend({
        permissions: { allowedExternalFileRoots: ["/shared/logs"] },
      })
    );

    const { user, workspace } =
      ConfigurationUtils.getAllowedExternalFileRootsByScope();
    assert.deepStrictEqual(user, ["/home/user/logs"]);
    assert.deepStrictEqual(workspace, ["/shared/logs"]);
  });

  test("getAllowedExternalFileRoots unions both scopes (not array-replace)", () => {
    configService.setUserBackend(
      makeBackend({
        permissions: { allowedExternalFileRoots: ["/home/user/logs"] },
      })
    );
    configService.setWorkspaceBackend(
      makeBackend({
        permissions: { allowedExternalFileRoots: ["/shared/logs"] },
      })
    );

    const all = ConfigurationUtils.getAllowedExternalFileRoots();
    assert.deepStrictEqual(
      [...all].sort(),
      ["/home/user/logs", "/shared/logs"].sort()
    );
  });

  test("getEffectiveApprovedExternalFileRoots trusts every user-scope root without a trust-store decision", () => {
    configService.setUserBackend(
      makeBackend({
        permissions: { allowedExternalFileRoots: ["/home/user/logs"] },
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
        permissions: { allowedExternalFileRoots: ["/shared/logs"] },
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
        permissions: { allowedExternalFileRoots: ["/shared/logs"] },
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
          allowedExternalFileRoots: ["/shared/logs", "/shared/other"],
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
        permissions: { allowedExternalFileRoots: [userRoot] },
      })
    );
    configService.setWorkspaceBackend(
      makeBackend({
        permissions: { allowedExternalFileRoots: [workspaceRoot] },
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
        permissions: { allowedExternalFileRoots: [root] },
      })
    );
    configService.setWorkspaceBackend(
      makeBackend({
        permissions: { allowedExternalFileRoots: [equivalentRoot] },
      })
    );

    assert.strictEqual(
      ConfigurationUtils.getAllowedExternalFileRoots().length,
      1
    );

    const inherited =
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
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
        permissions: { allowedExternalFileRoots: [approvedAtWorkspace] },
      })
    );

    const pending =
      ConfigurationUtils.getPendingWorkflowExternalFileRoots(
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
      makeBackend({ execution: { strictContextResolution: "fail" } })
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

suite("ConfigurationUtils — statusline tracking", () => {
  teardown(() => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
  });

  test("defaults to enabled", () => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));

    assert.strictEqual(
      ConfigurationUtils.getStatusLineTrackingSettings(
        STATUS_LINE_TRACKING_PROVIDERS.ANTIGRAVITY
      ).enabled,
      true
    );
  });

  test("reads the effective value from the config hierarchy", () => {
    configService.setUserBackend(
      makeBackend({
        permissions: {
          statusLineTracking: {
            antigravity: {
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
      ConfigurationUtils.getStatusLineTrackingSettings(
        STATUS_LINE_TRACKING_PROVIDERS.ANTIGRAVITY
      ).enabled,
      false
    );

    configService.setWorkspaceBackend(
      makeBackend({
        permissions: {
          statusLineTracking: {
            antigravity: {
              enabled: true,
              customCommand: "",
              useCtrlyokeStyle: true,
            },
          },
        },
      })
    );
    assert.strictEqual(
      ConfigurationUtils.getStatusLineTrackingSettings(
        STATUS_LINE_TRACKING_PROVIDERS.ANTIGRAVITY
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
        ui: { hideCost: false },
      })
    );

    assert.deepStrictEqual(
      ConfigurationUtils.getModelPricingOverride("claude-cli", "byo-model"),
      { inputPerMTok: 3, outputPerMTok: 15 }
    );
    assert.strictEqual(ConfigurationUtils.shouldHideCost(), false);
  });

  test("reads the hide-cost setting", () => {
    configService.setUserBackend(makeBackend({ ui: { hideCost: true } }));
    assert.strictEqual(ConfigurationUtils.shouldHideCost(), true);
  });
});
