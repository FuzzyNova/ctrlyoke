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
  failReadFor: { target: string; exitCode: number } | undefined;
  /** Yield a macrotask per command, as a real subprocess would. */
  yieldPerCommand = false;
  /** Runs before each read, standing in for another process's writes. */
  beforeRead: ((target: string) => void) | undefined;

  run = async (
    command: string,
    args: readonly string[],
    input?: string
  ): Promise<FakeCommandResult> => {
    this.commandCount += 1;
    if (this.yieldPerCommand) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
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
      this.beforeRead?.(target);
      if (target === this.failReadFor?.target) {
        return result(
          this.failReadFor.exitCode,
          "",
          "CredRead failed with Win32 error 5."
        );
      }
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
    store: new OsCredentialStore({
      platform: "win32",
      runCommand: vault.run,
      indexReadRetryDelaysMs: [1, 1, 1],
    }),
    vault,
  };
}

/**
 * A store whose key index spans several credential blobs, as a machine with a
 * server token per opened workspace eventually has.
 */
async function createStoreWithChunkedIndex(): Promise<{
  store: OsCredentialStore;
  vault: FakeWindowsCredentialVault;
  existingKeys: string[];
}> {
  const { store, vault } = createWindowsStore();
  const existingKeys = Array.from(
    { length: 60 },
    (_unused, index) => `ctrlyoke.server.token.workspace-${index}`
  );
  for (const key of existingKeys) {
    await store.store(key, "token");
  }
  assert.ok(vault.credentials.has("ctrlyoke.ctrlyoke.secret.index#count"));
  return { store, vault, existingKeys };
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

    assert.strictEqual(await store.get("ctrlyoke.secret.user.API_KEY"), value);
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

  test("reads chunked credentials with a legacy bare chunk count", async () => {
    const { store, vault } = createWindowsStore();
    const key = "ctrlyoke.pro.license-file";
    const value = textOfLength(WINDOWS_CHUNK_LENGTH * 2 + 17);
    vault.credentials.set(
      `ctrlyoke.${key}`,
      value.slice(0, WINDOWS_CHUNK_LENGTH)
    );
    vault.credentials.set(
      `ctrlyoke.${key}#1`,
      value.slice(WINDOWS_CHUNK_LENGTH, WINDOWS_CHUNK_LENGTH * 2)
    );
    vault.credentials.set(
      `ctrlyoke.${key}#2`,
      value.slice(WINDOWS_CHUNK_LENGTH * 2)
    );
    vault.credentials.set(`ctrlyoke.${key}#count`, "3");

    assert.strictEqual(await store.get(key), value);
  });

  test("rejects a same-size overwrite that fails partway through", async () => {
    const { store, vault } = createWindowsStore();
    const key = "ctrlyoke.pro.license-file";
    await store.store(key, "A".repeat(WINDOWS_CHUNK_LENGTH * 3));
    vault.failWriteFor = `ctrlyoke.${key}#1`;

    await assert.rejects(
      store.store(key, "B".repeat(WINDOWS_CHUNK_LENGTH * 3)),
      /CredWrite failed/
    );

    vault.failWriteFor = undefined;
    await assert.rejects(
      store.get(key),
      /integrity check.*Re-store the secret/
    );
  });

  test("rejects a failed shrink before removing the old chunk count", async () => {
    const { store, vault } = createWindowsStore();
    const key = "ctrlyoke.pro.license-file";
    await store.store(key, "A".repeat(WINDOWS_CHUNK_LENGTH * 3));
    vault.failWriteFor = `ctrlyoke.${key}`;

    await assert.rejects(store.store(key, "short"), /CredWrite failed/);

    vault.failWriteFor = undefined;
    await assert.rejects(
      store.get(key),
      /integrity check.*Re-store the secret/
    );
  });

  test("round-trips a successful chunked overwrite", async () => {
    const { store } = createWindowsStore();
    const key = "ctrlyoke.pro.license-file";
    const original = "A".repeat(WINDOWS_CHUNK_LENGTH * 3);
    const replacement = "B".repeat(WINDOWS_CHUNK_LENGTH * 3);
    await store.store(key, original);

    await store.store(key, replacement);

    assert.strictEqual(await store.get(key), replacement);
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

  test("never reads a chunked index while this process is rewriting it", async () => {
    const { store, vault, existingKeys } = await createStoreWithChunkedIndex();
    vault.yieldPerCommand = true;

    let storing = true;
    const pending = store
      .store("ctrlyoke.server.token.new-workspace", "token")
      .finally(() => {
        storing = false;
      });
    const reads: Promise<string[]>[] = [];
    while (storing) {
      reads.push(store.keys());
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await pending;

    assert.ok(reads.length > 1, "reads should overlap the rewrite");
    for (const keys of await Promise.all(reads)) {
      assert.ok(existingKeys.every((key) => keys.includes(key)));
    }
  });

  test("retries an index read torn by another process's rewrite", async () => {
    const { store, vault } = await createStoreWithChunkedIndex();
    const countTarget = "ctrlyoke.ctrlyoke.secret.index#count";
    const settledCount = vault.credentials.get(countTarget)!;
    // Another process has written its new tag but not yet its chunks.
    vault.credentials.set(countTarget, settledCount.replace(/:.*/, ":stale"));
    let indexReads = 0;
    vault.beforeRead = (target) => {
      if (target === "ctrlyoke.ctrlyoke.secret.index" && ++indexReads === 2) {
        vault.credentials.set(countTarget, settledCount);
      }
    };

    assert.strictEqual((await store.keys()).length, 60);
    assert.strictEqual(indexReads, 2);
  });

  test("surfaces an index tear that outlasts every retry", async () => {
    const { store, vault } = await createStoreWithChunkedIndex();
    const countTarget = "ctrlyoke.ctrlyoke.secret.index#count";
    vault.credentials.set(
      countTarget,
      vault.credentials.get(countTarget)!.replace(/:.*/, ":stale")
    );
    let indexReads = 0;
    vault.beforeRead = (target) => {
      if (target === "ctrlyoke.ctrlyoke.secret.index") indexReads++;
    };

    await assert.rejects(store.keys(), /integrity check/);
    assert.strictEqual(indexReads, 4);
  });

  for (const exitCode of [45, 1]) {
    test(`rejects a chunk-count read failure with exit ${exitCode}`, async () => {
      const { store, vault } = createWindowsStore();
      const key = "ctrlyoke.pro.license-file";
      vault.credentials.set(
        `ctrlyoke.${key}`,
        "x".repeat(WINDOWS_CHUNK_LENGTH)
      );
      vault.failReadFor = { target: `ctrlyoke.${key}#count`, exitCode };

      await assert.rejects(
        store.get(key),
        /CredMan credential-store command failed/
      );
    });

    test(`rejects an index read failure with exit ${exitCode} without changing the index`, async () => {
      const { store, vault } = createWindowsStore();
      const indexTarget = "ctrlyoke.ctrlyoke.secret.index";
      vault.credentials.set(indexTarget, '["existing"]');
      vault.failReadFor = { target: indexTarget, exitCode };
      const originalIndex = vault.credentials.get(indexTarget);

      await assert.rejects(
        store.keys(),
        /CredMan credential-store command failed/
      );
      await assert.rejects(
        store.store("other", "y"),
        /CredMan credential-store command failed/
      );
      assert.strictEqual(vault.credentials.get(indexTarget), originalIndex);
    });
  }

  test("rejects a corrupt index instead of replacing it during store", async () => {
    const { store, vault } = createWindowsStore();
    const indexTarget = "ctrlyoke.ctrlyoke.secret.index";
    vault.credentials.set(indexTarget, "not-json");

    await assert.rejects(
      store.keys(),
      /Could not read credential-store key index/
    );
    await assert.rejects(
      store.store("other", "y"),
      /Could not read credential-store key index/
    );
    assert.strictEqual(vault.credentials.get(indexTarget), "not-json");
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

  test("classifies D-Bus failure while reading the key index", async () => {
    const store = new OsCredentialStore({
      platform: "linux",
      runCommand: async () => ({
        exitCode: 1,
        stdout: "",
        stderr:
          "secret-tool: Error spawning command line ‘dbus-launch --autolaunch=abc’: Child process exited with code 1",
      }),
    });

    await assert.rejects(
      store.keys(),
      (error: unknown) => error instanceof SecretStoreUnavailableError
    );
  });

  test("treats an empty secret-tool lookup miss as not found", async () => {
    const store = new OsCredentialStore({
      platform: "linux",
      runCommand: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    });

    assert.strictEqual(await store.get("missing"), undefined);
  });

  test("classifies a locked macOS keychain", async () => {
    const store = new OsCredentialStore({
      platform: "darwin",
      runCommand: async () => ({
        exitCode: 1,
        stdout: "",
        stderr:
          "security: SecKeychainSearchCopyNext: User interaction is not allowed.",
      }),
    });

    await assert.rejects(
      store.get("license"),
      (error: unknown) => error instanceof SecretStoreUnavailableError
    );
  });
});
