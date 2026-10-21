import * as assert from "assert";
import { suite, test } from "mocha";
import {
  ISOLATED_SECRETS_ENV,
  isolatedSecretStoreFromEnvironment,
} from "../../dev/IsolatedSecrets";
import { FileSecretStore } from "../../platform/FileSecretStore";

suite("IsolatedSecrets", () => {
  test("uses a file store when the media host asks for isolation", () => {
    const store = isolatedSecretStoreFromEnvironment({
      [ISOLATED_SECRETS_ENV]: "1",
    });
    assert.ok(store instanceof FileSecretStore);
  });

  test("leaves the OS credential store in place otherwise", () => {
    assert.strictEqual(isolatedSecretStoreFromEnvironment({}), undefined);
    assert.strictEqual(
      isolatedSecretStoreFromEnvironment({ [ISOLATED_SECRETS_ENV]: "0" }),
      undefined
    );
  });
});
