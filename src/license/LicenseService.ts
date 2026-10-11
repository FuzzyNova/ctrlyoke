import { createHash, randomUUID, webcrypto } from "node:crypto";
import {
  CHECKOUT_ELIGIBLE_VALIDATION_CODES,
  KEYGEN_API_BASE_URL,
  KEYGEN_ENTERPRISE_POLICY_ID,
  KEYGEN_PRODUCT_ID,
  KEYGEN_VALID_POLICY_IDS,
  LICENSE_CERTIFICATE_BEGIN,
  LICENSE_CERTIFICATE_END,
  LICENSE_FILE_TTL_MS,
  LICENSE_VALIDATION_CODES,
} from "./KeygenConstants";
import type { SecretStore } from "../platform/SecretStore";
import { PRO_FEATURES } from "../types/DashboardConstants";
import { TypedEmitter } from "../utils/TypedEmitter";

export {
  CHECKOUT_ELIGIBLE_VALIDATION_CODES,
  KEYGEN_ACCOUNT_ID,
  KEYGEN_API_BASE_URL,
  KEYGEN_ENTERPRISE_POLICY_ID,
  KEYGEN_PRODUCT_ID,
  KEYGEN_PRO_POLICY_ID,
  KEYGEN_VALID_POLICY_IDS,
  LICENSE_CERTIFICATE_BEGIN,
  LICENSE_CERTIFICATE_END,
  LICENSE_FILE_TTL_MS,
  LICENSE_VALIDATION_CODES,
} from "./KeygenConstants";

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

/** The Keygen account verification key. This is public and safe to ship. */
export const KEYGEN_ACCOUNT_PUBLIC_KEY_HEX =
  "4cf46fe061bf97080094f14430fa2a1563f1b245cd600ccb99039bfff43836fa";

export const LICENSE_OFFLINE_GRACE_MS = 14 * 24 * 60 * 60 * 1000;
export const LICENSE_REFRESH_LEAD_MS = 7 * 24 * 60 * 60 * 1000;
export const REMOTE_ACCESS_TRIAL_MS = 14 * 24 * 60 * 60 * 1000;
export const REMOTE_ACCESS_TRIAL_START_KEY =
  "ctrlyoke.remoteAccessTrialStartedAt";
/** Allow normal client/server clock skew without weakening the file TTL. */
export const LICENSE_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** Background refresh cadence for long-lived extension hosts. */
export const LICENSE_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Initial retry delay after a failed refresh within the TTL window. */
export const LICENSE_REFRESH_RETRY_BASE_MS = 15 * 60 * 1000;
/**
 * getEntitlement()'s in-memory cache window. Some backing SecretStores (e.g.
 * OsCredentialStore) shell out to a platform CLI per call, and getEntitlement
 * is on hot-ish paths (canUseRemoteAccess is checked per hosted-server
 * connection) — without this, every check would spawn a process. A short TTL
 * bounds how stale a locally-expired/deactivated entitlement can read; any
 * mutation (activate/import/refresh/deactivate) refreshes the cache immediately.
 */
export const ENTITLEMENT_CACHE_TTL_MS = 60 * 1000;

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
  /** True when this Pro entitlement was issued under the Enterprise policy. */
  isEnterprise?: boolean;
}

export interface LicenseMachineSummary {
  id: string;
  name: string | undefined;
  platform: string | undefined;
  createdAt: string | undefined;
  isThisMachine: boolean;
}

export interface LicenseService {
  /** Verify the cached signed license file offline. Never throws; failures return free. */
  getEntitlement(): Promise<Entitlement>;
  isPro(): Promise<boolean>;
  /** Pro, an active trial, or an unused trial available to start. Read-only. */
  canUseRemoteAccess(): Promise<boolean>;
  /** Starts the trial if needed, then reports whether remote access is allowed. */
  beginRemoteAccess(): Promise<boolean>;
  /** Starts the one-time trial, returning its timestamp or null on failure. */
  startRemoteAccessTrial(): Promise<number | null>;
  getRemoteAccessTrialEndsAt(): Promise<number | null>;
  /** Read the cached online key for license-scoped management operations. */
  getStoredLicenseKey(): Promise<string | undefined>;

  listMachines(key: string): Promise<LicenseMachineSummary[]>;
  deactivateMachine(key: string, machineId: string): Promise<void>;

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
  /** VS Code globalState-like store for the extension-only remote-access trial. */
  readonly trialState?: LicenseTrialStateStore;
  /** Test seams for the owned background refresh schedule. */
  readonly setTimeout?: typeof setTimeout;
  readonly clearTimeout?: typeof clearTimeout;
}

