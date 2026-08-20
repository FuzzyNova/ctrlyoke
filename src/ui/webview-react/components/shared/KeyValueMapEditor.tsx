import { useEffect, useMemo, useState } from "react";
import { SETTING_SCOPES } from "@root/types/DashboardConstants";
import {
  useSecretRegistryStore,
  type SecretRegistryState,
} from "@store/secretRegistryStore";

export interface KeyValueMapEditorProps {
  label: string;
  id?: string;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  ariaLabel?: string;
  disabled?: boolean;
  allowSecretReferences?: boolean;
  rows?: number;
}

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

const SECRET_REFERENCE_PATTERN = /^\$\{secret:[A-Z][A-Z0-9_]*\}$/;
const SENSITIVE_ENV_KEY_PATTERN =
  /(api|access|auth|credential|key|password|secret|token)/i;

/** Identify map entries that look like pasted credentials rather than references. */
export function findLiteralCredentialEnvKeys(
  value: Record<string, string> | undefined
): string[] {
  if (!value) return [];
  return Object.entries(value)
    .filter(([key, entryValue]) => {
      const trimmed = entryValue.trim();
      if (!trimmed || SECRET_REFERENCE_PATTERN.test(trimmed)) return false;
      return (
        (SENSITIVE_ENV_KEY_PATTERN.test(key) && trimmed.length >= 12) ||
        /^Bearer\s+\S{8,}$/i.test(trimmed) ||
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i.test(trimmed) ||
        /^(?:sk-|ghp_|github_pat_|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}$/.test(
          trimmed
        )
      );
    })
    .map(([key]) => key);
}

function getSecretNames(
  entriesByScope: SecretRegistryState["entriesByScope"]
): string[] {
  return [
    ...new Set([
      ...entriesByScope[SETTING_SCOPES.USER].map((entry) => entry.name),
      ...entriesByScope[SETTING_SCOPES.WORKSPACE].map((entry) => entry.name),
    ]),
  ].sort();
}

export function KeyValueMapEditor({
  label,
  id,
  value,
  onChange,
  ariaLabel = label,
  disabled = false,
  allowSecretReferences = false,
  rows = 3,
}: KeyValueMapEditorProps) {
  const [rawValue, setRawValue] = useState(() =>
    keyValueMapObjectToString(value)
  );
  const entriesByScope = useSecretRegistryStore(
    (state) => state.entriesByScope
  );
  const requestSecretEntries = useSecretRegistryStore(
    (state) => state.requestEntries
  );

  useEffect(() => {
    setRawValue(keyValueMapObjectToString(value));
  }, [value]);

  useEffect(() => {
    if (!allowSecretReferences) return;
    requestSecretEntries(SETTING_SCOPES.USER);
    requestSecretEntries(SETTING_SCOPES.WORKSPACE);
  }, [allowSecretReferences, requestSecretEntries]);

  const secretNames = useMemo(
    () => (allowSecretReferences ? getSecretNames(entriesByScope) : []),
    [allowSecretReferences, entriesByScope]
  );
  const literalCredentialKeys = allowSecretReferences
    ? findLiteralCredentialEnvKeys(keyValueMapStringToObject(rawValue))
    : [];

  const handleChange = (nextRawValue: string) => {
    setRawValue(nextRawValue);
    onChange(keyValueMapStringToObject(nextRawValue) ?? {});
  };

  const insertSecretReference = (name: string) => {
    if (!name) return;
    const reference = `\${secret:${name}}`;
    const line = `${name}=${reference}`;
    handleChange(rawValue.trim() ? `${rawValue}\n${line}` : line);
  };

  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xxs text-description-fg">{label}</span>
      <textarea
        id={id}
        aria-label={ariaLabel}
        placeholder="KEY=value\nANOTHER_KEY=value"
        value={rawValue}
        onChange={(event) => handleChange(event.target.value)}
        disabled={disabled}
        rows={rows}
        className="w-full resize-none rounded border border-input-border bg-input-bg px-2 py-1 font-mono text-xs text-input-fg focus:border-focus-border focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
      />
      {allowSecretReferences && secretNames.length > 0 && (
        <select
          aria-label="Insert secret reference"
          value=""
          onChange={(event) => insertSecretReference(event.target.value)}
          disabled={disabled}
          className="w-full rounded border border-input-border bg-input-bg px-2 py-1 text-xxs text-input-fg focus:border-focus-border focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        >
          <option value="">Insert secret reference…</option>
          {secretNames.map((name) => (
            <option key={name} value={name}>
              {name} → $&#123;secret:{name}&#125;
            </option>
          ))}
        </select>
      )}
      {allowSecretReferences && literalCredentialKeys.length > 0 && (
        <p
          className="flex items-start gap-1 text-xxs text-warning-fg"
          role="alert"
        >
          <i className="codicon codicon-warning mt-px" aria-hidden="true" />
          <span>
            {literalCredentialKeys.join(", ")} looks like a pasted credential.
            Use the secret picker so the value is resolved at run time.
          </span>
        </p>
      )}
    </div>
  );
}
