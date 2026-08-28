import { createHash, randomUUID, webcrypto } from "node:crypto";
import type { SecretStore } from "../platform/SecretStore";
import { PRO_FEATURES } from "../types/DashboardConstants";
import { TypedEmitter } from "../utils/TypedEmitter";

/** The source determines whether a license file's TTL is enforced locally. */
export const LICENSE_SOURCES = {
  ONLINE: "online",
  OFFLINE_FILE: "offline-file",
} as const;

export type LicenseSource =
  (typeof LICENSE_SOURCES)[keyof typeof LICENSE_SOURCES];

/** Secret-store keys used by the licensing service. */
export const LICENSE_FILE_SECRET_KEY = "ctrlyoke.pro.license-file";
export const LICENSE_KEY_SECRET_KEY = "ctrlyoke.pro.license-key";
export const LICENSE_SOURCE_SECRET_KEY = "ctrlyoke.pro.license-source";
export const LICENSE_ID_SECRET_KEY = "ctrlyoke.pro.license-id";
export const LICENSE_MACHINE_ID_SECRET_KEY = "ctrlyoke.pro.machine-id";
export const LICENSE_MACHINE_FINGERPRINT_SECRET_KEY =
  "ctrlyoke.pro.machine-fingerprint";

export const KEYGEN_ACCOUNT_ID = "6ed6209c-6633-4444-9d43-ab4a473e2f28";
export const KEYGEN_PRODUCT_ID = "f4af3c3b-4350-4a6e-af09-744797abb4b0";
export const KEYGEN_PRO_POLICY_ID = "da0764ce-6577-419a-862d-128efdbfc329";
export const KEYGEN_API_BASE_URL = `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}`;

/** The Keygen account verification key. This is public and safe to ship. */
export const KEYGEN_ACCOUNT_PUBLIC_KEY_HEX =
  "4cf46fe061bf97080094f14430fa2a1563f1b245cd600ccb99039bfff43836fa";

export const LICENSE_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LICENSE_OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
export const LICENSE_REFRESH_LEAD_MS = 7 * 24 * 60 * 60 * 1000;
/** Allow normal client/server clock skew without weakening the file TTL. */
export const LICENSE_CLOCK_SKEW_MS = 5 * 60 * 1000;

const LICENSE_FILE_ALGORITHMS = {
  PLAIN_ED25519: "base64+ed25519",
  AES_GCM_ED25519: "aes-256-gcm+ed25519",
} as const;

const LICENSE_FILE_HEADER = "LICENSE";
export const LICENSE_TIERS = {
  FREE: "free",
  PRO: "pro",
} as const;

type LicenseTier = (typeof LICENSE_TIERS)[keyof typeof LICENSE_TIERS];

export interface Entitlement {
  tier: LicenseTier;
  features: ReadonlySet<string>;
  expiresAt: number | null;
  licenseId?: string;
  source?: LicenseSource;
}

export interface LicenseService {
  /** Verify the cached signed license file offline. Never throws; failures return free. */
  getEntitlement(): Promise<Entitlement>;
  isPro(): Promise<boolean>;

  /** Activate this machine online and cache a signed license file. */
  activateWithKey(key: string): Promise<Entitlement>;

  /** Import and verify a signed license file without making network calls. */
  importLicenseFile(blob: string): Promise<Entitlement>;

  /** Refresh the cached signed file when it is near its online TTL. */
  refresh(): Promise<void>;

  /** Phase 2 sign-in activation is implemented in a later licensing step. */
  activateWithSignIn?(): Promise<Entitlement>;

  deactivate(): Promise<void>;

  readonly onDidChangeEntitlement: (listener: (e: Entitlement) => void) => {
    dispose(): void;
  };
}

export interface LicenseServiceOptions {
  /** Test seam for deterministic clocks; production uses Date.now. */
  readonly now?: () => number;
  /** Test seam for exercising verification with a generated Ed25519 keypair. */
  readonly publicKeyHex?: string;
  /** Test seam for Keygen HTTP calls; production uses the global fetch. */
  readonly fetch?: typeof fetch;
  /** Test seam for the stable machine fingerprint. */
  readonly machineFingerprint?: string | (() => Promise<string>);
}

interface LicenseCertificate {
  readonly type: typeof LICENSE_FILE_HEADER;
  readonly enc: string;
  readonly sig: string;
  readonly alg: string;
}

interface JsonRecord {
  readonly [key: string]: unknown;
}

