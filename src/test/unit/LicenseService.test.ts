import * as assert from "assert";
import { createHash, webcrypto } from "node:crypto";
import { suite, setup, test } from "mocha";
import type { SecretStore } from "../../platform/SecretStore";
import {
  KEYGEN_ACCOUNT_PUBLIC_KEY_HEX,
  KEYGEN_API_BASE_URL,
  KEYGEN_PRODUCT_ID,
  KEYGEN_PRO_POLICY_ID,
  KEYGEN_ENTERPRISE_POLICY_ID,
  LICENSE_FILE_SECRET_KEY,
  LICENSE_ID_SECRET_KEY,
  LICENSE_KEY_SECRET_KEY,
  LICENSE_MACHINE_FINGERPRINT_SECRET_KEY,
  LICENSE_MACHINE_ID_SECRET_KEY,
  LICENSE_FILE_TTL_MS,
  LICENSE_REFRESH_INTERVAL_MS,
  LICENSE_REFRESH_RETRY_BASE_MS,
  LICENSE_SOURCES,
  LICENSE_SOURCE_SECRET_KEY,
  ENTITLEMENT_CACHE_TTL_MS,
  REMOTE_ACCESS_TRIAL_START_KEY,
  type LicenseTrialStateStore,
  LicenseActivationLimitError,
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

class CountingSecretStore extends InMemorySecretStore {
  getCalls = 0;

  override get(key: string): Thenable<string | undefined> {
    this.getCalls++;
    return super.get(key);
  }
}

/** Stands in for a credential store that rejects one key's write. */
class RejectingSecretStore extends InMemorySecretStore {
  constructor(
    private readonly rejectedKey: string,
    private readonly reason: string
  ) {
    super();
  }

  override store(key: string, value: string): Thenable<void> {
    return key === this.rejectedKey
      ? Promise.reject(new Error(this.reason))
      : super.store(key, value);
  }
}

class InMemoryTrialState implements LicenseTrialStateStore {
  private readonly values = new Map<string, unknown>();
  updates = 0;

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Thenable<void> {
    this.updates++;
    this.values.set(key, value);
    return Promise.resolve();
  }
}

const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const KEYGEN_API_PATH = new URL(KEYGEN_API_BASE_URL).pathname;

class ManualRefreshTimer {
  private nextId = 1;
  readonly entries = new Map<number, { callback: () => void; delay: number }>();

  setTimeout = ((callback: () => void, delay: number) => {
    const id = this.nextId++;
    const handle = {
      unref: () => undefined,
      id,
    } as unknown as ReturnType<typeof setTimeout>;
    this.entries.set(id, { callback, delay });
    return handle;
  }) as typeof setTimeout;

  clearTimeout = ((handle: ReturnType<typeof setTimeout>) => {
    const id = (handle as unknown as { id: number }).id;
    this.entries.delete(id);
  }) as typeof clearTimeout;

  async fireNext(): Promise<void> {
    const entry = this.entries.entries().next().value as
      [number, { callback: () => void; delay: number }] | undefined;
    assert.ok(entry, "expected a scheduled refresh timer");
    this.entries.delete(entry[0]);
    entry[1].callback();
    // The timer callback intentionally detaches its async refresh. Wait until
    // it schedules the next timer, which proves the attempt has settled.
    for (let index = 0; index < 100 && this.entries.size === 0; index++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.ok(this.entries.size > 0, "refresh did not schedule its next timer");
  }
}

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

  test("trial-state reads never persist a start time", async () => {
    const secrets = new InMemorySecretStore();
    const trialState = new InMemoryTrialState();
    const service = createService(secrets, { trialState });

    assert.strictEqual(await service.canUseRemoteAccess(), true);
    assert.strictEqual(await service.getRemoteAccessTrialEndsAt(), null);
    assert.strictEqual(
      trialState.get<number>(REMOTE_ACCESS_TRIAL_START_KEY),
      undefined
    );
    assert.strictEqual(trialState.updates, 0);
  });

  test("fails closed for remote access when trial state is unavailable", async () => {
    const unwired = createService(new InMemorySecretStore());
    assert.strictEqual(await unwired.canUseRemoteAccess(), false);
    assert.strictEqual(await unwired.beginRemoteAccess(), false);

    const throwing = new InMemoryTrialState();
    throwing.get = () => {
      throw new Error("globalState unavailable");
    };
    const unreadable = createService(new InMemorySecretStore(), {
      trialState: throwing,
    });
    assert.strictEqual(await unreadable.canUseRemoteAccess(), false);
    assert.strictEqual(await unreadable.beginRemoteAccess(), false);
  });

  test("beginRemoteAccess starts the trial once", async () => {
    const secrets = new InMemorySecretStore();
    const trialState = new InMemoryTrialState();
    const service = createService(secrets, { trialState });

    assert.strictEqual(await service.beginRemoteAccess(), true);
    assert.strictEqual(await service.beginRemoteAccess(), true);
    assert.strictEqual(
      trialState.get<number>(REMOTE_ACCESS_TRIAL_START_KEY),
      NOW
    );
    assert.strictEqual(trialState.updates, 1);
  });

  test("expires remote access after the trial while preserving the free tier", async () => {
    const secrets = new InMemorySecretStore();
    const trialState = new InMemoryTrialState();
    await trialState.update(REMOTE_ACCESS_TRIAL_START_KEY, NOW - 14 * DAY);
    const service = createService(secrets, { trialState });

    assert.strictEqual(await service.canUseRemoteAccess(), false);
    assert.strictEqual(await service.beginRemoteAccess(), false);
    assert.strictEqual((await service.getEntitlement()).tier, "free");
  });

  test("exposes the remote-access trial end using the same window as access checks", async () => {
    const secrets = new InMemorySecretStore();
    const trialState = new InMemoryTrialState();
    const startedAt = NOW - DAY;
    await trialState.update(REMOTE_ACCESS_TRIAL_START_KEY, startedAt);
    const service = createService(secrets, { trialState });

    assert.strictEqual(await service.canUseRemoteAccess(), true);
    assert.strictEqual(
      await service.getRemoteAccessTrialEndsAt(),
      startedAt + 14 * DAY
    );
  });

  test("lets an activated Pro license supersede a lapsed trial", async () => {
    const secrets = new InMemorySecretStore();
    const trialState = new InMemoryTrialState();
    await trialState.update(REMOTE_ACCESS_TRIAL_START_KEY, NOW - 14 * DAY);
    await cache(secrets, await createLicenseFile());
    const service = createService(secrets, { trialState });

    assert.strictEqual(await service.canUseRemoteAccess(), true);
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

  test("activates a key issued under the Enterprise policy", async () => {
    const secrets = new InMemorySecretStore();
    const file = await createLicenseFile({
      policyId: KEYGEN_ENTERPRISE_POLICY_ID,
    });
    const calls: RequestCall[] = [];
    const fetch = createKeygenFetch(calls, {
      validate: new Response(
        JSON.stringify({
          meta: { valid: false, code: "NO_MACHINES" },
          data: {
            id: "license-123",
            relationships: {
              product: { data: { id: KEYGEN_PRODUCT_ID } },
              policy: { data: { id: KEYGEN_ENTERPRISE_POLICY_ID } },
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
    const entitlement = await service.activateWithKey("enterprise-key");

    assert.strictEqual(entitlement.tier, "pro");
    assert.strictEqual(entitlement.isEnterprise, true);
  });

  test("does not mark a Pro-policy activation as Enterprise", async () => {
    const secrets = new InMemorySecretStore();
    const file = await createLicenseFile({ policyId: KEYGEN_PRO_POLICY_ID });
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
    const entitlement = await service.activateWithKey("pro-key");

    assert.strictEqual(entitlement.tier, "pro");
    assert.strictEqual(entitlement.isEnterprise, undefined);
  });

  test("rejects a key issued under an unrecognized policy", async () => {
    const secrets = new InMemorySecretStore();
    const calls: RequestCall[] = [];
    const fetch = createKeygenFetch(calls, {
      validate: new Response(
        JSON.stringify({
          meta: { valid: false, code: "NO_MACHINES" },
          data: {
            id: "license-123",
            relationships: {
              product: { data: { id: KEYGEN_PRODUCT_ID } },
              policy: { data: { id: "some-other-policy-id" } },
            },
          },
        }),
        { status: 200 }
      ),
    });
    const service = createService(secrets, { fetch });

    await assert.rejects(
      service.activateWithKey("wrong-policy-key"),
      /different ctrlyoke product or policy/
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

  test("lists machines and flags the locally activated machine", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.store(LICENSE_MACHINE_ID_SECRET_KEY, "machine-2");
    const calls: RequestCall[] = [];
    const fetch = createKeygenFetch(calls, {
      validate: new Response(
        JSON.stringify({
          meta: { valid: true, code: "VALID" },
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
      machines: new Response(
        JSON.stringify({
          data: [
            {
              id: "machine-1",
              type: "machines",
              attributes: {
                name: "Laptop",
                platform: "darwin",
                created: "2026-08-27T12:00:00.000Z",
              },
            },
            {
              id: "machine-2",
              type: "machines",
              attributes: {
                name: "Desktop",
                platform: "win32",
                created: "2026-08-28T12:00:00.000Z",
              },
            },
          ],
        }),
        { status: 200 }
      ),
    });

    const machines = await createService(secrets, { fetch }).listMachines(
      "  live-key  "
    );

    assert.deepStrictEqual(machines, [
      {
        id: "machine-1",
        name: "Laptop",
        platform: "darwin",
        createdAt: "2026-08-27T12:00:00.000Z",
        isThisMachine: false,
      },
      {
        id: "machine-2",
        name: "Desktop",
        platform: "win32",
        createdAt: "2026-08-28T12:00:00.000Z",
        isThisMachine: true,
      },
    ]);
    assert.deepStrictEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        `POST ${KEYGEN_API_PATH}/licenses/actions/validate-key`,
        `GET ${KEYGEN_API_PATH}/machines?license=license-123`,
      ]
    );
    assert.strictEqual(calls[1].headers.authorization, "License live-key");
  });

  test("deactivates another machine without clearing local activation", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.store(LICENSE_FILE_SECRET_KEY, "cached-file");
    await secrets.store(LICENSE_KEY_SECRET_KEY, "live-key");
    await secrets.store(LICENSE_SOURCE_SECRET_KEY, LICENSE_SOURCES.ONLINE);
    await secrets.store(LICENSE_ID_SECRET_KEY, "license-123");
    await secrets.store(LICENSE_MACHINE_ID_SECRET_KEY, "machine-1");
    const calls: RequestCall[] = [];
    const service = createService(secrets, {
      fetch: createKeygenFetch(calls, {
        deactivate: new Response(null, { status: 204 }),
      }),
    });

    await service.deactivateMachine("live-key", "machine-2");

    assert.strictEqual(calls[0].url, `${KEYGEN_API_PATH}/machines/machine-2`);
    assert.strictEqual(
      await secrets.get(LICENSE_FILE_SECRET_KEY),
      "cached-file"
    );
    assert.strictEqual(
      await secrets.get(LICENSE_MACHINE_ID_SECRET_KEY),
      "machine-1"
    );
  });

  test("deactivates this machine and clears local activation", async () => {
    const secrets = new InMemorySecretStore();
    await secrets.store(LICENSE_FILE_SECRET_KEY, "cached-file");
    await secrets.store(LICENSE_KEY_SECRET_KEY, "live-key");
    await secrets.store(LICENSE_SOURCE_SECRET_KEY, LICENSE_SOURCES.ONLINE);
    await secrets.store(LICENSE_ID_SECRET_KEY, "license-123");
    await secrets.store(LICENSE_MACHINE_ID_SECRET_KEY, "machine-1");
    const service = createService(secrets, {
      fetch: createKeygenFetch([], {
        deactivate: new Response(null, { status: 204 }),
      }),
    });

    await service.deactivateMachine("live-key", "machine-1");

    assert.strictEqual(await secrets.get(LICENSE_FILE_SECRET_KEY), undefined);
    assert.strictEqual(await secrets.get(LICENSE_KEY_SECRET_KEY), undefined);
    assert.strictEqual(await secrets.get(LICENSE_SOURCE_SECRET_KEY), undefined);
    assert.strictEqual(await secrets.get(LICENSE_ID_SECRET_KEY), undefined);
    assert.strictEqual(
      await secrets.get(LICENSE_MACHINE_ID_SECRET_KEY),
      undefined
    );
  });

  test("throws a typed error when activation reaches the machine limit", async () => {
    const secrets = new InMemorySecretStore();
    const calls: RequestCall[] = [];
    const fetch = createKeygenFetch(calls, {
      validate: new Response(
        JSON.stringify({
          meta: { valid: false, code: "TOO_MANY_MACHINES" },
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
      machine: new Response(
        JSON.stringify({
          errors: [{ code: "MACHINE_LIMIT_EXCEEDED" }],
        }),
        { status: 422 }
      ),
    });
    const service = createService(secrets, {
      fetch,
      machineFingerprint: "fingerprint-123",
    });

    await assert.rejects(
      service.activateWithKey("live-key"),
      (error: unknown) => {
        return (
          error instanceof LicenseActivationLimitError &&
          error.licenseId === "license-123"
        );
      }
    );
    assert.deepStrictEqual(
      calls.map((call) => `${call.method} ${call.url}`),
      [
        `POST ${KEYGEN_API_PATH}/licenses/actions/validate-key`,
        `POST ${KEYGEN_API_PATH}/machines`,
      ]
    );
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

  test("refreshes on its owned timer when the clock enters the TTL window", async () => {
    const secrets = new InMemorySecretStore();
    const issuedAt = NOW - 20 * DAY;
    await cache(secrets, await createLicenseFile({ issued: issuedAt }));
    await secrets.store(LICENSE_KEY_SECRET_KEY, "live-key");
    const calls: RequestCall[] = [];
    const freshFile = await createLicenseFile({ issued: NOW + 5 * DAY });
    const timer = new ManualRefreshTimer();
    let clock = NOW;
    const service = createService(secrets, {
      fetch: createKeygenFetch(calls, { checkout: new Response(freshFile) }),
      now: () => clock,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    assert.strictEqual(
      [...timer.entries.values()][0].delay,
      LICENSE_REFRESH_INTERVAL_MS
    );
    clock += 5 * DAY;
    await timer.fireNext();

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(await secrets.get(LICENSE_FILE_SECRET_KEY), freshFile);
    assert.strictEqual(
      [...timer.entries.values()][0].delay,
      LICENSE_REFRESH_INTERVAL_MS
    );
    service.dispose();
    assert.strictEqual(timer.entries.size, 0);
  });

  test("retries a failed in-window checkout with the backoff timer", async () => {
    const secrets = new InMemorySecretStore();
    await cache(secrets, await createLicenseFile({ issued: NOW - 25 * DAY }));
    await secrets.store(LICENSE_KEY_SECRET_KEY, "live-key");
    const calls: RequestCall[] = [];
    const freshFile = await createLicenseFile({ issued: NOW });
    let checkoutCount = 0;
    const fetch: typeof globalThis.fetch = async (input, init = {}) => {
      const parsed = new URL(String(input));
      calls.push({
        method: init.method ?? "GET",
        url: parsed.pathname + parsed.search,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
      });
      checkoutCount++;
      return checkoutCount === 1
        ? new Response(null, { status: 503 })
        : new Response(freshFile, { status: 200 });
    };
    const timer = new ManualRefreshTimer();
    const service = createService(secrets, {
      fetch,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    await timer.fireNext();
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(
      [...timer.entries.values()][0].delay,
      LICENSE_REFRESH_RETRY_BASE_MS
    );

    await timer.fireNext();
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(await secrets.get(LICENSE_FILE_SECRET_KEY), freshFile);
    assert.strictEqual(
      [...timer.entries.values()][0].delay,
      LICENSE_REFRESH_INTERVAL_MS
    );
    service.dispose();
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

  test("caches getEntitlement and skips re-reading the store within the TTL", async () => {
    const secrets = new CountingSecretStore();
    await cache(secrets, await createLicenseFile());
    await secrets.store(LICENSE_KEY_SECRET_KEY, "live-key");
    let clock = NOW;
    const service = new LicenseService(secrets, {
      now: () => clock,
      publicKeyHex: verificationKeyHex,
    });

    assert.strictEqual((await service.getEntitlement()).tier, "pro");
    const readsAfterFirst = secrets.getCalls;
    assert.ok(readsAfterFirst > 0);

    assert.strictEqual((await service.getEntitlement()).tier, "pro");
    assert.strictEqual(
      secrets.getCalls,
      readsAfterFirst,
      "a call within the TTL should not re-read the store"
    );

    clock += ENTITLEMENT_CACHE_TTL_MS + 1;
    await service.getEntitlement();
    assert.ok(
      secrets.getCalls > readsAfterFirst,
      "a call after the TTL expires should re-read the store"
    );
  });

  test("blames local storage, not the network, when caching the license fails", async () => {
    // Windows CredMan rejects a blob over 2560 bytes, so a multi-KB signed
    // license file used to fail here and surface as "check your internet
    // connection" — the one message that is certainly wrong at this point.
    const secrets = new RejectingSecretStore(
      LICENSE_FILE_SECRET_KEY,
      "CredWrite failed with Win32 error 1783 for a 6000-byte blob."
    );
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

    await assert.rejects(
      service.activateWithKey("live-key"),
      (error: unknown) =>
        error instanceof Error &&
        /could not save it to this machine's credential store/.test(
          error.message
        ) &&
        error.cause instanceof Error &&
        /Win32 error 1783/.test(error.cause.message)
    );

    // The machine slot must still be released, or a retry burns another one.
    assert.strictEqual(
      calls.filter((call) => call.method === "DELETE").length,
      1
    );
    assert.strictEqual((await service.getEntitlement()).tier, "free");
  });

  test("reports a failed license-file import instead of claiming success", async () => {
    const secrets = new RejectingSecretStore(
      LICENSE_FILE_SECRET_KEY,
      "CredWrite failed with Win32 error 1783 for a 6000-byte blob."
    );
    const service = createService(secrets);

    await assert.rejects(
      service.importLicenseFile(await createLicenseFile()),
      /could not save it to this machine's credential store/
    );
  });

  test("treats an unverifiable license-file import as a no-op", async () => {
    const secrets = new InMemorySecretStore();
    await cache(secrets, await createLicenseFile());
    const service = createService(secrets);

    const entitlement = await service.importLicenseFile("not-a-license-file");

    assert.strictEqual(entitlement.tier, "pro");
  });

  test("invalidates the cache immediately on deactivate", async () => {
    const secrets = new InMemorySecretStore();
    await cache(secrets, await createLicenseFile());
    await secrets.store(LICENSE_KEY_SECRET_KEY, "live-key");
    const service = createService(secrets);

    assert.strictEqual(await service.isPro(), true);
    await service.deactivate();
    assert.strictEqual(await service.isPro(), false);
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
  readonly machines?: Response;
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
    if (parsed.pathname.endsWith("/machines") && method === "GET") {
      return responses.machines ?? new Response(null, { status: 500 });
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
    readonly now?: () => number;
    readonly machineFingerprint?: string | (() => Promise<string>);
    readonly trialState?: LicenseTrialStateStore;
    readonly setTimeout?: typeof setTimeout;
    readonly clearTimeout?: typeof clearTimeout;
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
  overrides: { issued?: number; expiry?: number; policyId?: string } = {},
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
      relationships: {
        policy: { data: { id: overrides.policyId ?? KEYGEN_PRO_POLICY_ID } },
      },
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
