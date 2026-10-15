const ANSI_ESCAPE_SEQUENCE_PATTERN =
  /\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\n]*?(?:\x07|\x1B\\|\x9C)|[ -/]*[0-~])/g;
const MAX_PENDING_ESCAPE_LENGTH = 4_096;
// Single-pass replacement for the three line-ending/control-char cleanup
// steps that used to be sequential .replace() calls, each of which rescans
// the whole string. \r\n is listed before the lone \r alternative so the
// alternation still collapses a CRLF pair to one \n instead of leaving a
// stray \n behind; \x0D is intentionally absent from the character class
// below since it is already handled by the first two alternatives.
const CRLF_CR_OR_CONTROL_PATTERN = /\r\n|\r|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/**
 * Remove ANSI escape sequences from terminal output.
 */
export function stripAnsiCodes(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }

  return text.replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "");
}

/**
 * Bounded cache of sanitizeTerminalOutput() results, keyed by the raw input
 * string.
 *
 * The same raw command/output/error text for one visible dashboard row is
 * independently re-sanitized in several places — row-height estimation,
 * find-in-page search indexing, and the row's own render — every time any of
 * them runs, even though the underlying string never changes until the step
 * re-runs. Caching by input string turns all but the first of those calls
 * into a Map lookup instead of a fresh multi-pass regex scan.
 *
 * Bounded (LRU by insertion order) and size-gated because this module is
 * also used on the Node/extension-host side to sanitize streaming script
 * output, where each chunk is typically unique — caching those would only
 * hold extra strings in memory for no reuse benefit. `MAX_CACHEABLE_LENGTH`
 * keeps large one-off blobs (e.g. accumulated stdout) out of the cache
 * entirely, and `MAX_CACHE_ENTRIES` bounds the rest.
 */
const MAX_CACHE_ENTRIES = 300;
const MAX_CACHEABLE_LENGTH = 50_000;
const sanitizedCache = new Map<string, string>();

function getCachedSanitized(text: string): string | undefined {
  const cached = sanitizedCache.get(text);
  if (cached === undefined) {
    return undefined;
  }
  // Re-insert so the most recently used entries are evicted last.
  sanitizedCache.delete(text);
  sanitizedCache.set(text, cached);
  return cached;
}

function setCachedSanitized(text: string, sanitized: string): void {
  sanitizedCache.set(text, sanitized);
  if (sanitizedCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = sanitizedCache.keys().next().value;
    if (oldestKey !== undefined) {
      sanitizedCache.delete(oldestKey);
    }
  }
}

/** Test-only seam for verifying eviction/bounding behavior. */
export function clearSanitizeTerminalOutputCacheForTests(): void {
  sanitizedCache.clear();
}

/**
 * Normalize terminal output for logs and UI rendering.
 * Keeps line feeds and tabs, but removes ANSI/control bytes that render as
 * unreadable glyphs in the dashboard.
 */
export function sanitizeTerminalOutput(text: string): string {
  if (typeof text !== "string" || text.length === 0) {
    return "";
  }

  const isCacheable = text.length <= MAX_CACHEABLE_LENGTH;
  if (isCacheable) {
    const cached = getCachedSanitized(text);
    if (cached !== undefined) {
      return cached;
    }
  }

  const sanitized = stripAnsiCodes(text).replace(
    CRLF_CR_OR_CONTROL_PATTERN,
    (match) => (match === "\r\n" ? "\n" : "")
  );

  if (isCacheable) {
    setCachedSanitized(text, sanitized);
  }
  return sanitized;
}

/**
 * Incrementally sanitize a terminal stream without losing escape sequences
 * that are split across chunk boundaries.
 */
export class TerminalOutputSanitizer {
  private pendingEscape = "";

  /** Sanitize the complete prefix of a chunk, retaining a partial escape. */
  push(chunk: string): string {
    if (typeof chunk !== "string" || chunk.length === 0) {
      return "";
    }

    const pendingEscape = this.pendingEscape;
    let input = pendingEscape + chunk;
    this.pendingEscape = "";
    let incompleteStart = findTrailingIncompleteEscape(input);
    if (
      incompleteStart >= 0 &&
      // Only an OSC that began in the buffered text is stale; one that starts
      // inside this chunk is handled by the loop below, and slicing here would
      // emit part of the chunk twice.
      incompleteStart < pendingEscape.length &&
      input.startsWith("\x1B]", incompleteStart) &&
      input.slice(incompleteStart).includes("\n") &&
      pendingEscape.length > 0 &&
      chunk.includes("\n")
    ) {
      // The OSC began in an earlier chunk. Its buffered control payload is
      // stale; release the newly arrived line instead of swallowing it.
      input = input.slice(0, incompleteStart) + chunk;
      incompleteStart = findTrailingIncompleteEscape(input);
    }
    while (
      incompleteStart >= 0 &&
      input.startsWith("\x1B]", incompleteStart) &&
      (input.length - incompleteStart > MAX_PENDING_ESCAPE_LENGTH ||
        input.slice(incompleteStart).includes("\n"))
    ) {
      // A real OSC title or hyperlink fits comfortably under this bound. If
      // it does not terminate in time, drop its introducer and resume normal
      // sanitization so one malformed sequence cannot stall the stream.
      input =
        input.slice(0, incompleteStart) + input.slice(incompleteStart + 2);
      incompleteStart = findTrailingIncompleteEscape(input);
    }
    const completePrefix =
      incompleteStart >= 0 ? input.slice(0, incompleteStart) : input;
    if (incompleteStart >= 0) {
      this.pendingEscape = input.slice(incompleteStart);
    }
    return sanitizeTerminalOutput(completePrefix);
  }

  /** Discard any incomplete trailing sequence when the stream ends. */
  flush(): string {
    this.pendingEscape = "";
    // The retained suffix is known to be an unfinished terminal control
    // sequence; exposing its printable-looking payload (for example `[39m`)
    // would recreate the corruption this incremental path avoids.
    return "";
  }
}

function findTrailingIncompleteEscape(text: string): number {
  let escapeIndex = text.indexOf("\x1B");
  while (escapeIndex >= 0) {
    const suffix = text.slice(escapeIndex);
    if (isIncompleteEscape(suffix)) {
      return escapeIndex;
    }
    escapeIndex = text.indexOf("\x1B", escapeIndex + 1);
  }
  return -1;
}

function isIncompleteEscape(suffix: string): boolean {
  if (suffix.length === 1) {
    return true;
  }

  if (suffix.startsWith("\x1B[")) {
    const body = suffix.slice(2);
    if (/^[0-?]*[ -/]*$/.test(body)) {
      return true;
    }
    return false;
  }

  if (suffix.startsWith("\x1B]")) {
    return !/(?:\x07|\x1B\\|\x9C)/.test(suffix.slice(2));
  }

  if (/^\x1B[ -\/]+$/.test(suffix)) {
    return true;
  }

  return false;
}
