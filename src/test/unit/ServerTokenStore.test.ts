import * as assert from "assert";
import { suite, test } from "mocha";
import {
  SERVER_TOKEN_SECRET_KEY,
  ServerTokenStore,
} from "../../platform/ServerTokenStore";
import type { SecretStore } from "../../platform/SecretStore";

class InMemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async keys(): Promise<string[]> {
    return [...this.values.keys()];
  }
}

suite("ServerTokenStore", () => {
  test("returns the existing server token without replacing it", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.store(SERVER_TOKEN_SECRET_KEY, "existing-token");
    const store = new ServerTokenStore(secrets, () => "new-token");

    const token = await store.getOrCreate();

    assert.strictEqual(token, "existing-token");
    assert.strictEqual(
      await secrets.get(SERVER_TOKEN_SECRET_KEY),
      "existing-token"
    );
  });

  test("creates and stores a token when none exists", async () => {
    const secrets = new InMemorySecretStore();
    const store = new ServerTokenStore(secrets, () => "created-token");

    const token = await store.getOrCreate();

    assert.strictEqual(token, "created-token");
    assert.strictEqual(
      await secrets.get(SERVER_TOKEN_SECRET_KEY),
      "created-token"
    );
  });

  test("regenerate stores the replacement token immediately", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.store(SERVER_TOKEN_SECRET_KEY, "old-token");
    const store = new ServerTokenStore(secrets, () => "replacement-token");

    const token = await store.regenerate();

    assert.strictEqual(token, "replacement-token");
    assert.strictEqual(
      await secrets.get(SERVER_TOKEN_SECRET_KEY),
      "replacement-token"
    );
  });
});