interface CachedLicense {
  readonly blob: string;
  readonly source: LicenseSource;
}

interface StoredActivation {
  readonly licenseId: string;
  readonly machineId: string;
}

interface VerifiedLicense {
  readonly entitlement: Entitlement;
  readonly issuedAt: number;
}

interface JsonApiResponse {
  readonly data?: unknown;
  readonly meta?: unknown;
}

class KeygenApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string
  ) {
    super(`Keygen ${operation} request failed with status ${status}`);
    this.name = "KeygenApiError";
  }
}

class UserFacingLicenseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingLicenseError";
  }
}

/**
 * Foundational offline licensing service. The constructor takes the
 * platform-neutral SecretStore so this service stays independent of VS Code.
 */
export class LicenseService implements LicenseService {
  private readonly changes = new TypedEmitter<Entitlement>();
  private readonly now: () => number;
  private readonly publicKeyHex: string;
  private readonly request: typeof fetch;
  private readonly machineFingerprintOption:
    | string
    | (() => Promise<string>)
    | undefined;

  public readonly onDidChangeEntitlement = this.changes.event;

  constructor(
    private readonly secretStore: SecretStore,
    options: LicenseServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.publicKeyHex = options.publicKeyHex ?? KEYGEN_ACCOUNT_PUBLIC_KEY_HEX;
    this.request = options.fetch ?? fetch;
    this.machineFingerprintOption = options.machineFingerprint;
  }

  async getEntitlement(): Promise<Entitlement> {
    try {
      const cached = await this.readCachedLicense();
      if (!cached) {
        return createFreeEntitlement();
      }

      const licenseKey = await this.secretStore.get(LICENSE_KEY_SECRET_KEY);
      const verified = await this.verifyCachedLicense(
        cached.blob,
        cached.source,
        licenseKey
      );
      return verified.entitlement;
    } catch {
      // License problems must never interfere with the free product.
      return createFreeEntitlement();
    }
  }

  async isPro(): Promise<boolean> {
    return (await this.getEntitlement()).tier === LICENSE_TIERS.PRO;
  }

