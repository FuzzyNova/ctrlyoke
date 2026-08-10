import * as assert from "assert";
import { suite, test, teardown } from "mocha";
import { configService } from "../../config/CtrlYokeConfigService";
import type { ConfigBackend } from "../../config/CtrlYokeConfigService";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";

function makeBackend(data: PartialCtrlYokeSettings): ConfigBackend {
  return {
    getAll: () => data,
    set: async () => {},
  };
}

/** In-memory fake so tests never touch the real ~/.ctrlyoke trust store file. */
function makeFakeTrustStore(decisions: Record<string, "allow" | "deny">) {
  const keyFor = (workspaceIdentity: string, root: string) =>
    `${workspaceIdentity}::${root}`;
  return {
    getApprovedRoots: (workspaceIdentity: string, roots: readonly string[]) =>
      roots.filter(
        (root) => decisions[keyFor(workspaceIdentity, root)] === "allow"
      ),
    getPendingRoots: (workspaceIdentity: string, roots: readonly string[]) =>
      roots.filter(
        (root) => decisions[keyFor(workspaceIdentity, root)] === undefined
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
});

suite("ConfigurationUtils — Antigravity statusline tracking", () => {
  teardown(() => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));
  });

  test("defaults to enabled", () => {
    configService.setUserBackend(makeBackend({}));
    configService.setWorkspaceBackend(makeBackend({}));

    assert.strictEqual(
      ConfigurationUtils.shouldTrackAntigravityStatusLine(),
      true
    );
  });

  test("reads the effective value from the config hierarchy", () => {
    configService.setUserBackend(
      makeBackend({
        permissions: { antigravityStatusLineTracking: false },
      })
    );
    configService.setWorkspaceBackend(makeBackend({}));
    assert.strictEqual(
      ConfigurationUtils.shouldTrackAntigravityStatusLine(),
      false
    );

    configService.setWorkspaceBackend(
      makeBackend({
        permissions: { antigravityStatusLineTracking: true },
      })
    );
    assert.strictEqual(
      ConfigurationUtils.shouldTrackAntigravityStatusLine(),
      true
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
