import * as assert from "assert";
import { suite, test } from "mocha";
import { FallbackSecretStore } from "../../platform/FallbackSecretStore";
import { migrateManagedSecrets } from "../../platform/ManagedSecretMigration";
import {
  SecretStoreUnavailableError,
  type SecretStore,
} from "../../platform/SecretStore";
import { userSecretKey, userSecretMetadataKey } from "../../platform/SecretKey";
import { CliAdapter } from "../../platform/CliAdapter";
import { NodeSecretStore } from "../../platform/NodeSecretStore";
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

    assert.deepStrictEqual(result, {
      migrated: 1,
      alreadyPresent: 0,
      conflicts: 0,
      failed: 0,
      skipped: false,
    });
    assert.strictEqual(
      await osStore.get(userSecretKey("API_KEY")),
      "secret-value"
    );
    assert.strictEqual(
      await osStore.get(userSecretMetadataKey("API_KEY")),
      '{"lastUpdated":1}'
    );
    assert.strictEqual(await profile.get(userSecretKey("API_KEY")), undefined);
    assert.strictEqual(
      await profile.get(userSecretMetadataKey("API_KEY")),
      undefined
    );
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
    assert.strictEqual(
      await osStore.get(userSecretKey("API_KEY")),
      "secret-value"
    );
  });

  test("keeps entries in profile storage when the OS store is unavailable", async () => {
    const profile = new MemorySecretStore();
    await profile.store(userSecretKey("API_KEY"), "secret-value");
    const target = new FallbackSecretStore(
      new UnavailableSecretStore(),
      profile
    );

    const result = await migrateManagedSecrets(profile, target);

    assert.deepStrictEqual(result, {
      migrated: 0,
      alreadyPresent: 0,
      conflicts: 0,
      failed: 0,
      skipped: true,
    });
    assert.strictEqual(
      await profile.get(userSecretKey("API_KEY")),
      "secret-value"
    );
    assert.strictEqual(target.isUsingFallback, true);
  });

  test("uses an injected extension store and the CLI's default Node store", () => {
    const extensionStore = new FallbackSecretStore(
      new MemorySecretStore(),
      new MemorySecretStore()
    );
    const extension = new VsCodeAdapter(
      { extensionPath: "" } as never,
      extensionStore
    );
    const cli = new CliAdapter({
      cwd: "C:/workspace",
      verbose: false,
      quiet: false,
      json: false,
      vars: {},
      cliExecutionMode: EXECUTION_MODES.HEADLESS,
    });
    assert.strictEqual(extension.getSecretStore(), extensionStore);
    assert.ok(cli.getSecretStore() instanceof NodeSecretStore);
  });

  test("keeps the newer profile value and its metadata", async () => {
    const profile = new MemorySecretStore();
    const osStore = new MemorySecretStore();
    const key = userSecretKey("API_KEY");
    const metadataKey = userSecretMetadataKey("API_KEY");
    await profile.store(key, "new-profile-value");
    await profile.store(metadataKey, '{"description":"new","lastUpdated":20}');
    await osStore.store(key, "old-os-value");
    await osStore.store(metadataKey, '{"description":"old","lastUpdated":10}');

    const result = await migrateManagedSecrets(
      profile,
      new FallbackSecretStore(osStore, new MemorySecretStore())
    );

    assert.strictEqual(result.migrated, 1);
    assert.strictEqual(await osStore.get(key), "new-profile-value");
    assert.strictEqual(
      await osStore.get(metadataKey),
      '{"description":"new","lastUpdated":20}'
    );
    assert.strictEqual(await profile.get(key), undefined);
  });

  test("keeps the newer OS value and metadata", async () => {
    const profile = new MemorySecretStore();
    const osStore = new MemorySecretStore();
    const key = userSecretKey("API_KEY");
    const metadataKey = userSecretMetadataKey("API_KEY");
    await profile.store(key, "old-profile-value");
    await profile.store(metadataKey, '{"lastUpdated":10}');
    await osStore.store(key, "new-os-value");
    await osStore.store(metadataKey, '{"description":"new","lastUpdated":20}');

    const result = await migrateManagedSecrets(
      profile,
      new FallbackSecretStore(osStore, new MemorySecretStore())
    );

    assert.strictEqual(result.alreadyPresent, 1);
    assert.strictEqual(result.conflicts, 1);
    assert.strictEqual(await profile.get(key), undefined);
    assert.strictEqual(await osStore.get(key), "new-os-value");
    assert.strictEqual(
      await osStore.get(metadataKey),
      '{"description":"new","lastUpdated":20}'
    );
  });

  test("drops orphaned profile metadata without replacing OS metadata", async () => {
    const profile = new MemorySecretStore();
    const osStore = new MemorySecretStore();
    const key = userSecretKey("API_KEY");
    const metadataKey = userSecretMetadataKey("API_KEY");
    await profile.store(
      metadataKey,
      '{"description":"stale","lastUpdated":30}'
    );
    await osStore.store(key, "os-value");
    await osStore.store(metadataKey, '{"description":"os","lastUpdated":20}');

    const result = await migrateManagedSecrets(
      profile,
      new FallbackSecretStore(osStore, new MemorySecretStore())
    );

    assert.strictEqual(result.migrated, 0);
    assert.strictEqual(await profile.get(metadataKey), undefined);
    assert.strictEqual(await osStore.get(key), "os-value");
    assert.strictEqual(
      await osStore.get(metadataKey),
      '{"description":"os","lastUpdated":20}'
    );
  });

  test("keeps an undecidable profile conflict and warns with the key", async () => {
    const profile = new MemorySecretStore();
    const osStore = new MemorySecretStore();
    const key = userSecretKey("API_KEY");
    await profile.store(key, "profile-value");
    await osStore.store(key, "os-value");
    const warned: string[] = [];

    const result = await migrateManagedSecrets(
      profile,
      new FallbackSecretStore(osStore, new MemorySecretStore()),
      undefined,
      (conflictKey) => warned.push(conflictKey)
    );

    assert.strictEqual(result.conflicts, 1);
    assert.strictEqual(result.alreadyPresent, 0);
    assert.deepStrictEqual(warned, [key]);
    assert.strictEqual(await profile.get(key), "profile-value");
    assert.strictEqual(await osStore.get(key), "os-value");
  });

  test("keeps the source when writing the target fails", async () => {
    const profile = new MemorySecretStore();
    await profile.store(userSecretKey("API_KEY"), "profile-value");
    const targetStore = new MemorySecretStore();
    targetStore.store = () => Promise.reject(new Error("write failed"));
    const errors: string[] = [];

    const result = await migrateManagedSecrets(
      profile,
      new FallbackSecretStore(targetStore, new MemorySecretStore()),
      (key) => errors.push(key ?? "")
    );

    assert.strictEqual(result.failed, 1);
    assert.deepStrictEqual(errors, [userSecretKey("API_KEY")]);
    assert.strictEqual(
      await profile.get(userSecretKey("API_KEY")),
      "profile-value"
    );
  });

  test("reports source key enumeration failures", async () => {
    const profile = new MemorySecretStore();
    profile.keys = () => Promise.reject(new Error("read failed"));
    const result = await migrateManagedSecrets(
      profile,
      new FallbackSecretStore(new MemorySecretStore(), new MemorySecretStore())
    );
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(result.migrated, 0);
  });

  test("stops and keeps remaining profile entries if OS storage fails mid-run", async () => {
    const profile = new MemorySecretStore();
    const osStore = new MemorySecretStore();
    const firstKey = userSecretKey("FIRST_KEY");
    const secondKey = userSecretKey("SECOND_KEY");
    await profile.store(firstKey, "first");
    await profile.store(secondKey, "second");
    let failedSecondRead = false;
    const primary: SecretStore = {
      get: (key) => {
        if (key === secondKey && !failedSecondRead) {
          failedSecondRead = true;
          return Promise.reject(new SecretStoreUnavailableError("linux"));
        }
        return osStore.get(key);
      },
      store: (key, value) => osStore.store(key, value),
      delete: (key) => osStore.delete(key),
      keys: () => osStore.keys(),
    };

    const result = await migrateManagedSecrets(
      profile,
      new FallbackSecretStore(primary, profile)
    );

    assert.strictEqual(result.skipped, true);
    assert.strictEqual(await profile.get(secondKey), "second");
    assert.strictEqual(await profile.get(firstKey), undefined);
  });
});