  async activateWithKey(key: string): Promise<Entitlement> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new UserFacingLicenseError(
        "Enter a Pro license key to activate ctrlyoke."
      );
    }

    let machineId: string | undefined;
    let createdMachine = false;
    try {
      const fingerprint = await this.getMachineFingerprint();
      const license = await this.validateKey(normalizedKey);
      const stored = await this.readStoredActivation();

      if (stored?.licenseId === license.id) {
        const existing = await this.findMachine(
          stored.machineId,
          normalizedKey
        );
        if (existing) {
          machineId = stored.machineId;
        }
      }

      if (!machineId) {
        const machine = await this.activateMachine(
          normalizedKey,
          license.id,
          fingerprint
        );
        machineId = machine.id;
        createdMachine = true;
      }

      const blob = await this.checkoutLicense(normalizedKey, license.id);
      const verified = await this.verifyCachedLicense(
        blob,
        LICENSE_SOURCES.ONLINE,
        normalizedKey
      );

      await this.cacheOnlineLicense(normalizedKey, blob, license.id, machineId);
      this.changes.fire(verified.entitlement);
      return verified.entitlement;
    } catch (error) {
      if (createdMachine && machineId) {
        await this.releaseMachine(machineId, normalizedKey);
      }
      throw toActivationError(error);
    }
  }

  async importLicenseFile(blob: string): Promise<Entitlement> {
    try {
      const normalizedBlob = blob.trim();
      if (!normalizedBlob) {
        throw new Error("A license file is required");
      }

      const licenseKey = await this.secretStore.get(LICENSE_KEY_SECRET_KEY);
      const verified = await this.verifyCachedLicense(
        normalizedBlob,
        LICENSE_SOURCES.OFFLINE_FILE,
        licenseKey
      );

      await this.secretStore.store(LICENSE_FILE_SECRET_KEY, normalizedBlob);
      await this.secretStore.store(
        LICENSE_SOURCE_SECRET_KEY,
        LICENSE_SOURCES.OFFLINE_FILE
      );
      this.changes.fire(verified.entitlement);
      return verified.entitlement;
    } catch {
      // An invalid import must not replace a valid entitlement or break the
      // free product. Re-read the existing cache so a failed import is a
      // no-op from the caller's perspective.
      return this.getEntitlement();
    }
  }

  async refresh(): Promise<void> {
    try {
      const cached = await this.readCachedLicense();
      if (!cached || cached.source !== LICENSE_SOURCES.ONLINE) {
        return;
      }

      const key = await this.secretStore.get(LICENSE_KEY_SECRET_KEY);
      if (!key) {
        return;
      }

      const verified = await this.verifyCachedLicense(
        cached.blob,
        cached.source,
        key
      );
      const ttlExpiry = verified.issuedAt + LICENSE_FILE_TTL_MS;
      const now = this.now();
      if (
        now < ttlExpiry - LICENSE_REFRESH_LEAD_MS ||
        now > ttlExpiry + LICENSE_OFFLINE_GRACE_MS
      ) {
        return;
      }

      const licenseId = verified.entitlement.licenseId;
      if (!licenseId) {
        return;
      }

      const blob = await this.checkoutLicense(key, licenseId);
      const refreshed = await this.verifyCachedLicense(
        blob,
        LICENSE_SOURCES.ONLINE,
        key
      );
      await this.secretStore.store(LICENSE_FILE_SECRET_KEY, blob);
      await this.secretStore.store(
        LICENSE_SOURCE_SECRET_KEY,
        LICENSE_SOURCES.ONLINE
      );
      await this.secretStore.store(LICENSE_ID_SECRET_KEY, licenseId);
      this.changes.fire(refreshed.entitlement);
    } catch {
      // Refresh is deliberately best-effort. The signed cache and offline grace
      // continue to protect a paying user during a connectivity outage.
    }
  }

  async activateWithSignIn?(): Promise<Entitlement> {
    throw new Error("License sign-in activation is not implemented yet");
  }

  async deactivate(): Promise<void> {
    const key = await this.secretStore.get(LICENSE_KEY_SECRET_KEY);
    const activation = await this.readStoredActivation();
    if (key && activation) {
      await this.releaseMachine(activation.machineId, key);
    }

    await Promise.all([
      this.secretStore.delete(LICENSE_FILE_SECRET_KEY),
      this.secretStore.delete(LICENSE_KEY_SECRET_KEY),
      this.secretStore.delete(LICENSE_SOURCE_SECRET_KEY),
      this.secretStore.delete(LICENSE_ID_SECRET_KEY),
      this.secretStore.delete(LICENSE_MACHINE_ID_SECRET_KEY),
    ]);
    this.changes.fire(createFreeEntitlement());
  }

  dispose(): void {
    this.changes.dispose();
  }

  private async readCachedLicense(): Promise<CachedLicense | undefined> {
    const stored = await this.secretStore.get(LICENSE_FILE_SECRET_KEY);
    if (!stored) {
      return undefined;
    }

    let blob = stored;
    let source: LicenseSource = LICENSE_SOURCES.ONLINE;

    // Accept the raw certificate used by the initial cache and an envelope so
    // later activation steps can persist source metadata atomically.
    try {
      const envelope = JSON.parse(stored) as JsonRecord;
      const envelopeBlob =
        envelope.blob ?? envelope.licenseFile ?? envelope.file;
      if (typeof envelopeBlob === "string") {
        blob = envelopeBlob;
        source = parseLicenseSource(envelope.source) ?? source;
      }
    } catch {
      // A raw Keygen certificate is not JSON; that is the normal format.
    }

    const storedSource = parseLicenseSource(
      await this.secretStore.get(LICENSE_SOURCE_SECRET_KEY)
    );
    return { blob, source: storedSource ?? source };
  }

  private async verifyCachedLicense(
    blob: string,
    source: LicenseSource,
    licenseKey: string | undefined
  ): Promise<VerifiedLicense> {
    const certificate = parseCertificate(blob);
    if (certificate.type !== LICENSE_FILE_HEADER) {
      throw new Error("Unsupported license certificate type");
    }
    if (
      certificate.alg !== LICENSE_FILE_ALGORITHMS.PLAIN_ED25519 &&
      certificate.alg !== LICENSE_FILE_ALGORITHMS.AES_GCM_ED25519
    ) {
      throw new Error("Unsupported license file algorithm");
    }

    const publicKey = await webcrypto.subtle.importKey(
      "raw",
      toArrayBuffer(hexToBytes(this.publicKeyHex)),
      { name: "Ed25519" },
      false,
      ["verify"]
    );
    const verified = await webcrypto.subtle.verify(
      { name: "Ed25519" },
      publicKey,
      toArrayBuffer(decodeBase64(certificate.sig)),
      toArrayBuffer(new TextEncoder().encode(`license/${certificate.enc}`))
    );
    if (!verified) {
      throw new Error("License signature verification failed");
    }

    const payload =
      certificate.alg === LICENSE_FILE_ALGORITHMS.AES_GCM_ED25519
        ? await decryptLicensePayload(certificate.enc, licenseKey)
        : parseJson(decodeBase64(certificate.enc));

    const meta = asRecord(payload)?.meta;
    const issuedAt = parseTimestamp(asRecord(meta)?.issued);
    if (issuedAt === undefined) {
      throw new Error("License file is missing issuance metadata");
    }

    return {
      entitlement: entitlementFromPayload(payload, source, this.now()),
      issuedAt,
    };
  }

  private async validateKey(key: string): Promise<{ readonly id: string }> {
    const body = await this.keygenJson("/licenses/actions/validate-key", {
      method: "POST",
      body: JSON.stringify({ meta: { key } }),
    });
    const meta = asRecord(body.meta);
    const validationCode = meta?.code;
    const canActivate =
      meta?.valid === true ||
      validationCode === "NO_MACHINES" ||
      validationCode === "FINGERPRINT_SCOPE_MISMATCH";
    if (!canActivate) {
      throw new UserFacingLicenseError(
        "That Pro license key was rejected. It may be invalid, expired, suspended, or at its 10-machine limit."
      );
    }

    const data = asRecord(body.data);
    const id = data?.id;
    if (typeof id !== "string" || !id) {
      throw new Error("Keygen returned no license identifier");
    }
    assertExpectedRelationship(data, "product", KEYGEN_PRODUCT_ID);
    assertExpectedRelationship(data, "policy", KEYGEN_PRO_POLICY_ID);
    return { id };
  }

  private async activateMachine(
    key: string,
    licenseId: string,
    fingerprint: string
  ): Promise<{ readonly id: string }> {
    const body = await this.keygenJson("/machines", {
      method: "POST",
      authorization: key,
      body: JSON.stringify({
        data: {
          type: "machines",
          attributes: {
            fingerprint,
            name: "ctrlyoke",
            platform: process.platform,
          },
          relationships: {
            license: { data: { type: "licenses", id: licenseId } },
          },
        },
      }),
    });
    const id = asRecord(body.data)?.id;
    if (typeof id !== "string" || !id) {
      throw new Error("Keygen returned no machine identifier");
    }
    return { id };
  }

  private async findMachine(machineId: string, key: string): Promise<boolean> {
    const response = await this.request(
      `${KEYGEN_API_BASE_URL}/machines/${encodeURIComponent(machineId)}`,
      { headers: keygenHeaders(key) }
    );
    if (response.ok) {
      return true;
    }
    if (response.status === 404) {
      return false;
    }
    throw new KeygenApiError(response.status, "machine lookup");
  }

  private async checkoutLicense(
    key: string,
    licenseId: string
  ): Promise<string> {
    const url = new URL(
      `${KEYGEN_API_BASE_URL}/licenses/${encodeURIComponent(licenseId)}/actions/check-out`
    );
    url.searchParams.set("ttl", String(LICENSE_FILE_TTL_MS / 1000));
    const response = await this.request(url, {
      headers: keygenHeaders(key),
    });
    if (!response.ok) {
      throw new KeygenApiError(response.status, "license download");
    }
    return response.text();
  }

  private async keygenJson(
    path: string,
    options: {
      readonly method: string;
      readonly body?: string;
      readonly authorization?: string;
    }
  ): Promise<JsonApiResponse> {
    const response = await this.request(`${KEYGEN_API_BASE_URL}${path}`, {
      method: options.method,
      headers: keygenHeaders(options.authorization),
      ...(options.body ? { body: options.body } : {}),
    });
    if (!response.ok) {
      throw new KeygenApiError(response.status, "API");
    }
    return (await response.json()) as JsonApiResponse;
  }

  private async getMachineFingerprint(): Promise<string> {
    const stored = await this.secretStore.get(
      LICENSE_MACHINE_FINGERPRINT_SECRET_KEY
    );
    if (stored) {
      return stored;
    }

    const configured =
      typeof this.machineFingerprintOption === "function"
        ? await this.machineFingerprintOption()
        : this.machineFingerprintOption;
    const fingerprint =
      configured?.trim() ||
      createHash("sha256")
        .update(`ctrlyoke:${randomUUID()}`, "utf8")
        .digest("hex");
    await this.secretStore.store(
      LICENSE_MACHINE_FINGERPRINT_SECRET_KEY,
      fingerprint
    );
    return fingerprint;
  }

  private async readStoredActivation(): Promise<StoredActivation | undefined> {
    const [licenseId, machineId] = await Promise.all([
      this.secretStore.get(LICENSE_ID_SECRET_KEY),
      this.secretStore.get(LICENSE_MACHINE_ID_SECRET_KEY),
    ]);
    return licenseId && machineId ? { licenseId, machineId } : undefined;
  }

  private async cacheOnlineLicense(
    key: string,
    blob: string,
    licenseId: string,
    machineId: string
  ): Promise<void> {
    await this.secretStore.store(LICENSE_KEY_SECRET_KEY, key);
    await this.secretStore.store(LICENSE_FILE_SECRET_KEY, blob);
    await this.secretStore.store(
      LICENSE_SOURCE_SECRET_KEY,
      LICENSE_SOURCES.ONLINE
    );
    await this.secretStore.store(LICENSE_ID_SECRET_KEY, licenseId);
    await this.secretStore.store(LICENSE_MACHINE_ID_SECRET_KEY, machineId);
  }

  private async releaseMachine(machineId: string, key: string): Promise<void> {
    try {
      const response = await this.request(
        `${KEYGEN_API_BASE_URL}/machines/${encodeURIComponent(machineId)}`,
        { method: "DELETE", headers: keygenHeaders(key) }
      );
      if (!response.ok && response.status !== 404) {
        throw new KeygenApiError(response.status, "machine deactivation");
      }
    } catch {
      // Local deactivation must still complete when the network is unavailable.
    }
  }
}