type RefreshOutcome = "refreshed" | "skipped" | "failed-in-window";

export interface LicenseTrialStateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
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
  readonly errors?: unknown;
}

class KeygenApiError extends Error {
  constructor(
    readonly status: number,
    readonly operation: string,
    readonly code?: string
  ) {
    super(`Keygen ${operation} request failed with status ${status}`);
    this.name = "KeygenApiError";
  }
}

class UserFacingLicenseError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        value: cause,
      });
    }
    this.name = "UserFacingLicenseError";
  }
}

export class LicenseActivationLimitError extends UserFacingLicenseError {
  constructor(readonly licenseId: string) {
    super(
      "This Pro license has reached its machine limit. Deactivate another machine and try again."
    );
    this.name = "LicenseActivationLimitError";
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
    string | (() => Promise<string>) | undefined;
  private readonly trialState: LicenseTrialStateStore | undefined;
  private readonly scheduleTimeout: typeof setTimeout;
  private readonly cancelTimeout: typeof clearTimeout;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshInFlight: Promise<RefreshOutcome> | undefined;
  private refreshRetryDelay = LICENSE_REFRESH_RETRY_BASE_MS;
  private disposed = false;
  private cachedEntitlement:
    { readonly value: Entitlement; readonly expiresAt: number } | undefined;

  public readonly onDidChangeEntitlement = this.changes.event;

  constructor(
    private readonly secretStore: SecretStore,
    options: LicenseServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.publicKeyHex = options.publicKeyHex ?? KEYGEN_ACCOUNT_PUBLIC_KEY_HEX;
    this.request = options.fetch ?? fetch;
    this.machineFingerprintOption = options.machineFingerprint;
    this.trialState = options.trialState;
    this.scheduleTimeout = options.setTimeout ?? setTimeout;
    this.cancelTimeout = options.clearTimeout ?? clearTimeout;
    this.scheduleBackgroundRefresh(LICENSE_REFRESH_INTERVAL_MS);
  }

  async getEntitlement(): Promise<Entitlement> {
    const cached = this.cachedEntitlement;
    if (cached && this.now() < cached.expiresAt) {
      return cached.value;
    }

    const entitlement = await this.computeEntitlement();
    this.cacheEntitlement(entitlement);
    return entitlement;
  }

  private async computeEntitlement(): Promise<Entitlement> {
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

  private cacheEntitlement(entitlement: Entitlement): void {
    this.cachedEntitlement = {
      value: entitlement,
      expiresAt: this.now() + ENTITLEMENT_CACHE_TTL_MS,
    };
  }

  /** Updates the cache with a known-fresh value and notifies listeners. */
  private setEntitlement(entitlement: Entitlement): void {
    this.cacheEntitlement(entitlement);
    this.changes.fire(entitlement);
  }

  async isPro(): Promise<boolean> {
    return (await this.getEntitlement()).tier === LICENSE_TIERS.PRO;
  }

  async canUseRemoteAccess(): Promise<boolean> {
    if (await this.isPro()) {
      return true;
    }
    const trial = this.readRemoteAccessTrial();
    if (!trial.readable) {
      return false;
    }
    return (
      trial.startedAt === null ||
      this.now() < trial.startedAt + REMOTE_ACCESS_TRIAL_MS
    );
  }

  async beginRemoteAccess(): Promise<boolean> {
    if (await this.isPro()) return true;
    if ((await this.getRemoteAccessTrialStartedAt()) === null) {
      if ((await this.startRemoteAccessTrial()) === null) return false;
    }
    const startedAt = await this.getRemoteAccessTrialStartedAt();
    return (
      startedAt !== null && this.now() < startedAt + REMOTE_ACCESS_TRIAL_MS
    );
  }

  private trialStartPromise: Promise<number | null> | undefined;

  async startRemoteAccessTrial(): Promise<number | null> {
    if (this.trialStartPromise) return this.trialStartPromise;
    this.trialStartPromise = this.writeRemoteAccessTrialStartedAt();
    try {
      return await this.trialStartPromise;
    } finally {
      this.trialStartPromise = undefined;
    }
  }

  async getRemoteAccessTrialEndsAt(): Promise<number | null> {
    if (await this.isPro()) {
      return null;
    }
    const startedAt = await this.getRemoteAccessTrialStartedAt();
    return startedAt === null ? null : startedAt + REMOTE_ACCESS_TRIAL_MS;
  }

  async getStoredLicenseKey(): Promise<string | undefined> {
    return this.secretStore.get(LICENSE_KEY_SECRET_KEY);
  }

  async listMachines(key: string): Promise<LicenseMachineSummary[]> {
    const normalizedKey = key.trim();
    const license = await this.validateKey(normalizedKey);
    const url = new URL(`${KEYGEN_API_BASE_URL}/machines`);
    url.searchParams.set("license", license.id);
    const response = await this.request(url, {
      headers: keygenHeaders(normalizedKey),
    });
    if (!response.ok) {
      throw new KeygenApiError(response.status, "machine listing");
    }

    const body = (await response.json()) as JsonApiResponse;
    const ownMachineId = await this.secretStore.get(
      LICENSE_MACHINE_ID_SECRET_KEY
    );
    const machines = Array.isArray(body.data) ? body.data : [];
    return machines.flatMap((machine): LicenseMachineSummary[] => {
      const resource = asRecord(machine);
      const id = resource?.id;
      if (typeof id !== "string" || !id) {
        return [];
      }
      const attributes = asRecord(resource.attributes);
      return [
        {
          id,
          name: readOptionalString(attributes?.name),
          platform: readOptionalString(attributes?.platform),
          createdAt: readOptionalString(
            attributes?.created ?? attributes?.createdAt
          ),
          isThisMachine: id === ownMachineId,
        },
      ];
    });
  }

  async deactivateMachine(key: string, machineId: string): Promise<void> {
    await this.releaseMachine(machineId, key);
    const ownMachineId = await this.secretStore.get(
      LICENSE_MACHINE_ID_SECRET_KEY
    );
    if (machineId !== ownMachineId) {
      return;
    }

    await this.clearLocalActivation();
    this.setEntitlement(createFreeEntitlement());
  }

  async activateWithKey(key: string): Promise<Entitlement> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new UserFacingLicenseError(
        "Enter a Pro license key to activate ctrlyoke."
      );
    }

    let machineId: string | undefined;
    let licenseId: string | undefined;
    let validationCode: string | undefined;
    let createdMachine = false;
    try {
      const fingerprint = await this.getMachineFingerprint();
      const license = await this.validateKey(normalizedKey);
      licenseId = license.id;
      validationCode = license.validationCode;
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

      // The license is already valid and the machine already activated at this
      // point, so a failure here is local storage, never connectivity — say so
      // rather than sending the caller off to check their network.
      try {
        await this.cacheOnlineLicense(
          normalizedKey,
          blob,
          license.id,
          machineId
        );
      } catch (error) {
        throw new UserFacingLicenseError(
          "ctrlyoke verified the Pro license but could not save it to this machine's credential store.",
          error
        );
      }
      this.setEntitlement(verified.entitlement);
      return verified.entitlement;
    } catch (error) {
      if (createdMachine && machineId) {
        await this.releaseMachine(machineId, normalizedKey);
      }
      throw toActivationError(error, licenseId, validationCode);
    }
  }

