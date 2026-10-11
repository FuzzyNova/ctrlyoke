import * as assert from "assert";
import { suite, test } from "mocha";
import { FallbackSecretStore } from "../../platform/FallbackSecretStore";
import { migrateManagedSecrets } from "../../platform/ManagedSecretMigration";
import { SecretStoreUnavailableError, type SecretStore } from "../../platform/SecretStore";
import {
  userSecretKey,
  userSecretMetadataKey,
  workspaceSecretKeyForRoot,
} from "../../platform/SecretKey";
import { CliAdapter } from "../../platform/CliAdapter";
import { VsCodeAdapter } from "../../platform/VsCodeAdapter";
import { EXECUTION_MODES } from "../../types/DashboardConstants";

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.values.keys()]);
  }
}

class UnavailableSecretStore implements SecretStore {
  get(): Promise<string | undefined> {
    return Promise.reject(new SecretStoreUnavailableError("linux"));
  }

  store(): Promise<void> {
    return Promise.reject(new SecretStoreUnavailableError("linux"));
  }

  delete(): Promise<void> {
    return Promise.reject(new SecretStoreUnavailableError("linux"));
  }

  keys(): Promise<string[]> {
    return Promise.reject(new SecretStoreUnavailableError("linux"));
  }
}

suite("ManagedSecretMigration", () => {
  test("moves managed values and metadata while preserving unrelated profile entries", async () => {
    const profile = new MemorySecretStore();
    const osStore = new MemorySecretStore();
    await profile.store(userSecretKey("API_KEY"), "secret-value");
    await profile.store(userSecretMetadataKey("API_KEY"), '{"lastUpdated":1}');
    await profile.store("ctrlyoke.license", "license-value");
    await profile.store("ctrlyoke.server.token.workspace", "server-token");
    const target = new FallbackSecretStore(osStore, profile);

    const result = await migrateManagedSecrets(profile, target);

    assert.deepStrictEqual(result, { migrated: 2, failed: 0, skipped: false });
    assert.strictEqual(await osStore.get(userSecretKey("API_KEY")), "secret-value");
    assert.strictEqual(
      await osStore.get(userSecretMetadataKey("API_KEY")),
      '{"lastUpdated":1}'
    );
    assert.strictEqual(await profile.get(userSecretKey("API_KEY")), undefined);
    assert.strictEqual(await profile.get(userSecretMetadataKey("API_KEY")), undefined);
    assert.strictEqual(await profile.get("ctrlyoke.license"), "license-value");
    assert.strictEqual(
      await profile.get("ctrlyoke.server.token.workspace"),
      "server-token"
    );
  });

  test("is idempotent", async () => {
    const profile = new MemorySecretStore();
    const osStore = new MemorySecretStore();
    await profile.store(userSecretKey("API_KEY"), "secret-value");
    const target = new FallbackSecretStore(osStore, profile);

    const first = await migrateManagedSecrets(profile, target);
    const second = await migrateManagedSecrets(profile, target);

    assert.strictEqual(first.migrated, 1);
    assert.strictEqual(second.migrated, 0);
    assert.strictEqual(await osStore.get(userSecretKey("API_KEY")), "secret-value");
  });

  test("keeps entries in profile storage when the OS store is unavailable", async () => {
    const profile = new MemorySecretStore();
    await profile.store(userSecretKey("API_KEY"), "secret-value");
    const target = new FallbackSecretStore(new UnavailableSecretStore(), profile);

    const result = await migrateManagedSecrets(profile, target);

    assert.deepStrictEqual(result, { migrated: 0, failed: 0, skipped: true });
    assert.strictEqual(await profile.get(userSecretKey("API_KEY")), "secret-value");
    assert.strictEqual(target.isUsingFallback, true);
  });

  test("uses matching managed keys from the extension adapter and CLI adapter", async () => {
    const sharedValues = new Map<string, string>();
    const createSharedStore = (): SecretStore => ({
      get: (key) => Promise.resolve(sharedValues.get(key)),
      store: (key, value) => {
        sharedValues.set(key, value);
        return Promise.resolve();
      },
      delete: (key) => {
        sharedValues.delete(key);
        return Promise.resolve();
      },
      keys: () => Promise.resolve([...sharedValues.keys()]),
    });
    const extensionStore = new FallbackSecretStore(
      createSharedStore(),
      new MemorySecretStore()
    );
    const extension = new VsCodeAdapter(
      { extensionPath: "" } as never,
      extensionStore
    );
    const cli = new CliAdapter(
      {
        cwd: "C:/workspace",
        verbose: false,
        quiet: false,
        json: false,
        vars: {},
        cliExecutionMode: EXECUTION_MODES.HEADLESS,
      },
      createSharedStore()
    );
    const keys = [
      userSecretKey("API_KEY"),
      workspaceSecretKeyForRoot("C:/workspace", "API_KEY"),
    ];

    for (const key of keys) {
      await extension.getSecretStore().store(key, `shared:${key}`);
      assert.strictEqual(
        await cli.getSecretStore().get(key),
        `shared:${key}`
      );
    }
  });
});
