import * as assert from "assert";
import { createHash, webcrypto } from "node:crypto";
import { suite, setup, test } from "mocha";
import type { SecretStore } from "../../platform/SecretStore";
import {
  KEYGEN_ACCOUNT_PUBLIC_KEY_HEX,
  KEYGEN_API_BASE_URL,
  KEYGEN_PRODUCT_ID,
  KEYGEN_PRO_POLICY_ID,
  LICENSE_FILE_SECRET_KEY,
  LICENSE_ID_SECRET_KEY,
  LICENSE_KEY_SECRET_KEY,
  LICENSE_MACHINE_FINGERPRINT_SECRET_KEY,
  LICENSE_MACHINE_ID_SECRET_KEY,
  LICENSE_FILE_TTL_MS,
  LICENSE_SOURCES,
  LICENSE_SOURCE_SECRET_KEY,
  REMOTE_ACCESS_TRIAL_START_KEY,
  type LicenseTrialStateStore,
  LicenseService,
} from "../../license/LicenseService";
import { PRO_FEATURES } from "../../types/DashboardConstants";

class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>();

  get(key: string): Thenable<string | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  store(key: string, value: string): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Thenable<void> {
    this.values.delete(key);
    return Promise.resolve();
  }

  keys(): Thenable<string[]> {
    return Promise.resolve([...this.values.keys()]);
  }
}

class InMemoryTrialState implements LicenseTrialStateStore {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const KEYGEN_API_PATH = new URL(KEYGEN_API_BASE_URL).pathname;

let signingKey: CryptoKey;
let verificationKeyHex: string;

suite("LicenseService", () => {
  setup(async () => {
    const keyPair = (await webcrypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    )) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
    signingKey = keyPair.privateKey;
    verificationKeyHex = Buffer.from(
      await webcrypto.subtle.exportKey("raw", keyPair.publicKey)
    ).toString("hex");
  });

  test("verifies a valid signed license file", async () => {
    const secrets = new InMemorySecretStore();
    await cache(secrets, await createLicenseFile());

    const service = createService(secrets);
    const entitlement = await service.getEntitlement();

    assert.strictEqual(entitlement.tier, "pro");
    assert.strictEqual(entitlement.licenseId, "license-123");
    assert.strictEqual(entitlement.source, LICENSE_SOURCES.ONLINE);
    assert.ok(entitlement.features.has(PRO_FEATURES.HOSTED_DASHBOARD));
    assert.strictEqual(await service.isPro(), true);
  });

  test("starts the 14-day remote-access trial on its first check", async () => {
    const secrets = new InMemorySecretStore();
    const trialState = new InMemoryTrialState();
    const service = createService(secrets, { trialState });

    assert.strictEqual(await service.hasRemoteAccess(), true);
    assert.strictEqual(
      trialState.get<number>(REMOTE_ACCESS_TRIAL_START_KEY),
      NOW
    );
  });

  test("expires remote access after the trial while preserving the free tier", async () => {
    const secrets = new InMemorySecretStore();
    const trialState = new InMemoryTrialState();
    await trialState.update(REMOTE_ACCESS_TRIAL_START_KEY, NOW - 14 * DAY);
    const service = createService(secrets, { trialState });

    assert.strictEqual(await service.hasRemoteAccess(), false);
    assert.strictEqual((await service.getEntitlement()).tier, "free");
  });

  test("lets an activated Pro license supersede a lapsed trial", async () => {
    const secrets = new InMemorySecretStore();
    const trialState = new InMemoryTrialState();
    await trialState.update(REMOTE_ACCESS_TRIAL_START_KEY, NOW - 14 * DAY);
    await cache(secrets, await createLicenseFile());
    const service = createService(secrets, { trialState });

    assert.strictEqual(await service.hasRemoteAccess(), true);
    assert.strictEqual(await service.isPro(), true);
  });

  test("imports a valid offline license file without making network calls", async () => {
    const secrets = new InMemorySecretStore();
    const file = await createLicenseFile();
    let networkCalls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      networkCalls += 1;
      return new Response(null, { status: 500 });
    };
    const service = createService(secrets, { fetch });

    const entitlement = await service.importLicenseFile(`  ${file}\n`);

    assert.strictEqual(entitlement.tier, "pro");
    assert.strictEqual(entitlement.source, LICENSE_SOURCES.OFFLINE_FILE);
    assert.ok(entitlement.features.has(PRO_FEATURES.HOSTED_DASHBOARD));
    assert.strictEqual(await secrets.get(LICENSE_FILE_SECRET_KEY), file);
    assert.strictEqual(
      await secrets.get(LICENSE_SOURCE_SECRET_KEY),
      LICENSE_SOURCES.OFFLINE_FILE
    );
    assert.strictEqual(await service.isPro(), true);
    assert.strictEqual(networkCalls, 0);
  });

