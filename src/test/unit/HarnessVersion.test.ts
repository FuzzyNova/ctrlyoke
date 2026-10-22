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
  testedWith: "1.0.92",
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
        HARNESS_VERSION_STATUSES.BELOW_MINIMUM
      );
    });

    test("treats the minimum itself and anything above it as supported, however far below the tested version", () => {
      assert.strictEqual(
        assessHarnessVersion("1.0.19", POLICY).status,
        HARNESS_VERSION_STATUSES.SUPPORTED
      );
      assert.strictEqual(
        assessHarnessVersion("1.0.50", POLICY).status,
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
    test("warns with the update command only for versions below the minimum", () => {
      assert.strictEqual(
        formatHarnessVersionGuidance(
          "Copilot",
          assessHarnessVersion("1.0.10", POLICY)
        ),
        "Copilot 1.0.10 is older than the minimum supported version 1.0.19 and may not work correctly. Update with: copilot update"
      );
      for (const version of ["1.0.19", "1.0.50", "1.0.92", undefined]) {
        assert.strictEqual(
          formatHarnessVersionGuidance(
            "Copilot",
            assessHarnessVersion(version, POLICY)
          ),
          undefined,
          `no guidance for ${version}`
        );
      }
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

    test("stays available below the minimum and still reports the version", async () => {
      const result = await detectHarness(provider(true, "0.0.400"));
      assert.strictEqual(result.available, true);
      assert.strictEqual(
        result.version?.status,
        HARNESS_VERSION_STATUSES.BELOW_MINIMUM
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
        assert.match(versionPolicy.testedWith, /^\d+\.\d+\.\d+$/);
        assert.ok(
          versionSatisfies(
            versionPolicy.testedWith,
            `>=${versionPolicy.minimum}`
          ),
          "testedWith must not be older than minimum"
        );
        assert.ok(versionPolicy.updateCommand.trim().length > 0);
      });

      test(`${harnessId} has evidence covering its minimum for every feature`, () => {
        const provider = IntegrationFactory.createCapabilityProvider(harnessId);
        const { minimum } = provider.config.versionPolicy;
        const uncovered = collectVerifiedRanges(provider.capabilities)
          .filter(
            ({ ranges }) =>
              !ranges.some((range) => versionSatisfies(minimum, range))
          )
          .map(({ path }) => path)
          .filter(
            (path) => !FEATURES_NEWER_THAN_MINIMUM[harnessId]?.includes(path)
          );
        // A floor above the minimum raises "unverified" warnings for CLIs the
        // version policy calls supported. Lower the floor once the feature is
        // checked at the minimum, raise the minimum, or (only for a feature
        // that genuinely needs a newer CLI) list it below.
        assert.deepStrictEqual(uncovered, []);
      });
    }
  });
});

/**
 * Features whose evidence legitimately starts above the harness minimum. Keep
 * this short: every entry warns users the version policy calls supported.
 */
const FEATURES_NEWER_THAN_MINIMUM: Partial<Record<HarnessId, string[]>> = {
  // Only 1.4.4 has been tested; the agy changelog implies the agent could
  // view PNG/JPEG by about 1.2.15. Test at the minimum, then remove this.
  [HARNESS_IDS.ANTIGRAVITY_CLI]: ["promptInputs.images"],
};

function collectVerifiedRanges(
  node: unknown,
  path = ""
): { path: string; ranges: readonly string[] }[] {
  if (!node || typeof node !== "object") {
    return [];
  }
  const verification = (node as { verification?: unknown }).verification;
  if (
    verification &&
    typeof verification === "object" &&
    "verifiedVersions" in verification
  ) {
    return [
      {
        path,
        ranges: (verification as { verifiedVersions: readonly string[] })
          .verifiedVersions,
      },
    ];
  }
  return Object.entries(node).flatMap(([key, child]) =>
    collectVerifiedRanges(child, path ? `${path}.${key}` : key)
  );
}
