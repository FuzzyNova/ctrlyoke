/**
 * Where a license came from. Kept apart from `LicenseService.ts`, which needs
 * Node's crypto, so the dashboard can read it.
 */

/** The source determines whether a license file's TTL is enforced locally. */
export const LICENSE_SOURCES = {
  ONLINE: "online",
  OFFLINE_FILE: "offline-file",
} as const;

export type LicenseSource =
  (typeof LICENSE_SOURCES)[keyof typeof LICENSE_SOURCES];