  test("rejects an offline license file with a corrupted signature", async () => {
    const secrets = new InMemorySecretStore();
    const validFile = await createLicenseFile();
    await cache(secrets, validFile);
    const envelope = decodeCertificate(validFile);
    const signature = Buffer.from(envelope.sig, "base64");
    signature[0] ^= 0xff;
    envelope.sig = signature.toString("base64");
    const service = createService(secrets);

    const entitlement = await service.importLicenseFile(
      encodeCertificate(envelope)
    );

    assert.strictEqual(entitlement.tier, "pro");
    assert.strictEqual(entitlement.source, LICENSE_SOURCES.ONLINE);
    assert.strictEqual(await secrets.get(LICENSE_FILE_SECRET_KEY), validFile);
  });

  test("rejects an offline license file signed by a foreign key", async () => {
    const secrets = new InMemorySecretStore();
    const foreignKeyPair = (await webcrypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    )) as unknown as { privateKey: CryptoKey; publicKey: CryptoKey };
    const file = await createLicenseFile(
      {},
      undefined,
      false,
      foreignKeyPair.privateKey
    );
    const service = createService(secrets);

    const entitlement = await service.importLicenseFile(file);

    assert.strictEqual(entitlement.tier, "free");
    assert.strictEqual(await secrets.get(LICENSE_FILE_SECRET_KEY), undefined);
  });

  test("fails open for malformed offline license data", async () => {
    const secrets = new InMemorySecretStore();
    const service = createService(secrets);

    const entitlement = await service.importLicenseFile("not a license file");

    assert.strictEqual(entitlement.tier, "free");
    assert.strictEqual(entitlement.features.size, 0);
    assert.strictEqual(await secrets.get(LICENSE_FILE_SECRET_KEY), undefined);
  });

  test("rejects a license file with a flipped signed byte", async () => {
    const secrets = new InMemorySecretStore();
    const file = await createLicenseFile();
    const envelope = decodeCertificate(file);
    const encodedContent = Buffer.from(envelope.enc, "base64");
    encodedContent[0] ^= 0xff;
    envelope.enc = encodedContent.toString("base64");
    await cache(secrets, encodeCertificate(envelope));

    const entitlement = await createService(secrets).getEntitlement();

    assert.strictEqual(entitlement.tier, "free");
    assert.strictEqual(entitlement.features.size, 0);
  });

  test("rejects an online file after its TTL and offline grace window", async () => {
    const secrets = new InMemorySecretStore();
    await cache(
      secrets,
      await createLicenseFile({
        issued: NOW - 46 * DAY,
        expiry: NOW - 16 * DAY,
      })
    );

    const entitlement = await createService(secrets).getEntitlement();

    assert.strictEqual(entitlement.tier, "free");
  });

  test("does not apply the online TTL to an offline-file entitlement", async () => {
    const secrets = new InMemorySecretStore();
    await cache(
      secrets,
      await createLicenseFile({
        issued: NOW - 366 * DAY,
        expiry: NOW - 300 * DAY,
      }),
      LICENSE_SOURCES.OFFLINE_FILE
    );

    const entitlement = await createService(secrets).getEntitlement();

    assert.strictEqual(entitlement.tier, "pro");
    assert.strictEqual(entitlement.source, LICENSE_SOURCES.OFFLINE_FILE);
  });

  test("decrypts an AES-256-GCM license file after signature verification", async () => {
    const secrets = new InMemorySecretStore();
    const licenseKey = "test-license-key";
    await secrets.store(LICENSE_KEY_SECRET_KEY, licenseKey);
    await cache(secrets, await createLicenseFile({}, licenseKey, true));

    const entitlement = await createService(secrets).getEntitlement();

    assert.strictEqual(entitlement.tier, "pro");
    assert.strictEqual(entitlement.licenseId, "license-123");
  });

  test("fails open to the free tier for corrupt cache data", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.store(LICENSE_FILE_SECRET_KEY, "not a license file");

    const entitlement = await createService(secrets).getEntitlement();

    assert.strictEqual(entitlement.tier, "free");
    assert.strictEqual(entitlement.features.size, 0);
  });

  test("notifies listeners when the cached license is deactivated", async () => {
    const secrets = new InMemorySecretStore();
    await cache(secrets, await createLicenseFile());
    const service = createService(secrets);
    const changes: string[] = [];
    service.onDidChangeEntitlement((entitlement) =>
      changes.push(entitlement.tier)
    );

    await service.deactivate();

    assert.deepStrictEqual(changes, ["free"]);
    assert.strictEqual(await service.isPro(), false);
  });

  test("ships the configured Keygen public key", () => {
    assert.strictEqual(KEYGEN_ACCOUNT_PUBLIC_KEY_HEX.length, 64);
  });

  // Manual live verification (2026-08-28): read a key from the ignored
  // dev/test_keys.md file into process memory, call activateWithKey() with the
  // real Keygen API, verify getEntitlement() returns Pro, then deactivate().
  // Never copy either live key into source, fixtures, logs, or commits.
  test("activates a key, registers this machine, and caches the signed file", async () => {
    const secrets = new InMemorySecretStore();
    const file = await createLicenseFile();
    const calls: RequestCall[] = [];
    const fetch = createKeygenFetch(calls, {
      validate: new Response(
        JSON.stringify({
          meta: { valid: false, code: "NO_MACHINES" },
          data: {
            id: "license-123",
            relationships: {
              product: { data: { id: KEYGEN_PRODUCT_ID } },
              policy: { data: { id: KEYGEN_PRO_POLICY_ID } },
            },
          },
        }),
        { status: 200 }
      ),
      machine: new Response(JSON.stringify({ data: { id: "machine-123" } }), {
        status: 201,
      }),
      checkout: new Response(file, { status: 200 }),
    });

    const service = createService(secrets, {
      fetch,
      machineFingerprint: "fingerprint-123",
    });
    const entitlement = await service.activateWithKey("  live-key  ");

    assert.strictEqual(entitlement.tier, "pro");
    assert.strictEqual(await secrets.get(LICENSE_KEY_SECRET_KEY), "live-key");
    assert.strictEqual(await secrets.get(LICENSE_FILE_SECRET_KEY), file);
    assert.strictEqual(
      await secrets.get(LICENSE_MACHINE_ID_SECRET_KEY),
      "machine-123"
    );
    assert.ok(await secrets.get(LICENSE_MACHINE_FINGERPRINT_SECRET_KEY));
    assert.deepStrictEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        `POST ${KEYGEN_API_PATH}/licenses/actions/validate-key`,
        `POST ${KEYGEN_API_PATH}/machines`,
        `GET ${KEYGEN_API_PATH}/licenses/license-123/actions/check-out?ttl=` +
          LICENSE_FILE_TTL_MS / 1000,
      ]
    );
    assert.strictEqual(calls[1].headers.authorization, "License live-key");
    assert.strictEqual(
      JSON.parse(calls[1].body ?? "{}").data.attributes.fingerprint,
      "fingerprint-123"
    );
  });

  test("rejects an invalid key without changing the free entitlement", async () => {
    const secrets = new InMemorySecretStore();
    const calls: RequestCall[] = [];
    const fetch = createKeygenFetch(calls, {
      validate: new Response(
        JSON.stringify({
          meta: { valid: false, code: "NOT_FOUND" },
        }),
        { status: 200 }
      ),
    });
    const service = createService(secrets, { fetch });

    await assert.rejects(
      service.activateWithKey("bad-key"),
      /license key was rejected/
    );
    assert.strictEqual((await service.getEntitlement()).tier, "free");
    assert.strictEqual(await secrets.get(LICENSE_FILE_SECRET_KEY), undefined);
    assert.strictEqual(calls.length, 1);
  });

  test("refreshes an online cache inside the seven-day lead window", async () => {
    const secrets = new InMemorySecretStore();
    const oldFile = await createLicenseFile({ issued: NOW - 25 * DAY });
    const freshFile = await createLicenseFile({ issued: NOW });
    await cache(secrets, oldFile);
    await secrets.store(LICENSE_KEY_SECRET_KEY, "live-key");
    const calls: RequestCall[] = [];
    const fetch = createKeygenFetch(calls, {
      checkout: new Response(freshFile, { status: 200 }),
    });

    await createService(secrets, { fetch }).refresh();

    assert.strictEqual(await secrets.get(LICENSE_FILE_SECRET_KEY), freshFile);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.includes("ttl=" + LICENSE_FILE_TTL_MS / 1000));
  });

  test("does not refresh before the cache is near its TTL or after grace", async () => {
    const secrets = new InMemorySecretStore();
    await cache(secrets, await createLicenseFile({ issued: NOW - 20 * DAY }));
    await secrets.store(LICENSE_KEY_SECRET_KEY, "live-key");
    const calls: RequestCall[] = [];
    const fetch = createKeygenFetch(calls, {});
    const service = createService(secrets, { fetch });

    await service.refresh();
    assert.strictEqual(calls.length, 0);

    await cache(
      secrets,
      await createLicenseFile({ issued: NOW - 45 * DAY, expiry: NOW + DAY })
    );
    await service.refresh();
    assert.strictEqual(calls.length, 0);
  });

  test("deactivates the Keygen machine and clears local license secrets", async () => {
    const secrets = new InMemorySecretStore();
    const file = await createLicenseFile();
    await cache(secrets, file);
    await secrets.store(LICENSE_KEY_SECRET_KEY, "live-key");
    await secrets.store(LICENSE_ID_SECRET_KEY, "license-123");
    await secrets.store(LICENSE_MACHINE_ID_SECRET_KEY, "machine-123");
    const calls: RequestCall[] = [];
    const fetch = createKeygenFetch(calls, {
      deactivate: new Response(null, { status: 204 }),
    });

    await createService(secrets, { fetch }).deactivate();

    assert.strictEqual(calls[0].method, "DELETE");
    assert.strictEqual(calls[0].url, `${KEYGEN_API_PATH}/machines/machine-123`);
    assert.strictEqual(calls[0].headers.authorization, "License live-key");
    assert.strictEqual(await secrets.get(LICENSE_FILE_SECRET_KEY), undefined);
    assert.strictEqual(await secrets.get(LICENSE_KEY_SECRET_KEY), undefined);
    assert.strictEqual(await secrets.get(LICENSE_ID_SECRET_KEY), undefined);
    assert.strictEqual(
      await secrets.get(LICENSE_MACHINE_ID_SECRET_KEY),
      undefined
    );
  });
});

