export interface SecretMetadata {
  description?: string;
  lastUpdated: number;
}

/** Parse the metadata shape used by SecretRegistryService. */
export function parseSecretMetadata(
  raw: string | undefined
): SecretMetadata | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<SecretMetadata>;
    return typeof parsed.lastUpdated === "number" &&
      Number.isFinite(parsed.lastUpdated)
      ? {
          lastUpdated: parsed.lastUpdated,
          ...(typeof parsed.description === "string" &&
          parsed.description.trim()
            ? { description: parsed.description }
            : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}
