import { SERVER_BIND_ADDRESSES } from "@root/types/DashboardConstants";

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  SERVER_BIND_ADDRESSES.LOCALHOST,
  "::1",
]);

/**
 * Whether a generated certificate covers the address phones connect to.
 * `address` is that address when it is known, or null when the server isn't
 * running and the certificate covers no network address at all.
 */
export type ServerCertLanCoverage =
  | { readonly covered: true }
  | { readonly covered: false; readonly address: string | null };

/**
 * Check a certificate's subject alternative names against a LAN-bound server.
 * A localhost-only certificate is correct for a localhost-bound server, so
 * only an all-interfaces bind can be uncovered. The certificate only gets the
 * computer's network addresses when it is generated after switching the bind
 * address, and goes stale if the computer's address changes later.
 */
export function getServerCertLanCoverage(
  bindAddress: string | undefined,
  certSans: readonly string[],
  connectAddress: string | null
): ServerCertLanCoverage {
  if (bindAddress !== SERVER_BIND_ADDRESSES.ALL_INTERFACES) {
    return { covered: true };
  }
  if (connectAddress) {
    return certSans.includes(connectAddress)
      ? { covered: true }
      : { covered: false, address: connectAddress };
  }
  return certSans.some((san) => !LOOPBACK_HOSTS.has(san))
    ? { covered: true }
    : { covered: false, address: null };
}
