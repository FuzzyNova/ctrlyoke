import * as assert from "assert";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { FileSecretStore } from "../../platform/FileSecretStore";
import { createNodeSecretStore } from "../../platform/NodeSecretStore";
import { OsCredentialStore } from "../../platform/OsCredentialStore";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

/** `secret-tool` in a container: no D-Bus session bus to talk to. */
function createKeyringlessStore(tempDir: string): OsCredentialStore {
  return new OsCredentialStore({
    platform: "linux",
    indexLockTarget: path.join(tempDir, "secret-index"),
    runCommand: async () => ({
      exitCode: 1,
      stdout: "",
      stderr:
        "secret-tool: Cannot autolaunch a dbus-daemon without a $DISPLAY for X11",
    }),
  });
}

suite("NodeSecretStore", () => {
  let tempDir: string;
  let filePath: string;

  setup(() => {
    tempDir = makeTempDir("ctrlyoke-node-secrets-");
    filePath = path.join(tempDir, "secrets.json");
  });

  teardown(() => {
    removeTempDir(tempDir);
  });

  test("routes to the secret file when secret-tool has no D-Bus session", async () => {
    const warnings: string[] = [];
    const store = createNodeSecretStore({
      primary: createKeyringlessStore(tempDir),
      fallback: new FileSecretStore({ filePath }),
      warn: (message) => warnings.push(message),
    });

    await store.store("ctrlyoke.license.key", "LICENSE-KEY");

    assert.strictEqual(store.isUsingFallback, true);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].includes(filePath), warnings[0]);
    assert.match(warnings[0], /unencrypted/);

    // A restarted server builds a fresh store and finds the value again.
    const restarted = createNodeSecretStore({
      primary: createKeyringlessStore(tempDir),
      fallback: new FileSecretStore({ filePath }),
      warn: () => undefined,
    });
    assert.strictEqual(
      await restarted.get("ctrlyoke.license.key"),
      "LICENSE-KEY"
    );
  });

  test("keeps using the OS credential store when it works", async () => {
    const values = new Map<string, string>();
    const primary = new OsCredentialStore({
      platform: "linux",
      indexLockTarget: path.join(tempDir, "secret-index"),
      runCommand: async (_command, args, input) => {
        const account = args[args.length - 1];
        if (args[0] === "store") {
          values.set(account, input ?? "");
          return { exitCode: 0, stdout: "", stderr: "" };
        }
        const value = values.get(account);
        return value === undefined
          ? { exitCode: 1, stdout: "", stderr: "" }
          : { exitCode: 0, stdout: value, stderr: "" };
      },
    });
    const store = createNodeSecretStore({
      primary,
      fallback: new FileSecretStore({ filePath }),
    });

    await store.store("key", "value");

    assert.strictEqual(store.isUsingFallback, false);
    assert.strictEqual(values.get("key"), "value");
    assert.deepStrictEqual(await new FileSecretStore({ filePath }).keys(), []);
  });
});
