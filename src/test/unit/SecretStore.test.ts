import * as assert from "assert";
import { suite, test } from "mocha";
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
    assert.strictEqual(isManagedSecretStorageKey(userSecretKey("API_KEY")), true);
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