function keygenHeaders(key?: string): Record<string, string> {
  return {
    "Content-Type": "application/vnd.api+json",
    Accept: "application/vnd.api+json",
    ...(key ? { Authorization: `License ${key}` } : {}),
  };
}

function assertExpectedRelationship(
  data: JsonRecord,
  relationshipName: "product" | "policy",
  expectedId: string
): void {
  const relationship = asRecord(
    asRecord(data.relationships)?.[relationshipName]
  );
  const relationshipData = asRecord(relationship?.data);
  if (relationshipData && relationshipData.id !== expectedId) {
    throw new UserFacingLicenseError(
      "That Pro license key belongs to a different ctrlyoke product or policy."
    );
  }
}

function toActivationError(error: unknown): Error {
  if (error instanceof UserFacingLicenseError) {
    return error;
  }
  if (
    error instanceof KeygenApiError &&
    [401, 403, 404, 409, 422].includes(error.status)
  ) {
    return new UserFacingLicenseError(
      "That Pro license key was rejected. It may be invalid, expired, suspended, or at its 10-machine limit."
    );
  }
  return new UserFacingLicenseError(
    "ctrlyoke could not activate the Pro license right now. Check your internet connection and try again."
  );
}

function createFreeEntitlement(): Entitlement {
  return {
    tier: LICENSE_TIERS.FREE,
    features: new Set<string>(),
    expiresAt: null,
  };
}

