import { isIP } from "net";

/**
 * Returns whether an address identifies the local machine only.
 *
 * Bind addresses may be written as a hostname, IPv4, or IPv6 literal. Keep
 * this check in one place because both the settings write gate and the actual
 * server listen gate must agree about which values are safe to expose.
 */
export function isLoopbackBindAddress(bindAddress: string): boolean {
  const normalized = bindAddress.trim().toLowerCase();
  if (normalized === "localhost" || normalized === "localhost.") {
    return true;
  }

  const address = normalized.replace(/^\[|\]$/g, "");
  const zoneIndex = address.indexOf("%");
  const addressWithoutZone =
    zoneIndex >= 0 ? address.slice(0, zoneIndex) : address;

  if (isIP(addressWithoutZone) === 4) {
    const octets = addressWithoutZone.split(".").map(Number);
    return (
      octets.length === 4 &&
      octets[0] === 127 &&
      octets.every(
        (octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255
      )
    );
  }

  if (isIP(addressWithoutZone) !== 6) {
    return false;
  }

  const groups = expandIpv6Groups(addressWithoutZone);
  return (
    groups !== undefined &&
    groups.slice(0, 7).every((group) => group === 0) &&
    groups[7] === 1
  );
}

/** Returns whether a socket peer address is the current machine. */
export function isLoopbackClientAddress(
  remoteAddress: string | undefined
): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.trim().toLowerCase();
  const mappedIpv4 = normalized.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  return isLoopbackBindAddress(mappedIpv4?.[1] ?? normalized);
}

function expandIpv6Groups(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;

  const parseHalf = (half: string): number[] | undefined => {
    if (!half) return [];
    const groups = half.split(":");
    const parsed: number[] = [];
    for (const group of groups) {
      if (group.includes(".")) {
        const octets = group.split(".").map(Number);
        if (
          octets.length !== 4 ||
          octets.some(
            (octet) => !Number.isInteger(octet) || octet < 0 || octet > 255
          )
        ) {
          return undefined;
        }
        parsed.push((octets[0] << 8) | octets[1]);
        parsed.push((octets[2] << 8) | octets[3]);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
      parsed.push(Number.parseInt(group, 16));
    }
    return parsed;
  };

  const left = parseHalf(halves[0]);
  const right = parseHalf(halves[1] ?? "");
  if (!left || !right) return undefined;

  if (halves.length === 1) {
    return left.length === 8 ? left : undefined;
  }

  const zeroCount = 8 - left.length - right.length;
  return zeroCount > 0 && zeroCount + left.length + right.length === 8
    ? [...left, ...Array<number>(zeroCount).fill(0), ...right]
    : undefined;
}
