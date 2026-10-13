/**
 * `server.publicHostname`: the name other devices use to reach the hosted
 * server from outside the local network (a dynamic DNS name, a Tailscale
 * MagicDNS name, or a public IPv4 address). It goes on the generated
 * certificate and is offered as a connection address for the link and QR code.
 *
 * Pure string logic with no Node imports, because the React settings page uses
 * it too.
 */

const HOSTNAME_LABEL = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?";

/**
 * Pattern for a non-empty hostname: dot-separated DNS labels, no scheme, port,
 * path, or trailing dot. `schemas/settings-schema.json` uses the same pattern
 * (plus an empty alternative); a unit test keeps the two in step.
 */
export const PUBLIC_HOSTNAME_PATTERN_SOURCE = `^${HOSTNAME_LABEL}(?:\\.${HOSTNAME_LABEL})*$`;

export const PUBLIC_HOSTNAME_MAX_LENGTH = 253;

const PUBLIC_HOSTNAME_PATTERN = new RegExp(PUBLIC_HOSTNAME_PATTERN_SOURCE);
const NUMERIC_HOST = /^[0-9.]+$/;

/** Whether `host` is a dotted-quad IPv4 address with every octet in range. */
export function isIpv4Literal(host: string): boolean {
  const octets = host.split(".");
  return (
    octets.length === 4 &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  );
}

/**
 * The trimmed, lower-cased hostname, or null when `value` is empty or not a
 * usable hostname. An all-numeric value must be a valid IPv4 address, so a
 * typo such as `192.168.1` is rejected instead of being treated as a DNS name.
 */
export function normalizePublicHostname(
  value: string | null | undefined
): string | null {
  const host = value?.trim().toLowerCase() ?? "";
  if (
    !host ||
    host.length > PUBLIC_HOSTNAME_MAX_LENGTH ||
    !PUBLIC_HOSTNAME_PATTERN.test(host)
  ) {
    return null;
  }
  if (NUMERIC_HOST.test(host) && !isIpv4Literal(host)) {
    return null;
  }
  return host;
}

/** `url` with its host replaced, or `url` unchanged when it can't be parsed. */
export function withUrlHostname(url: string, hostname: string): string {
  try {
    const parsed = new URL(url);
    parsed.hostname = hostname;
    return parsed.toString();
  } catch {
    return url;
  }
}