function parseLicenseSource(value: unknown): LicenseSource | undefined {
  return value === LICENSE_SOURCES.ONLINE ||
    value === LICENSE_SOURCES.OFFLINE_FILE
    ? value
    : undefined;
}

function parseCertificate(blob: string): LicenseCertificate {
  const normalized = blob.replace(/\r\n/g, "\n").trim();
  const match = normalized.match(
    /^-----BEGIN (LICENSE) FILE-----\n([\s\S]*?)\n-----END \1 FILE-----$/
  );
  if (!match) {
    throw new Error("Invalid license certificate");
  }

  const payload = parseJson(decodeBase64(match[2].replace(/\s/g, "")));
  if (
    !isRecord(payload) ||
    typeof payload.enc !== "string" ||
    typeof payload.sig !== "string" ||
    typeof payload.alg !== "string"
  ) {
    throw new Error("Invalid license certificate payload");
  }

  return {
    type: LICENSE_FILE_HEADER,
    enc: payload.enc,
    sig: payload.sig,
    alg: payload.alg,
  };
}

async function decryptLicensePayload(
  encryptedValue: string,
  licenseKey: string | undefined
): Promise<unknown> {
  if (!licenseKey) {
    throw new Error("An encrypted license file requires its license key");
  }

  const parts = encryptedValue.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted license payload");
  }
  const [ciphertext, iv, authTag] = parts.map(decodeBase64);
  if (iv.byteLength !== 12 || authTag.byteLength !== 16) {
    throw new Error("Invalid AES-GCM license payload");
  }

  const secret = createHash("sha256").update(licenseKey, "utf8").digest();
  const key = await webcrypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    { name: "AES-GCM" },
    false,
    ["decrypt"]
  );
  const plaintext = await webcrypto.subtle.decrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv), tagLength: 128 },
    key,
    toArrayBuffer(Buffer.concat([ciphertext, authTag]))
  );
  return parseJson(new Uint8Array(plaintext));
}