  async importLicenseFile(blob: string): Promise<Entitlement> {
    let normalizedBlob: string;
    let verified: VerifiedLicense;
    try {
      normalizedBlob = blob.trim();
      if (!normalizedBlob) {
        throw new Error("A license file is required");
      }

      const licenseKey = await this.secretStore.get(LICENSE_KEY_SECRET_KEY);
      verified = await this.verifyCachedLicense(
        normalizedBlob,
        LICENSE_SOURCES.OFFLINE_FILE,
        licenseKey
      );
    } catch {
      // An invalid import must not replace a valid entitlement or break the
      // free product. Re-read the existing cache so a failed import is a
      // no-op from the caller's perspective.
      return this.getEntitlement();
    }

    // The file verified, so a failure past this point is local storage, not a
    // bad license — reporting it as an import success would strand the user
    // with an entitlement that vanishes on the next read.
    try {
      await this.secretStore.store(LICENSE_FILE_SECRET_KEY, normalizedBlob);
      await this.secretStore.store(
        LICENSE_SOURCE_SECRET_KEY,
        LICENSE_SOURCES.OFFLINE_FILE
      );
    } catch (error) {
      throw new UserFacingLicenseError(
        "ctrlyoke verified the license file but could not save it to this machine's credential store.",
        error
      );
    }
    this.setEntitlement(verified.entitlement);
    return verified.entitlement;
  }

  async refresh(): Promise<void> {
    await this.refreshOnce();
  }

