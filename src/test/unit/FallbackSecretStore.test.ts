import * as assert from "assert";
import { suite, test } from "mocha";
import { FallbackSecretStore } from "../../platform/FallbackSecretStore";
import {
  SecretStoreUnavailableError,
  type SecretStore,
} from "../../platform/SecretStore";

class InMemorySecretStore implements SecretStore {
  callCount = 0;
  private readonly values = new Map<string, string>();

  get(key: string): Thenable<string | undefined> {
    this.callCount++;
    return Promise.resolve(this.values.get(key));
  }

  store(key: string, value: string): Thenable<void> {
    this.callCount++;
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Thenable<void> {
    this.callCount++;
    this.values.delete(key);
    return Promise.resolve();
  }

  keys(): Thenable<string[]> {
    this.callCount++;
    return Promise.resolve([...this.values.keys()]);
  }
}

class UnavailableSecretStore implements SecretStore {
  probeCount = 0;

  get(): Thenable<string | undefined> {
    return Promise.reject(new SecretStoreUnavailableError("linux"));
  }

  store(): Thenable<void> {
    return Promise.reject(new SecretStoreUnavailableError("linux"));
  }

  delete(): Thenable<void> {
    return Promise.reject(new SecretStoreUnavailableError("linux"));
  }

  keys(): Thenable<string[]> {
    this.probeCount++;
    return Promise.reject(new SecretStoreUnavailableError("linux"));
  }
}

class BrokenSecretStore implements SecretStore {
  get(): Thenable<string | undefined> {
    return Promise.reject(new Error("boom"));
  }

  store(): Thenable<void> {
    return Promise.reject(new Error("boom"));
  }

  delete(): Thenable<void> {
    return Promise.reject(new Error("boom"));
  }

  keys(): Thenable<string[]> {
    return Promise.reject(new Error("boom"));
  }
}

suite("FallbackSecretStore", () => {
  test("uses the primary store when it is available", async () => {
    const primary = new InMemorySecretStore();
    const fallback = new InMemorySecretStore();
    const store = new FallbackSecretStore(primary, fallback);

    await store.store("key", "value");
    assert.strictEqual(await store.get("key"), "value");
    assert.strictEqual(fallback.callCount, 0);
  });

  test("falls back and notifies once when the primary is unavailable", async () => {
    const primary = new UnavailableSecretStore();
    const fallback = new InMemorySecretStore();
    const fallbackErrors: SecretStoreUnavailableError[] = [];
    const store = new FallbackSecretStore(primary, fallback, (error) =>
      fallbackErrors.push(error)
    );

    await store.store("key", "value");
    assert.strictEqual(await store.get("key"), "value");
    await store.keys();
    await store.delete("key");

    assert.strictEqual(fallback.callCount, 4);
    assert.strictEqual(fallbackErrors.length, 1);
    assert.strictEqual(primary.probeCount, 1);
  });

  test("memoizes the probe across concurrent first calls", async () => {
    const primary = new UnavailableSecretStore();
    const fallback = new InMemorySecretStore();
    const store = new FallbackSecretStore(primary, fallback);

    await Promise.all([store.get("a"), store.get("b"), store.store("c", "1")]);

    assert.strictEqual(primary.probeCount, 1);
  });

  test("propagates errors that are not SecretStoreUnavailableError", async () => {
    const primary = new BrokenSecretStore();
    const fallback = new InMemorySecretStore();
    const store = new FallbackSecretStore(primary, fallback);

    await assert.rejects(store.get("key"), /boom/);
    assert.strictEqual(fallback.callCount, 0);
  });
});