function entitlementFromPayload(
  payload: unknown,
  source: LicenseSource,
  now: number
): Entitlement {
  if (!isRecord(payload)) {
    throw new Error("Invalid decoded license payload");
  }

  const meta = asRecord(payload.meta);
  const issuedAt = parseTimestamp(meta?.issued);
  const fileExpiry = parseTimestamp(meta?.expiry);
  if (issuedAt === undefined || fileExpiry === undefined) {
    throw new Error("License file is missing issuance metadata");
  }
  if (issuedAt > now + LICENSE_CLOCK_SKEW_MS) {
    throw new Error("License file was issued in the future");
  }

  if (source === LICENSE_SOURCES.ONLINE) {
    const expectedTtlExpiry = issuedAt + LICENSE_FILE_TTL_MS;
    const effectiveExpiry = Math.min(fileExpiry, expectedTtlExpiry);
    if (now > effectiveExpiry + LICENSE_OFFLINE_GRACE_MS) {
      throw new Error("Online license file has expired");
    }
  }

  const attributes = licenseAttributes(payload);
  const licenseExpiry = parseOptionalTimestamp(
    attributes?.expiry ?? attributes?.expiresAt ?? payload.expiresAt
  );
  if (licenseExpiry !== null && now > licenseExpiry) {
    throw new Error("License has expired");
  }

  const tier = readTier(payload, attributes);
  return {
    tier,
    features:
      tier === LICENSE_TIERS.PRO
        ? new Set<string>(Object.values(PRO_FEATURES))
        : new Set<string>(),
    expiresAt: licenseExpiry,
    ...(readLicenseId(payload, attributes)
      ? { licenseId: readLicenseId(payload, attributes) }
      : {}),
    source,
  };
}

function licenseAttributes(payload: JsonRecord): JsonRecord | undefined {
  const data = payload.data;
  if (isRecord(data) && isRecord(data.attributes)) {
    return data.attributes;
  }
  if (
    Array.isArray(data) &&
    isRecord(data[0]) &&
    isRecord(data[0].attributes)
  ) {
    return data[0].attributes;
  }
  return isRecord(payload.attributes) ? payload.attributes : undefined;
}

function readTier(
  payload: JsonRecord,
  attributes: JsonRecord | undefined
): LicenseTier {
  const metadata = asRecord(attributes?.metadata);
  const value =
    payload.tier ?? attributes?.tier ?? metadata?.tier ?? payload.plan;
  if (value === LICENSE_TIERS.FREE) {
    return LICENSE_TIERS.FREE;
  }
  if (value === LICENSE_TIERS.PRO || value === undefined) {
    return LICENSE_TIERS.PRO;
  }
  throw new Error("Unknown license tier");
}

function readLicenseId(
  payload: JsonRecord,
  attributes: JsonRecord | undefined
): string | undefined {
  const data = payload.data;
  if (isRecord(data) && typeof data.id === "string") {
    return data.id;
  }
  if (
    Array.isArray(data) &&
    isRecord(data[0]) &&
    typeof data[0].id === "string"
  ) {
    return data[0].id;
  }
  const id = payload.licenseId ?? attributes?.licenseId ?? payload.id;
  return typeof id === "string" ? id : undefined;
}

function parseJson(value: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(value)) as unknown;
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("Invalid base64 value");
  }
  return new Uint8Array(Buffer.from(value, "base64"));
}

function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("Invalid Ed25519 public key");
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function parseOptionalTimestamp(value: unknown): number | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const timestamp = parseTimestamp(value);
  if (timestamp === undefined) {
    throw new Error("Invalid license expiry");
  }
  return timestamp;
}

function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.length > 0) {
    const timestamp = Date.parse(value);
    return Number.isNaN(timestamp) ? undefined : timestamp;
  }
  return undefined;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