  private refreshOnce(): Promise<RefreshOutcome> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    const inFlight = this.performRefresh().then((outcome) => {
      this.updateBackgroundSchedule(outcome);
      return outcome;
    });
    this.refreshInFlight = inFlight;
    void inFlight.then(() => {
      if (this.refreshInFlight === inFlight) {
        this.refreshInFlight = undefined;
      }
    });
    return inFlight;
  }

  private async performRefresh(): Promise<RefreshOutcome> {
    let inRefreshWindow = false;
    try {
      const cached = await this.readCachedLicense();
      if (!cached || cached.source !== LICENSE_SOURCES.ONLINE) {
        return "skipped";
      }

      const key = await this.secretStore.get(LICENSE_KEY_SECRET_KEY);
      if (!key) {
        return "skipped";
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
        return "skipped";
      }

      const licenseId = verified.entitlement.licenseId;
      if (!licenseId) {
        return "skipped";
      }

      inRefreshWindow = true;
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
      this.setEntitlement(refreshed.entitlement);
      return "refreshed";
    } catch {
      // Refresh is deliberately best-effort. The signed cache and offline grace
      // continue to protect a paying user during a connectivity outage.
      return inRefreshWindow ? "failed-in-window" : "skipped";
    }
  }

  private scheduleBackgroundRefresh(delay: number): void {
    if (this.disposed) {
      return;
    }
    this.refreshTimer = this.scheduleTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshOnce();
    }, delay);
    this.refreshTimer.unref?.();
  }

  private updateBackgroundSchedule(outcome: RefreshOutcome): void {
    if (this.disposed) {
      return;
    }
    if (this.refreshTimer !== undefined) {
      this.cancelTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (outcome === "failed-in-window") {
      const retryDelay = this.refreshRetryDelay;
      this.refreshRetryDelay = Math.min(
        this.refreshRetryDelay * 2,
        LICENSE_REFRESH_INTERVAL_MS
      );
      this.scheduleBackgroundRefresh(retryDelay);
      return;
    }
    this.refreshRetryDelay = LICENSE_REFRESH_RETRY_BASE_MS;
    this.scheduleBackgroundRefresh(LICENSE_REFRESH_INTERVAL_MS);
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

    await this.clearLocalActivation();
    this.setEntitlement(createFreeEntitlement());
  }

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer !== undefined) {
      this.cancelTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
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

  private async validateKey(key: string): Promise<{
    readonly id: string;
    readonly validationCode: string | undefined;
  }> {
    const body = await this.keygenJson("/licenses/actions/validate-key", {
      method: "POST",
      body: JSON.stringify({ meta: { key } }),
    });
    const meta = asRecord(body.meta);
    const validationCode = readOptionalString(meta?.code);
    const canActivate =
      meta?.valid === true ||
      (validationCode !== undefined &&
        CHECKOUT_ELIGIBLE_VALIDATION_CODES.some(
          (code) => code === validationCode
        ));
    if (!canActivate) {
      throw new UserFacingLicenseError(
        "That Pro license key was rejected. It may be invalid, expired, suspended, or at its machine limit."
      );
    }

    const data = asRecord(body.data);
    const id = data?.id;
    if (typeof id !== "string" || !id) {
      throw new Error("Keygen returned no license identifier");
    }
    assertExpectedRelationship(data, "product", [KEYGEN_PRODUCT_ID]);
    assertExpectedRelationship(data, "policy", KEYGEN_VALID_POLICY_IDS);
    return { id, validationCode };
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
      let code: string | undefined;
      try {
        code = readKeygenCode((await response.json()) as JsonApiResponse);
      } catch {
        // Error responses are not required to contain a JSON API body.
      }
      throw new KeygenApiError(response.status, "API", code);
    }
    return (await response.json()) as JsonApiResponse;
  }

  private async getRemoteAccessTrialStartedAt(): Promise<number | null> {
    const trial = this.readRemoteAccessTrial();
    return trial.readable ? trial.startedAt : null;
  }

  /**
   * Distinguishes "trial not started" (`startedAt: null`, eligible) from
   * "trial state unavailable" (`readable: false`: no store wired, as in the
   * CLI, or the read threw), which must fail closed for remote reach.
   */
  private readRemoteAccessTrial():
    { readable: false } | { readable: true; startedAt: number | null } {
    if (!this.trialState) {
      return { readable: false };
    }

    try {
      const stored = this.trialState.get<unknown>(
        REMOTE_ACCESS_TRIAL_START_KEY
      );
      return {
        readable: true,
        startedAt:
          typeof stored === "number" && Number.isFinite(stored) ? stored : null,
      };
    } catch {
      // A trial-state failure must not crash the extension. Fail closed for
      // remote reach while the free localhost product remains available.
      return { readable: false };
    }
  }

  private async writeRemoteAccessTrialStartedAt(): Promise<number | null> {
    if (!this.trialState) return null;
    try {
      const stored = this.trialState.get<unknown>(
        REMOTE_ACCESS_TRIAL_START_KEY
      );
      if (typeof stored === "number" && Number.isFinite(stored)) {
        return stored;
      }
      const startedAt = this.now();
      await this.trialState.update(REMOTE_ACCESS_TRIAL_START_KEY, startedAt);
      return startedAt;
    } catch {
      // A trial-state failure must not crash the extension or grant remote reach.
      return null;
    }
  }

  private async clearLocalActivation(): Promise<void> {
    await Promise.all([
      this.secretStore.delete(LICENSE_FILE_SECRET_KEY),
      this.secretStore.delete(LICENSE_KEY_SECRET_KEY),
      this.secretStore.delete(LICENSE_SOURCE_SECRET_KEY),
      this.secretStore.delete(LICENSE_ID_SECRET_KEY),
      this.secretStore.delete(LICENSE_MACHINE_ID_SECRET_KEY),
    ]);
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
  expectedIds: readonly string[]
): void {
  const relationship = asRecord(
    asRecord(data.relationships)?.[relationshipName]
  );
  const relationshipData = asRecord(relationship?.data);
  if (
    relationshipData &&
    !expectedIds.some((id) => id === relationshipData.id)
  ) {
    throw new UserFacingLicenseError(
      "That Pro license key belongs to a different ctrlyoke product or policy."
    );
  }
}

