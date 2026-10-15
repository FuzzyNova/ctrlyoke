import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { OsCredentialStore } from "../../platform/OsCredentialStore";
import {
  isValidSecretName,
  isManagedSecretStorageKey,
  userSecretKey,
  validateSecretName,
  workspaceSecretHash,
  workspaceSecretKey,
  workspaceSecretKeyForRoot,
} from "../../platform/SecretKey";

suite("SecretStore", () => {
  test("serializes concurrent OS credential index updates", async () => {
    const credentials = new Map<string, string>();
    const lockDirectory = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-secret-store-")
    );
    try {
      await assertConcurrentIndexUpdates(credentials, lockDirectory);
    } finally {
      await fs.rm(lockDirectory, { recursive: true, force: true });
    }
  });

  async function assertConcurrentIndexUpdates(
    credentials: Map<string, string>,
    lockDirectory: string
  ): Promise<void> {
    const store = new OsCredentialStore({
      platform: "linux",
      indexLockTarget: path.join(lockDirectory, "secret-index"),
      runCommand: async (_command, args, input) => {
        const operation = args[0];
        const key = args[args.length - 1];
        if (operation === "lookup") {
          await new Promise((resolve) => setTimeout(resolve, 10));
          const value = credentials.get(key);
          return {
            exitCode: value === undefined ? 1 : 0,
            stdout: value ?? "",
            stderr: "",
          };
        }
        if (operation === "store") {
          credentials.set(key, input ?? "");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        if (operation === "clear") {
          credentials.delete(key);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: "unexpected operation" };
      },
    });

    await Promise.all([
      store.store("ctrlyoke.secret.user.FIRST", "first"),
      store.store("ctrlyoke.secret.user.SECOND", "second"),
      store.store("ctrlyoke.secret.user.THIRD", "third"),
    ]);

    assert.deepStrictEqual(await store.keys(), [
      "ctrlyoke.secret.user.FIRST",
      "ctrlyoke.secret.user.SECOND",
      "ctrlyoke.secret.user.THIRD",
    ]);
  }

  test("builds distinct user and workspace-scoped keys", () => {
    assert.strictEqual(
      userSecretKey("API_KEY"),
      "ctrlyoke.secret.user.API_KEY"
    );
    assert.strictEqual(
      workspaceSecretKey("0123456789AB", "API_KEY"),
      "ctrlyoke.secret.ws.0123456789ab.API_KEY"
    );
    assert.strictEqual(
      workspaceSecretKeyForRoot("C:/work/example", "API_KEY"),
      `ctrlyoke.secret.ws.${workspaceSecretHash("C:/work/example")}.API_KEY`
    );
  });

  test("recognizes only managed secret and metadata keys for migration", () => {
    assert.strictEqual(
      isManagedSecretStorageKey(userSecretKey("API_KEY")),
      true
    );
    assert.strictEqual(
      isManagedSecretStorageKey("ctrlyoke.secret.ws.0123456789ab.API_KEY"),
      true
    );
    assert.strictEqual(
      isManagedSecretStorageKey("ctrlyoke.secret.meta.user.API_KEY"),
      true
    );
    assert.strictEqual(isManagedSecretStorageKey("ctrlyoke.license"), false);
    assert.strictEqual(
      isManagedSecretStorageKey("ctrlyoke.server.token.0123456789ab"),
      false
    );
    assert.strictEqual(
      isManagedSecretStorageKey("ctrlyoke.secret.user.api_key"),
      false
    );
  });

  test("accepts uppercase environment names and rejects other forms", () => {
    for (const name of ["A", "API_KEY", "A1_2", "Z9"]) {
      assert.strictEqual(isValidSecretName(name), true, name);
      assert.doesNotThrow(() => validateSecretName(name));
    }

    for (const name of [
      "",
      "api_key",
      "1API_KEY",
      "API-KEY",
      "API.KEY",
      "API$",
    ]) {
      assert.strictEqual(isValidSecretName(name), false, name);
      assert.throws(() => validateSecretName(name), /Invalid secret name/);
    }
  });
});
