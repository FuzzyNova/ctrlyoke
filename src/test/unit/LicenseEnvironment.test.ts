import * as assert from "assert";
import { suite, test } from "mocha";
import {
  applyEnvironmentLicenseKey,
  LICENSE_KEY_ENV,
  LICENSE_KEY_FILE_ENV,
  takeEnvironmentLicenseKey,
} from "../../license/LicenseEnvironment";
import {
  LICENSE_TIERS,
  type Entitlement,
  type LicenseService,
} from "../../license/LicenseService";

/** Activation stores the key, as `LicenseService.activateWithKey` does. */
class FakeLicenseService implements Pick<
  LicenseService,
  "getStoredLicenseKey" | "activateWithKey"
> {
  storedKey: string | undefined;
  readonly activations: string[] = [];

  async getStoredLicenseKey(): Promise<string | undefined> {
    return this.storedKey;
  }

  async activateWithKey(key: string): Promise<Entitlement> {
    this.activations.push(key);
    this.storedKey = key;
    return { tier: LICENSE_TIERS.PRO, features: new Set(), expiresAt: null };
  }
}

suite("LicenseEnvironment", () => {
  test("a key file activates once and is a no-op on the next start", async () => {
    const service = new FakeLicenseService();
    const readFile = async (): Promise<string> => "  KEY-FROM-FILE\n";

    for (let start = 0; start < 2; start++) {
      const environment = { [LICENSE_KEY_FILE_ENV]: "/run/secrets/license" };
      const provided = await takeEnvironmentLicenseKey(environment, readFile);
      assert.ok(provided);
      assert.deepStrictEqual(provided, {
        key: "KEY-FROM-FILE",
        source: LICENSE_KEY_FILE_ENV,
      });
      await applyEnvironmentLicenseKey(service, provided.key);
    }

    assert.deepStrictEqual(service.activations, ["KEY-FROM-FILE"]);
  });

  test("a changed key activates again", async () => {
    const service = new FakeLicenseService();
    service.storedKey = "OLD-KEY";

    assert.strictEqual(
      await applyEnvironmentLicenseKey(service, "NEW-KEY"),
      true
    );
    assert.deepStrictEqual(service.activations, ["NEW-KEY"]);
  });

  test("removes the bare key from the environment", async () => {
    const environment: NodeJS.ProcessEnv = { [LICENSE_KEY_ENV]: " KEY " };

    const provided = await takeEnvironmentLicenseKey(environment);

    assert.deepStrictEqual(provided, { key: "KEY", source: LICENSE_KEY_ENV });
    assert.strictEqual(LICENSE_KEY_ENV in environment, false);
  });

  test("prefers the key file and still removes the bare key", async () => {
    const environment: NodeJS.ProcessEnv = {
      [LICENSE_KEY_ENV]: "INLINE",
      [LICENSE_KEY_FILE_ENV]: "/run/secrets/license",
    };

    const provided = await takeEnvironmentLicenseKey(
      environment,
      async () => "FROM-FILE"
    );

    assert.strictEqual(provided?.key, "FROM-FILE");
    assert.strictEqual(LICENSE_KEY_ENV in environment, false);
  });

  test("returns nothing when neither variable is set", async () => {
    assert.strictEqual(await takeEnvironmentLicenseKey({}), undefined);
  });

  test("names the variable when the key file is missing or empty", async () => {
    await assert.rejects(
      takeEnvironmentLicenseKey(
        { [LICENSE_KEY_FILE_ENV]: "/run/secrets/license" },
        async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
      ),
      new RegExp(`${LICENSE_KEY_FILE_ENV}.*/run/secrets/license`)
    );
    await assert.rejects(
      takeEnvironmentLicenseKey(
        { [LICENSE_KEY_FILE_ENV]: "/run/secrets/license" },
        async () => "\n"
      ),
      /is empty/
    );
  });
});
