import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { setup, suite, teardown, test } from "mocha";
import { FileSecretStore } from "../../platform/FileSecretStore";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

const checksModes = process.platform !== "win32";

suite("FileSecretStore", () => {
  let tempDir: string;
  let filePath: string;

  setup(() => {
    tempDir = makeTempDir("ctrlyoke-file-secrets-");
    filePath = path.join(tempDir, "state", "secrets.json");
  });

  teardown(() => {
    removeTempDir(tempDir);
  });

  test("round-trips values across instances and lists sorted keys", async () => {
    const store = new FileSecretStore({ filePath });
    assert.deepStrictEqual(await store.keys(), []);
    assert.strictEqual(await store.get("missing"), undefined);

    await store.store("b.key", "second");
    await store.store("a.key", "first\nwith newline");
    await store.delete("absent");

    const restarted = new FileSecretStore({ filePath });
    assert.deepStrictEqual(await restarted.keys(), ["a.key", "b.key"]);
    assert.strictEqual(await restarted.get("a.key"), "first\nwith newline");

    await restarted.delete("b.key");
    assert.deepStrictEqual(await store.keys(), ["a.key"]);
    assert.strictEqual(await store.get("b.key"), undefined);
  });

  test("does not treat inherited object properties as secrets", async () => {
    const store = new FileSecretStore({ filePath });
    await store.store("real", "value");

    assert.strictEqual(await store.get("toString"), undefined);
    assert.strictEqual(await store.get("__proto__"), undefined);
  });

  test("writes the file 0600 in a 0700 directory and re-applies the mode", async function () {
    if (!checksModes) this.skip();
    const store = new FileSecretStore({ filePath });
    await store.store("key", "value");

    assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);

    fs.chmodSync(filePath, 0o644);
    await store.store("key", "changed");
    assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600);
  });

  test("warns once when the file is readable by other users", async function () {
    if (!checksModes) this.skip();
    const warnings: Array<{ filePath: string; mode: number }> = [];
    const writer = new FileSecretStore({ filePath });
    await writer.store("key", "value");
    fs.chmodSync(filePath, 0o640);

    const store = new FileSecretStore({
      filePath,
      onInsecurePermissions: (warnedPath, mode) =>
        warnings.push({ filePath: warnedPath, mode }),
    });
    assert.strictEqual(await store.get("key"), "value");
    await store.keys();

    assert.deepStrictEqual(warnings, [{ filePath, mode: 0o640 }]);
  });

  test("skips the permission check on Windows", async () => {
    const warnings: string[] = [];
    await new FileSecretStore({ filePath }).store("key", "value");
    fs.chmodSync(filePath, 0o644);

    const store = new FileSecretStore({
      filePath,
      platform: "win32",
      onInsecurePermissions: (warnedPath) => warnings.push(warnedPath),
    });
    await store.get("key");

    assert.deepStrictEqual(warnings, []);
  });

  test("keeps every write from concurrent writers", async () => {
    // Two instances stand in for `ctrlyoke server` and `ctrlyoke secret`:
    // each has its own in-process queue, so only the file lock and the
    // read-modify-write inside it keep their updates from overwriting each
    // other.
    const server = new FileSecretStore({ filePath });
    const cli = new FileSecretStore({ filePath });
    const keys = Array.from({ length: 12 }, (_, index) => `key.${index}`);

    await Promise.all(
      keys.map((key, index) =>
        (index % 2 === 0 ? server : cli).store(key, `value-${index}`)
      )
    );

    assert.deepStrictEqual(await server.keys(), [...keys].sort());
    for (const [index, key] of keys.entries()) {
      assert.strictEqual(await cli.get(key), `value-${index}`);
    }
  });

  test("refuses to read or overwrite a damaged file", async () => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{ not json");
    const store = new FileSecretStore({ filePath });

    await assert.rejects(store.get("key"), /not valid JSON/);
    await assert.rejects(store.store("key", "value"), /not valid JSON/);
    assert.strictEqual(fs.readFileSync(filePath, "utf8"), "{ not json");

    fs.writeFileSync(filePath, JSON.stringify({ key: 42 }));
    await assert.rejects(store.keys(), /JSON object of string values/);
  });
});