function toActivationError(
  error: unknown,
  licenseId?: string,
  validationCode?: string
): Error {
  if (error instanceof UserFacingLicenseError) {
    return error;
  }
  if (
    error instanceof KeygenApiError &&
    licenseId &&
    (error.code === LICENSE_VALIDATION_CODES.TOO_MANY_MACHINES ||
      error.code === LICENSE_VALIDATION_CODES.MACHINE_LIMIT_EXCEEDED ||
      (validationCode === LICENSE_VALIDATION_CODES.TOO_MANY_MACHINES &&
        error.status === 422))
  ) {
    return new LicenseActivationLimitError(licenseId);
  }
  if (
    error instanceof KeygenApiError &&
    [401, 403, 404, 409, 422].includes(error.status)
  ) {
    return new UserFacingLicenseError(
      "That Pro license key was rejected. It may be invalid, expired, suspended, or at its machine limit."
    );
  }
  return new UserFacingLicenseError(
    "ctrlyoke could not activate the Pro license right now. Check your internet connection and try again.",
    error
  );
}

function readKeygenCode(body: JsonApiResponse): string | undefined {
  const metaCode = asRecord(body.meta)?.code;
  if (typeof metaCode === "string") {
    return metaCode;
  }
  const errors = Array.isArray(body.errors) ? body.errors : [];
  const errorCode = asRecord(errors[0])?.code;
  return typeof errorCode === "string" ? errorCode : undefined;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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

/**
 * Built from the shared envelope constants so the extension and the
 * self-serve page in `landing/` can never disagree about what a signed
 * license file looks like.
 */
const LICENSE_CERTIFICATE_PATTERN = new RegExp(
  String.raw`^${LICENSE_CERTIFICATE_BEGIN}\n([\s\S]*?)\n${LICENSE_CERTIFICATE_END}$`
);

function parseCertificate(blob: string): LicenseCertificate {
  const normalized = blob.replace(/\r\n/g, "\n").trim();
  const match = normalized.match(LICENSE_CERTIFICATE_PATTERN);
  if (!match) {
    throw new Error("Invalid license certificate");
  }

  const payload = parseJson(decodeBase64(match[1].replace(/\s/g, "")));
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
    ...(tier === LICENSE_TIERS.PRO &&
    readPolicyId(payload) === KEYGEN_ENTERPRISE_POLICY_ID
      ? { isEnterprise: true }
      : {}),
  };
}

/** Reads the policy relationship id off a Keygen license resource payload. */
function readPolicyId(payload: JsonRecord): string | undefined {
  const data = payload.data;
  const resource = isRecord(data)
    ? data
    : Array.isArray(data) && isRecord(data[0])
      ? data[0]
      : undefined;
  const relationship = asRecord(asRecord(resource?.relationships)?.policy);
  const relationshipData = asRecord(relationship?.data);
  return typeof relationshipData?.id === "string"
    ? relationshipData.id
    : undefined;
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
