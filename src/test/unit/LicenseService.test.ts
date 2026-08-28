import * as assert from "assert";
import { createHash, webcrypto } from "node:crypto";
import { suite, setup, test } from "mocha";
import type { SecretStore } from "../../platform/SecretStore";
import {
  KEYGEN_ACCOUNT_PUBLIC_KEY_HEX,
  LICENSE_FILE_SECRET_KEY,
  LICENSE_KEY_SECRET_KEY,
  LICENSE_SOURCES,
  LICENSE_SOURCE_SECRET_KEY,
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

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

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
});

function createService(secrets: InMemorySecretStore): LicenseService {
  return new LicenseService(secrets, {
    now: () => NOW,
    publicKeyHex: verificationKeyHex,
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
  encrypted = false
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
    signingKey,
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
