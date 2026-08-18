import * as assert from "assert";
import { suite, test } from "mocha";
import {
  isValidSecretName,
  userSecretKey,
  validateSecretName,
  workspaceSecretHash,
  workspaceSecretKey,
  workspaceSecretKeyForRoot,
} from "../../platform/SecretKey";
import {
  OsCredentialStore,
  SecretStoreUnavailableError,
} from "../../platform/OsCredentialStore";

suite("SecretStore", () => {
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

  test("fails with env-passthrough guidance when no OS backend exists", async () => {
    const store = new OsCredentialStore({ platform: "freebsd" });

    await assert.rejects(
      store.get("API_KEY"),
      (error: unknown) =>
        error instanceof SecretStoreUnavailableError &&
        /env passthrough/i.test(error.message)
    );
  });
});
