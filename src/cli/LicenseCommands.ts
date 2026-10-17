import {
  LICENSE_SOURCES,
  LICENSE_TIERS,
  LicenseService,
  type LicenseSource,
} from "../license/LicenseService";
import {
  createNodeSecretStore,
  type NodeSecretStore,
} from "../platform/NodeSecretStore";
import type {
  LicenseActivateOptions,
  LicenseDeactivateOptions,
  LicenseStatusOptions,
} from "./LicenseCommandDefinitions";
import type { SecretCommandIo } from "./SecretCommands";

export const CLI_LICENSE_STATUS_JSON_SCHEMA_VERSION = 1;

/** Where this machine keeps its license. */
export const LICENSE_STORAGE_KINDS = {
  CREDENTIAL_STORE: "credential-store",
  FILE: "file",
} as const;

export type LicenseStorageKind =
  (typeof LICENSE_STORAGE_KINDS)[keyof typeof LICENSE_STORAGE_KINDS];

export interface CliLicenseStatus {
  schemaVersion: typeof CLI_LICENSE_STATUS_JSON_SCHEMA_VERSION;
  tier: (typeof LICENSE_TIERS)[keyof typeof LICENSE_TIERS];
  enterprise: boolean;
  licenseId: string | null;
  source: LicenseSource | null;
  /** ISO timestamp, or null for a free tier or a license that never expires. */
  expiresAt: string | null;
  /** A key is stored but its license did not verify (expired, revoked, damaged). */
  unverifiedKeyStored: boolean;
  storage: { kind: LicenseStorageKind; path: string | null };
}

export type CliLicenseService = Pick<
  LicenseService,
  "getEntitlement" | "getStoredLicenseKey" | "activateWithKey" | "deactivate"
>;

export interface LicenseCommandDependencies {
  secretStore: NodeSecretStore;
  licenseService: CliLicenseService;
  dispose(): void;
}

/** The same store `ctrlyoke server` reads, so an activation here is the server's. */
export function createCliLicenseCommandDependencies(): LicenseCommandDependencies {
  const secretStore = createNodeSecretStore({
    warn: (message) => console.error(message),
  });
  const licenseService = new LicenseService(secretStore);
  return {
    secretStore,
    licenseService,
    dispose: () => licenseService.dispose(),
  };
}

export async function buildLicenseStatus(
  dependencies: LicenseCommandDependencies
): Promise<CliLicenseStatus> {
  const { licenseService, secretStore } = dependencies;
  // Read the key first: unlike getEntitlement, it surfaces a store that
  // cannot be read instead of reporting Free.
  const storedKey = await licenseService.getStoredLicenseKey();
  const entitlement = await licenseService.getEntitlement();
  const isPro = entitlement.tier === LICENSE_TIERS.PRO;
  return {
    schemaVersion: CLI_LICENSE_STATUS_JSON_SCHEMA_VERSION,
    tier: entitlement.tier,
    enterprise: entitlement.isEnterprise === true,
    licenseId: entitlement.licenseId ?? null,
    source: entitlement.source ?? null,
    expiresAt:
      entitlement.expiresAt === null
        ? null
        : new Date(entitlement.expiresAt).toISOString(),
    unverifiedKeyStored: !isPro && storedKey !== undefined,
    storage: secretStore.isUsingFallback
      ? {
          kind: LICENSE_STORAGE_KINDS.FILE,
          path: secretStore.fileStore.filePath,
        }
      : { kind: LICENSE_STORAGE_KINDS.CREDENTIAL_STORE, path: null },
  };
}

const SOURCE_LABELS: Record<LicenseSource, string> = {
  [LICENSE_SOURCES.ONLINE]: "online activation",
  [LICENSE_SOURCES.OFFLINE_FILE]: "offline license file",
};

export function formatLicenseStatus(status: CliLicenseStatus): string {
  const tier =
    status.tier === LICENSE_TIERS.PRO
      ? status.enterprise
        ? "Pro (Enterprise)"
        : "Pro"
      : "Free";
  const lines = [`Tier:       ${tier}`];
  if (status.licenseId) lines.push(`License:    ${status.licenseId}`);
  if (status.source) lines.push(`Source:     ${SOURCE_LABELS[status.source]}`);
  if (status.tier === LICENSE_TIERS.PRO) {
    lines.push(`Expires:    ${status.expiresAt ?? "never"}`);
  }
  lines.push(
    `Stored in:  ${
      status.storage.path
        ? `${status.storage.path} (unencrypted; no OS credential store)`
        : "OS credential store"
    }`
  );
  if (status.unverifiedKeyStored) {
    lines.push(
      "",
      "A license key is stored, but its license did not verify. Run `ctrlyoke license activate` to activate it again."
    );
  }
  return lines.join("\n");
}

export async function licenseStatusCommand(
  options: LicenseStatusOptions,
  dependencies: LicenseCommandDependencies,
  io: Pick<SecretCommandIo, "writeOut">
): Promise<void> {
  const status = await buildLicenseStatus(dependencies);
  io.writeOut(
    options.json ? JSON.stringify(status) : formatLicenseStatus(status)
  );
}

export async function activateLicenseCommand(
  options: LicenseActivateOptions,
  dependencies: LicenseCommandDependencies,
  io: SecretCommandIo
): Promise<void> {
  let key: string;
  if (options.stdin) {
    key = await io.readStdin();
  } else if (io.isInteractive) {
    key = await io.readHidden("License key: ");
  } else {
    throw new Error(
      "No TTY is available; use --stdin to provide the license key."
    );
  }
  // activateWithKey rejects an empty key with its own message.
  const entitlement = await dependencies.licenseService.activateWithKey(key);
  io.writeOut(
    `Activated ctrlyoke Pro on this machine${
      entitlement.licenseId ? ` (license ${entitlement.licenseId})` : ""
    }.`
  );
}

export async function deactivateLicenseCommand(
  options: LicenseDeactivateOptions,
  dependencies: LicenseCommandDependencies,
  io: SecretCommandIo
): Promise<void> {
  const { licenseService } = dependencies;
  const [storedKey, entitlement] = await Promise.all([
    licenseService.getStoredLicenseKey(),
    licenseService.getEntitlement(),
  ]);
  if (storedKey === undefined && entitlement.tier !== LICENSE_TIERS.PRO) {
    io.writeOut("No Pro license is active on this machine.");
    return;
  }
  const confirmed =
    options.yes === true ||
    (io.isInteractive &&
      (await io.confirm(
        "Deactivate ctrlyoke Pro on this machine? ctrlyoke server loses remote access. [y/N] "
      )));
  if (!confirmed) {
    io.writeOut("Dry run only; pass --yes to deactivate.");
    return;
  }
  await licenseService.deactivate();
  io.writeOut(
    "Deactivated this machine and removed the stored license. ctrlyoke is on the Free tier."
  );
}
