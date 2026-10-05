import * as assert from "assert";
import { suite, test } from "mocha";
import {
  HARNESS_IDS,
  HARNESS_VERSION_STATUSES,
  type HarnessId,
} from "../../types/DashboardConstants";
import {
  assessHarnessVersion,
  formatHarnessVersionGuidance,
  versionSatisfies,
} from "../../utils/HarnessVersion";
import { detectHarness } from "../../core/harness/shared/HarnessDetection";
import { IntegrationFactory } from "../../core/IntegrationFactory";

const POLICY = {
  minimum: "1.0.19",
  recommended: "1.0.92",
  updateCommand: "copilot update",
};

suite("HarnessVersion", () => {
  suite("assessHarnessVersion", () => {
    test("parses a version out of a CLI banner and normalizes it", () => {
      const assessment = assessHarnessVersion(
        "GitHub Copilot CLI 1.0.92.\nRun 'copilot update' to check for updates.",
        POLICY
      );
      assert.strictEqual(assessment.status, HARNESS_VERSION_STATUSES.SUPPORTED);
      assert.strictEqual(assessment.installedVersion, "1.0.92");
    });

    test("compares numerically, not lexically", () => {
      assert.strictEqual(
        assessHarnessVersion("1.0.100", POLICY).status,
        HARNESS_VERSION_STATUSES.SUPPORTED
      );
      assert.strictEqual(
        assessHarnessVersion("1.0.9", POLICY).status,
        HARNESS_VERSION_STATUSES.UNSUPPORTED
      );
    });

    test("treats the minimum as supported and the recommended as current", () => {
      assert.strictEqual(
        assessHarnessVersion("1.0.19", POLICY).status,
        HARNESS_VERSION_STATUSES.OUTDATED
      );
      assert.strictEqual(
        assessHarnessVersion("1.0.92", POLICY).status,
        HARNESS_VERSION_STATUSES.SUPPORTED
      );
    });

    test("reports unparseable or missing output as unknown", () => {
      for (const raw of [undefined, "", "no digits here"]) {
        const assessment = assessHarnessVersion(raw, POLICY);
        assert.strictEqual(assessment.status, HARNESS_VERSION_STATUSES.UNKNOWN);
        assert.strictEqual(assessment.installedVersion, undefined);
      }
    });
  });

  suite("formatHarnessVersionGuidance", () => {
    test("names the update command for unsupported and outdated versions only", () => {
      assert.strictEqual(
        formatHarnessVersionGuidance(
          "Copilot",
          assessHarnessVersion("1.0.10", POLICY)
        ),
        "Copilot 1.0.10 is older than the minimum supported version 1.0.19. Update with: copilot update"
      );
      assert.strictEqual(
        formatHarnessVersionGuidance(
          "Copilot",
          assessHarnessVersion("1.0.50", POLICY)
        ),
        "Copilot 1.0.50 is older than the recommended version 1.0.92; some features may not work. Update with: copilot update"
      );
      assert.strictEqual(
        formatHarnessVersionGuidance(
          "Copilot",
          assessHarnessVersion("1.0.92", POLICY)
        ),
        undefined
      );
      assert.strictEqual(
        formatHarnessVersionGuidance(
          "Copilot",
          assessHarnessVersion(undefined, POLICY)
        ),
        undefined
      );
    });
  });

  suite("versionSatisfies", () => {
    test("evaluates the range forms capability declarations use", () => {
      assert.strictEqual(versionSatisfies("2.1.17", ">=2.1.17"), true);
      assert.strictEqual(versionSatisfies("2.1.16", ">=2.1.17"), false);
      assert.strictEqual(versionSatisfies("1.4.2", "^1.2.0"), true);
      assert.strictEqual(versionSatisfies("2.0.0", "^1.2.0"), false);
      assert.strictEqual(versionSatisfies("0.3.9", "<0.2.0 || >=0.3.0"), true);
      assert.strictEqual(versionSatisfies("nonsense", "*"), false);
    });
  });

  suite("detectHarness", () => {
    const provider = (installed: boolean, version: string | undefined) => ({
      config: IntegrationFactory.createCapabilityProvider(
        HARNESS_IDS.COPILOT_CLI
      ).config,
      checkAvailability: async () => installed,
      getVersion: async () => version,
    });

    test("is unavailable without a version when the CLI is not installed", async () => {
      assert.deepStrictEqual(await detectHarness(provider(false, "1.0.92")), {
        available: false,
      });
    });

    test("is unavailable below the minimum but still reports the version", async () => {
      const result = await detectHarness(provider(true, "0.0.400"));
      assert.strictEqual(result.available, false);
      assert.strictEqual(
        result.version?.status,
        HARNESS_VERSION_STATUSES.UNSUPPORTED
      );
    });

    test("stays available when the version cannot be read", async () => {
      const result = await detectHarness(provider(true, undefined));
      assert.strictEqual(result.available, true);
      assert.strictEqual(
        result.version?.status,
        HARNESS_VERSION_STATUSES.UNKNOWN
      );
    });
  });

  suite("shipped harness policies", () => {
    for (const harnessId of Object.values(HARNESS_IDS) as HarnessId[]) {
      test(`${harnessId} declares a well-formed version window`, () => {
        const { versionPolicy } =
          IntegrationFactory.createCapabilityProvider(harnessId).config;
        assert.match(versionPolicy.minimum, /^\d+\.\d+\.\d+$/);
        assert.match(versionPolicy.recommended, /^\d+\.\d+\.\d+$/);
        assert.ok(
          versionSatisfies(
            versionPolicy.recommended,
            `>=${versionPolicy.minimum}`
          ),
          "recommended must not be older than minimum"
        );
        assert.ok(versionPolicy.updateCommand.trim().length > 0);
      });
    }
  });
});
