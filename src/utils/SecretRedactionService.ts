import { REDACTION_MARKER, redactPreviewText } from "../types/PreviewRedactor";
import { ConfigurationUtils } from "./ConfigurationUtils";

/** A run-owned collection of values that must never cross an output boundary. */
export class RunSecretRedactor {
  private readonly exactSecrets = new Set<string>();

  addResolvedValues(values: Readonly<Record<string, string>>): void {
    for (const value of Object.values(values)) {
      for (const candidate of deterministicSecretRepresentations(value)) {
        if (candidate.length > 0) {
          this.exactSecrets.add(candidate);
        }
      }
    }
  }

  clear(): void {
    this.exactSecrets.clear();
  }

  getExactSecrets(): readonly string[] {
    return [...this.exactSecrets];
  }
}

/**
 * Process-wide output boundary used by extension, CLI, and hosted transports.
 * Active runs register their redactors only for the duration of execution.
 */
export class SecretRedactionService {
  private readonly activeRuns = new Set<RunSecretRedactor>();
  private readonly protectedValues = new Set<string>();

  register(redactor: RunSecretRedactor): () => void {
    this.activeRuns.add(redactor);
    return () => {
      this.activeRuns.delete(redactor);
      redactor.clear();
    };
  }

  /**
   * Exempt a value from redaction — e.g. the hosted server's own connection
   * token, which legitimately appears shaped like `token=<hex>` in URLs
   * ctrlyoke generates itself (the manifest link, the settings "copy URL"
   * button). Those are not leaked user credentials; the client needs the
   * value verbatim to keep using the app. This is independent from
   * `RunSecretRedactor` (actual resolved managed-secret values) — a value
   * would only ever land in both sets by coincidence.
   */
  protectValue(value: string): () => void {
    if (value.length > 0) {
      this.protectedValues.add(value);
    }
    return () => this.protectedValues.delete(value);
  }

  redactText(text: string): string {
    const exactSecrets = new Set<string>();
    for (const redactor of this.activeRuns) {
      for (const secret of redactor.getExactSecrets()) {
        exactSecrets.add(secret);
      }
    }
    return redactPreviewText(
      text,
      [],
      [...exactSecrets],
      [...this.protectedValues],
      ConfigurationUtils.isHeuristicSecretRedactionEnabled()
    ).text;
  }

  /** Redact a transport/persistence DTO without mutating the caller's object. */
  redactValue<T>(value: T): T {
    return this.redactValueInternal(value, new WeakMap<object, unknown>()) as T;
  }

  private redactValueInternal(
    value: unknown,
    seen: WeakMap<object, unknown>
  ): unknown {
    if (typeof value === "string") {
      return this.redactText(value);
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    if (seen.has(value)) {
      return seen.get(value);
    }
    if (value instanceof Date || value instanceof RegExp) {
      return value;
    }
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      seen.set(value, result);
      for (const item of value) {
        result.push(this.redactValueInternal(item, seen));
      }
      return result;
    }

    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const [key, item] of Object.entries(value)) {
      result[key] = this.redactValueInternal(item, seen);
    }
    return result;
  }
}

export const secretRedactionService = new SecretRedactionService();

/**
 * JSON escaping is deterministic and commonly appears when a CLI echoes a
 * generated config. The raw value itself is also retained by this list so
 * ordinary quoted/shell forms are covered by the same exact matcher.
 */
function deterministicSecretRepresentations(value: string): string[] {
  const escaped = JSON.stringify(value);
  return [value, escaped && escaped.length >= 2 ? escaped.slice(1, -1) : value];
}

export { REDACTION_MARKER };
