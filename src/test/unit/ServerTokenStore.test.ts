import * as assert from "assert";
import { suite, test } from "mocha";
import * as path from "path";
import {
  resolveServerToken,
  serverTokenSecretKey,
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

const WORKSPACE_ROOT = path.resolve("workspaces", "alpha");
const OTHER_WORKSPACE_ROOT = path.resolve("workspaces", "beta");
const SERVER_TOKEN_SECRET_KEY = serverTokenSecretKey(WORKSPACE_ROOT);

suite("ServerTokenStore", () => {
  test("returns the existing server token without replacing it", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.store(SERVER_TOKEN_SECRET_KEY, "existing-token");
    const store = new ServerTokenStore(
      secrets,
      WORKSPACE_ROOT,
      () => "new-token"
    );

    const token = await store.getOrCreate();

    assert.strictEqual(token, "existing-token");
    assert.strictEqual(
      await secrets.get(SERVER_TOKEN_SECRET_KEY),
      "existing-token"
    );
  });

  test("creates and stores a token when none exists", async () => {
    const secrets = new InMemorySecretStore();
    const store = new ServerTokenStore(
      secrets,
      WORKSPACE_ROOT,
      () => "created-token"
    );

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
    const store = new ServerTokenStore(
      secrets,
      WORKSPACE_ROOT,
      () => "replacement-token"
    );

    const token = await store.regenerate();

    assert.strictEqual(token, "replacement-token");
    assert.strictEqual(
      await secrets.get(SERVER_TOKEN_SECRET_KEY),
      "replacement-token"
    );
  });

  test("regenerating one workspace's token leaves other workspaces' tokens intact", async () => {
    const secrets = new InMemorySecretStore();
    let next = 0;
    const createToken = () => `token-${++next}`;
    const alpha = new ServerTokenStore(secrets, WORKSPACE_ROOT, createToken);
    const beta = new ServerTokenStore(
      secrets,
      OTHER_WORKSPACE_ROOT,
      createToken
    );

    const alphaToken = await alpha.getOrCreate();
    const betaToken = await beta.getOrCreate();
    const regeneratedAlpha = await alpha.regenerate();

    assert.notStrictEqual(alphaToken, betaToken);
    assert.notStrictEqual(regeneratedAlpha, alphaToken);
    assert.strictEqual(await beta.getOrCreate(), betaToken);
  });

  test("uses the same key for path spellings of one workspace", () => {
    assert.strictEqual(
      serverTokenSecretKey(path.join(WORKSPACE_ROOT, "sub", "..")),
      SERVER_TOKEN_SECRET_KEY
    );
    assert.notStrictEqual(
      serverTokenSecretKey(OTHER_WORKSPACE_ROOT),
      SERVER_TOKEN_SECRET_KEY
    );
  });

  test("an environment token wins without creating a persisted token", async () => {
    const secrets = new InMemorySecretStore();
    const store = new ServerTokenStore(
      secrets,
      WORKSPACE_ROOT,
      () => "created"
    );

    assert.strictEqual(
      await resolveServerToken(store, "env-secret"),
      "env-secret"
    );
    assert.deepStrictEqual(await secrets.keys(), []);
    assert.strictEqual(await resolveServerToken(store, undefined), "created");
  });

  test("empty and whitespace-only environment tokens fall back to the persisted token", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.store(SERVER_TOKEN_SECRET_KEY, "persisted-token");
    const store = new ServerTokenStore(secrets, WORKSPACE_ROOT);

    assert.strictEqual(await resolveServerToken(store, ""), "persisted-token");
    assert.strictEqual(
      await resolveServerToken(store, "   "),
      "persisted-token"
    );
  });

  test("regenerate rotates the persisted token even under an environment token", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.store(SERVER_TOKEN_SECRET_KEY, "old-token");
    const store = new ServerTokenStore(
      secrets,
      WORKSPACE_ROOT,
      () => "rotated"
    );

    assert.strictEqual(
      await resolveServerToken(store, "env-secret", true),
      "env-secret"
    );
    assert.strictEqual(await secrets.get(SERVER_TOKEN_SECRET_KEY), "rotated");
    assert.strictEqual(
      await resolveServerToken(store, undefined, true),
      "rotated"
    );
  });
});
