import * as assert from "assert";
import { suite, test } from "mocha";
import {
  OsCredentialStore,
  SecretStoreUnavailableError,
} from "../../platform/OsCredentialStore";

/** `CRED_MAX_CREDENTIAL_BLOB_SIZE`, the limit this suite exists to prove. */
const WINDOWS_MAX_BLOB_BYTES = 2560;
const WINDOWS_CHUNK_LENGTH = WINDOWS_MAX_BLOB_BYTES / 2;

interface FakeCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Stands in for `powershell.exe` running the CredMan script, decoding the same
 * `-EncodedCommand` payload production builds so the encoding path is covered
 * too. It enforces the real blob ceiling, which is the whole point: a fake that
 * accepts any size would have passed against the bug this suite guards.
 */
class FakeWindowsCredentialVault {
  readonly credentials = new Map<string, string>();
  commandCount = 0;
  failWriteFor: string | undefined;

  run = (
    command: string,
    args: readonly string[],
    input?: string
  ): Promise<FakeCommandResult> => {
    this.commandCount += 1;
    assert.strictEqual(command, "powershell.exe");
    const { operation, target, script } = decodeScript(args);
    assert.match(
      script,
      /UTF8\.GetString\(\[Convert\]::FromBase64String\(\$valueBase64\)\)/
    );
    assert.match(
      script,
      /ToBase64String\(\$utf8\)/,
      "get should return a base64-encoded UTF-8 value"
    );

    if (operation === "get") {
      const value = this.credentials.get(target);
      return value === undefined
        ? result(44)
        : result(0, Buffer.from(value, "utf8").toString("base64"));
    }

    if (operation === "store") {
      const value = Buffer.from(input ?? "", "base64").toString("utf8");
      const blobBytes = Buffer.byteLength(value, "utf16le");
      if (blobBytes > WINDOWS_MAX_BLOB_BYTES || target === this.failWriteFor) {
        return result(
          45,
          "",
          `CredWrite failed with Win32 error 1783 for a ${blobBytes}-byte blob.`
        );
      }
      this.credentials.set(target, value);
      return result(0);
    }

    if (operation === "delete") {
      return this.credentials.delete(target) ? result(0) : result(44);
    }

    throw new Error(`Unexpected credential operation: ${operation}`);
  };

  /** Targets holding a real secret, ignoring the store's own key index. */
  secretTargets(): string[] {
    return [...this.credentials.keys()]
      .filter((target) => !target.startsWith("ctrlyoke.ctrlyoke.secret.index"))
      .sort();
  }
}

function decodeScript(args: readonly string[]): {
  operation: string;
  target: string;
  script: string;
} {
  const encoded = args[args.indexOf("-EncodedCommand") + 1];
  const script = Buffer.from(encoded, "base64").toString("utf16le");
  const values = [...script.matchAll(/FromBase64String\('([^']*)'\)/g)].map(
    (match) => Buffer.from(match[1], "base64").toString("utf8")
  );
  assert.strictEqual(values.length, 2, "script should embed operation+target");
  return { operation: values[0], target: values[1], script };
}

function result(
  exitCode: number,
  stdout = "",
  stderr = ""
): Promise<FakeCommandResult> {
  return Promise.resolve({ exitCode, stdout, stderr });
}

function createWindowsStore(): {
  store: OsCredentialStore;
  vault: FakeWindowsCredentialVault;
} {
  const vault = new FakeWindowsCredentialVault();
  return {
    store: new OsCredentialStore({ platform: "win32", runCommand: vault.run }),
    vault,
  };
}

function textOfLength(length: number): string {
  return Array.from({ length }, (_unused, index) =>
    String.fromCharCode(33 + (index % 90))
  ).join("");
}