interface RequestCall {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

interface FetchResponses {
  readonly validate?: Response;
  readonly machine?: Response;
  readonly checkout?: Response;
  readonly deactivate?: Response;
}

function createKeygenFetch(
  calls: RequestCall[],
  responses: FetchResponses
): typeof fetch {
  return async (input, init = {}) => {
    const parsed = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = Object.fromEntries(
      new Headers(init.headers).entries()
    ) as Record<string, string>;
    calls.push({
      method,
      url: parsed.pathname + parsed.search,
      headers,
      ...(typeof init.body === "string" ? { body: init.body } : {}),
    });

    if (parsed.pathname.endsWith("/licenses/actions/validate-key")) {
      return responses.validate ?? new Response(null, { status: 500 });
    }
    if (parsed.pathname.endsWith("/machines") && method === "POST") {
      return responses.machine ?? new Response(null, { status: 500 });
    }
    if (parsed.pathname.includes("/actions/check-out")) {
      return responses.checkout ?? new Response(null, { status: 500 });
    }
    if (parsed.pathname.includes("/machines/") && method === "DELETE") {
      return responses.deactivate ?? new Response(null, { status: 500 });
    }
    return new Response(null, { status: 404 });
  };
}

function createService(
  secrets: InMemorySecretStore,
  options: {
    readonly fetch?: typeof fetch;
    readonly machineFingerprint?: string | (() => Promise<string>);
    readonly trialState?: LicenseTrialStateStore;
  } = {}
): LicenseService {
  return new LicenseService(secrets, {
    now: () => NOW,
    publicKeyHex: verificationKeyHex,
    ...options,
  });
}

async function cache(
  secrets: InMemorySecretStore,
  file: string,
  source: (typeof LICENSE_SOURCES)[keyof typeof LICENSE_SOURCES] = LICENSE_SOURCES.ONLINE
): Promise<void> {
  await secrets.store(LICENSE_FILE_SECRET_KEY, file);
  await secrets.store(LICENSE_SOURCE_SECRET_KEY, source);
}

async function createLicenseFile(
  overrides: { issued?: number; expiry?: number } = {},
  licenseKey?: string,
  encrypted = false,
  signer: CryptoKey = signingKey
): Promise<string> {
  const issued = overrides.issued ?? NOW - DAY;
  const expiry = overrides.expiry ?? NOW + 29 * DAY;
  const payload = {
    meta: {
      issued: new Date(issued).toISOString(),
      expiry: new Date(expiry).toISOString(),
    },
    data: {
      type: "licenses",
      id: "license-123",
      attributes: { tier: "pro" },
    },
  };

  let enc: string;
  let alg: string;
  if (encrypted) {
    if (!licenseKey) {
      throw new Error("A license key is required for encrypted test data");
    }
    const secret = createHash("sha256").update(licenseKey, "utf8").digest();
    const key = await webcrypto.subtle.importKey(
      "raw",
      secret,
      { name: "AES-GCM" },
      false,
      ["encrypt"]
    );
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const encryptedPayload = new Uint8Array(
      await webcrypto.subtle.encrypt(
        { name: "AES-GCM", iv, tagLength: 128 },
        key,
        new TextEncoder().encode(JSON.stringify(payload))
      )
    );
    const ciphertext = encryptedPayload.slice(0, -16);
    const authTag = encryptedPayload.slice(-16);
    enc = [ciphertext, iv, authTag]
      .map((part) => Buffer.from(part).toString("base64"))
      .join(".");
    alg = "aes-256-gcm+ed25519";
  } else {
    enc = Buffer.from(JSON.stringify(payload)).toString("base64");
    alg = "base64+ed25519";
  }

  const signature = await webcrypto.subtle.sign(
    { name: "Ed25519" },
    signer,
    new TextEncoder().encode(`license/${enc}`)
  );
  return encodeCertificate({
    enc,
    sig: Buffer.from(signature).toString("base64"),
    alg,
  });
}

function decodeCertificate(file: string): {
  enc: string;
  sig: string;
  alg: string;
} {
  const body = file
    .replace("-----BEGIN LICENSE FILE-----\n", "")
    .replace("\n-----END LICENSE FILE-----", "");
  return JSON.parse(
    Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8")
  ) as { enc: string; sig: string; alg: string };
}

function encodeCertificate(envelope: {
  enc: string;
  sig: string;
  alg: string;
}): string {
  return [
    "-----BEGIN LICENSE FILE-----",
    Buffer.from(JSON.stringify(envelope)).toString("base64"),
    "-----END LICENSE FILE-----",
  ].join("\n");
}
