import type { ResolvedProperties } from "./ExecutionPropertyTypes";

/** Spawn-time properties that determine whether an existing process is reusable. */
export const SPAWN_IDENTITY_FIELDS = {
  HARNESS: "harness",
  MODEL: "model",
  TOOL_PERMISSIONS: "toolPermissions",
  HOOKS: "hooks",
  MCP_SERVERS: "mcpServers",
  ADDITIONAL_ARGS: "additionalArgs",
  SECRETS: "secrets",
  CTRLYOKE_MCP_MODE: "ctrlyokeMcpMode",
} as const;

export type SpawnIdentityField =
  (typeof SPAWN_IDENTITY_FIELDS)[keyof typeof SPAWN_IDENTITY_FIELDS];

function canonicalize(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalize(record[key]);
    }
    return sorted;
  }

  return value;
}

function canonicalSerialize(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Canonical serialization of each spawn-time field, keyed by field name. */
export function spawnIdentityFields(
  props: ResolvedProperties
): Record<SpawnIdentityField, string> {
  return {
    [SPAWN_IDENTITY_FIELDS.HARNESS]: canonicalSerialize(props.harness),
    [SPAWN_IDENTITY_FIELDS.MODEL]: canonicalSerialize(props.model),
    [SPAWN_IDENTITY_FIELDS.TOOL_PERMISSIONS]: canonicalSerialize(
      props.toolPermissions
    ),
    [SPAWN_IDENTITY_FIELDS.HOOKS]: canonicalSerialize(props.hooks),
    [SPAWN_IDENTITY_FIELDS.MCP_SERVERS]: canonicalSerialize(props.mcpServers),
    [SPAWN_IDENTITY_FIELDS.ADDITIONAL_ARGS]: canonicalSerialize(
      props.additionalArgs ?? ""
    ),
    [SPAWN_IDENTITY_FIELDS.SECRETS]: canonicalSerialize(props.secrets),
    [SPAWN_IDENTITY_FIELDS.CTRLYOKE_MCP_MODE]: canonicalSerialize(
      props.ctrlyokeMcpMode
    ),
  };
}

/** Stable cache-key fragment: the 64-bit FNV-1a digest of the field record. */
export function spawnIdentityHash(props: ResolvedProperties): string {
  const serialized = canonicalSerialize(spawnIdentityFields(props));
  const bytes = new TextEncoder().encode(serialized);
  const offsetBasis = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  let hash = offsetBasis;

  for (const byte of bytes) {
    hash = BigInt.asUintN(64, hash ^ BigInt(byte));
    hash = BigInt.asUintN(64, hash * prime);
  }

  return hash.toString(16).padStart(16, "0");
}