suite("OsCredentialStore", () => {
  test("round-trips a value that fits in a single credential blob", async () => {
    const { store, vault } = createWindowsStore();
    const value = textOfLength(WINDOWS_CHUNK_LENGTH);

    await store.store("ctrlyoke.pro.license-key", value);

    assert.strictEqual(await store.get("ctrlyoke.pro.license-key"), value);
    // A value that fits must stay one plain credential, so credentials written
    // before chunking existed keep reading back unchanged.
    assert.deepStrictEqual(vault.secretTargets(), [
      "ctrlyoke.ctrlyoke.pro.license-key",
    ]);
  });

  test("transports non-ASCII and non-BMP values as UTF-8 base64", async () => {
    const { store } = createWindowsStore();
    const value = "license-€-秘密-🚀-𐐷";

    await store.store("ctrlyoke.secret.user.API_KEY", value);

    assert.strictEqual(
      await store.get("ctrlyoke.secret.user.API_KEY"),
      value
    );
  });

  test("reads existing ASCII credentials through the base64 get path", async () => {
    const { store, vault } = createWindowsStore();
    // Existing values are UTF-16 CredMan blobs; their ASCII text is unchanged
    // when the new script decodes and re-encodes it as UTF-8.
    vault.credentials.set("ctrlyoke.ctrlyoke.pro.license-key", "old-ascii-key");

    assert.strictEqual(
      await store.get("ctrlyoke.pro.license-key"),
      "old-ascii-key"
    );
  });

  test("round-trips a value far larger than one credential blob", async () => {
    const { store, vault } = createWindowsStore();
    // A signed Keygen license file is multiple KB; CredWrite rejects anything
    // past 2560 bytes, which silently broke Pro activation on Windows.
    const value = textOfLength(WINDOWS_CHUNK_LENGTH * 3 + 17);

    await store.store("ctrlyoke.pro.license-file", value);

    assert.strictEqual(await store.get("ctrlyoke.pro.license-file"), value);
    assert.deepStrictEqual(vault.secretTargets(), [
      "ctrlyoke.ctrlyoke.pro.license-file",
      "ctrlyoke.ctrlyoke.pro.license-file#1",
      "ctrlyoke.ctrlyoke.pro.license-file#2",
      "ctrlyoke.ctrlyoke.pro.license-file#3",
      "ctrlyoke.ctrlyoke.pro.license-file#count",
    ]);
  });

  test("keeps a value intact across a chunk boundary that splits a surrogate pair", async () => {
    const { store } = createWindowsStore();
    // Land an astral character exactly on the boundary: .NET's UTF-16 encoder
    // would replace a lone surrogate with U+FFFD and corrupt the join.
    const value = `${textOfLength(WINDOWS_CHUNK_LENGTH - 1)}\u{1F680}${textOfLength(10)}`;

    await store.store("ctrlyoke.secret.user.API_KEY", value);

    assert.strictEqual(await store.get("ctrlyoke.secret.user.API_KEY"), value);
  });

  test("removes orphaned chunks when a value shrinks", async () => {
    const { store, vault } = createWindowsStore();
    await store.store(
      "ctrlyoke.pro.license-file",
      textOfLength(WINDOWS_CHUNK_LENGTH * 3)
    );

    await store.store("ctrlyoke.pro.license-file", "short");

    assert.strictEqual(await store.get("ctrlyoke.pro.license-file"), "short");
    assert.deepStrictEqual(vault.secretTargets(), [
      "ctrlyoke.ctrlyoke.pro.license-file",
    ]);
  });

  test("deletes every chunk and the chunk count", async () => {
    const { store, vault } = createWindowsStore();
    await store.store(
      "ctrlyoke.pro.license-file",
      textOfLength(WINDOWS_CHUNK_LENGTH * 2 + 5)
    );

    await store.delete("ctrlyoke.pro.license-file");

    assert.strictEqual(await store.get("ctrlyoke.pro.license-file"), undefined);
    assert.deepStrictEqual(vault.secretTargets(), []);
  });

  test("reads a single credential without paying for a chunk-count lookup", async () => {
    const { store, vault } = createWindowsStore();
    await store.store("ctrlyoke.pro.license-source", "online");
    vault.commandCount = 0;

    assert.strictEqual(
      await store.get("ctrlyoke.pro.license-source"),
      "online"
    );
    assert.strictEqual(vault.commandCount, 1);
  });

  test("fails loudly when a chunked value is missing a chunk", async () => {
    const { store, vault } = createWindowsStore();
    await store.store(
      "ctrlyoke.pro.license-file",
      textOfLength(WINDOWS_CHUNK_LENGTH * 2)
    );
    vault.credentials.delete("ctrlyoke.ctrlyoke.pro.license-file#1");

    await assert.rejects(
      store.get("ctrlyoke.pro.license-file"),
      /claims 2 chunks but chunk 1 is missing/
    );
  });

  test("fails a later read loudly when a chunked write dies partway", async () => {
    const { store, vault } = createWindowsStore();
    vault.failWriteFor = "ctrlyoke.ctrlyoke.pro.license-file#2";

    await assert.rejects(
      store.store(
        "ctrlyoke.pro.license-file",
        textOfLength(WINDOWS_CHUNK_LENGTH * 3)
      )
    );

    // The count lands before the chunks precisely so the half-written value
    // reads as broken rather than as a complete but truncated one.
    vault.failWriteFor = undefined;
    await assert.rejects(
      store.get("ctrlyoke.pro.license-file"),
      /claims 3 chunks but chunk 2 is missing/
    );
  });

  test("surfaces the CredMan failure detail on a rejected write", async () => {
    const { store, vault } = createWindowsStore();
    vault.failWriteFor = "ctrlyoke.ctrlyoke.pro.license-file";

    await assert.rejects(
      store.store("ctrlyoke.pro.license-file", "value"),
      /CredWrite failed with Win32 error 1783/
    );
  });

  test("tracks stored keys in its index without exposing chunk targets", async () => {
    const { store } = createWindowsStore();
    await store.store("ctrlyoke.pro.license-key", "key");
    await store.store(
      "ctrlyoke.pro.license-file",
      textOfLength(WINDOWS_CHUNK_LENGTH * 2)
    );

    assert.deepStrictEqual(await store.keys(), [
      "ctrlyoke.pro.license-file",
      "ctrlyoke.pro.license-key",
    ]);
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
