export function keyValueMapObjectToString(
  value: Record<string, string> | undefined
): string {
  if (!value) return "";
  return Object.entries(value)
    .map(([key, entryValue]) => `${key}=${entryValue}`)
    .join("\n");
}

export function keyValueMapStringToObject(
  raw: string
): Record<string, string> | undefined {
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return undefined;

  const result: Record<string, string> = {};
  for (const line of lines) {
    const separatorIndex = line.indexOf("=");
    if (separatorIndex < 1) continue;
    result[line.slice(0, separatorIndex).trim()] = line.slice(
      separatorIndex + 1
    );
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

// Keep this aligned with SecretResolver.ts's SECRET_INTERPOLATION_PATTERN.
// Secret references resolve when embedded anywhere in a value, not only when
// they are the complete value.
const SECRET_INTERPOLATION_PATTERN = /\$\{secret:([^}]+)\}/;
const SENSITIVE_ENV_KEY_PATTERN =
  /(api|access|auth|credential|key|password|secret|token)/i;

/** Identify one map entry that looks like a pasted credential. */
export function looksLikeLiteralCredential(
  key: string,
  value: string
): boolean {
  const trimmed = value.trim();
  if (!trimmed || SECRET_INTERPOLATION_PATTERN.test(trimmed)) return false;
  return (
    (SENSITIVE_ENV_KEY_PATTERN.test(key) && trimmed.length >= 12) ||
    /^Bearer\s+\S{8,}$/i.test(trimmed) ||
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(trimmed) ||
    /^(?:sk-|ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}$/.test(
      trimmed
    )
  );
}

/** Identify map entries that look like pasted credentials rather than references. */
export function findLiteralCredentialEnvKeys(
  value: Record<string, string> | undefined
): string[] {
  if (!value) return [];
  return Object.entries(value)
    .filter(([key, entryValue]) => looksLikeLiteralCredential(key, entryValue))
    .map(([key]) => key);
}
