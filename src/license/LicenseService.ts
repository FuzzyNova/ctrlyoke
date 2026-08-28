import { createHash, webcrypto } from "node:crypto";
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

/** The Keygen account verification key. This is public and safe to ship. */
export const KEYGEN_ACCOUNT_PUBLIC_KEY_HEX =
  "4cf46fe061bf97080094f14430fa2a1563f1b245cd600ccb99039bfff43836fa";

export const LICENSE_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LICENSE_OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;

const LICENSE_FILE_ALGORITHMS = {
  PLAIN_ED25519: "base64+ed25519",
  AES_GCM_ED25519: "aes-256-gcm+ed25519",
} as const;

const LICENSE_FILE_HEADER = "LICENSE";
const PRO_TIER = "pro";
const FREE_TIER = "free";

type LicenseTier = typeof FREE_TIER | typeof PRO_TIER;

export interface Entitlement {
  tier: "free" | "pro";
  features: ReadonlySet<string>;
  expiresAt: number | null;
  licenseId?: string;
  source?: LicenseSource;
}

export interface LicenseService {
  /** Verify the cached signed license file offline. Never throws; failures return free. */
  getEntitlement(): Promise<Entitlement>;
  isPro(): Promise<boolean>;

  /** Online activation is implemented in a later licensing step. */
  activateWithKey(key: string): Promise<Entitlement>;

  /** Air-gapped import is implemented in a later licensing step. */
  importLicenseFile(blob: string): Promise<Entitlement>;

  /** Online refresh is implemented in a later licensing step. */
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

/**
 * Foundational offline licensing service. The constructor takes the
 * platform-neutral SecretStore so this service stays independent of VS Code.
 */
export class LicenseService implements LicenseService {
  private readonly changes = new TypedEmitter<Entitlement>();
  private readonly now: () => number;
  private readonly publicKeyHex: string;

  public readonly onDidChangeEntitlement = this.changes.event;

  constructor(
    private readonly secretStore: SecretStore,
    options: LicenseServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.publicKeyHex = options.publicKeyHex ?? KEYGEN_ACCOUNT_PUBLIC_KEY_HEX;
  }

  async getEntitlement(): Promise<Entitlement> {
    try {
      const cached = await this.readCachedLicense();
      if (!cached) {
        return createFreeEntitlement();
      }

      const licenseKey = await this.secretStore.get(LICENSE_KEY_SECRET_KEY);
      return await this.verifyCachedLicense(
        cached.blob,
        cached.source,
        licenseKey
      );
    } catch {
      // License problems must never interfere with the free product.
      return createFreeEntitlement();
    }
  }

  async isPro(): Promise<boolean> {
    return (await this.getEntitlement()).tier === PRO_TIER;
  }

  async activateWithKey(_key: string): Promise<Entitlement> {
    throw new Error("License activation is not implemented yet");
  }

  async importLicenseFile(_blob: string): Promise<Entitlement> {
    throw new Error("Offline license import is not implemented yet");
  }

  async refresh(): Promise<void> {
    throw new Error("License refresh is not implemented yet");
  }

  async activateWithSignIn?(): Promise<Entitlement> {
    throw new Error("License sign-in activation is not implemented yet");
  }

  async deactivate(): Promise<void> {
    await this.secretStore.delete(LICENSE_FILE_SECRET_KEY);
    await this.secretStore.delete(LICENSE_KEY_SECRET_KEY);
    await this.secretStore.delete(LICENSE_SOURCE_SECRET_KEY);
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
  ): Promise<Entitlement> {
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

    return entitlementFromPayload(payload, source, this.now());
  }
}

function createFreeEntitlement(): Entitlement {
  return {
    tier: FREE_TIER,
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
  if (issuedAt > now) {
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
      tier === PRO_TIER
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
  if (value === FREE_TIER) {
    return FREE_TIER;
  }
  if (value === PRO_TIER || value === undefined) {
    return PRO_TIER;
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
