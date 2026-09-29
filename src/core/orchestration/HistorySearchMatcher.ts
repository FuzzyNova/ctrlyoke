import * as fs from "fs";
import * as path from "path";
import { Worker } from "worker_threads";

export interface HistorySearchMatch {
  index: number;
  length: number;
}

export interface HistorySearchMatcher {
  /**
   * Synchronous, in-process match. For a regex this is **unbounded** — it is
   * the catastrophic-backtracking hazard the worker exists to contain — so
   * only the matcher worker (which is terminatable) and tests may call it
   * directly. Every production match site goes through
   * `findHistorySearchMatch` instead.
   */
  find(text: string): HistorySearchMatch | undefined;
  /**
   * Required, not optional: an implementation without it would silently fall
   * back to the unbounded `find` above and reinstate the extension-host hang
   * this design removes. A matcher that needs no worker resolves immediately.
   */
  findAsync(
    text: string,
    signal?: AbortSignal
  ): Promise<HistorySearchMatch | undefined>;
  /** A conservative literal required in every possible match, if one exists. */
  readonly requiredLiteral?: string;
  dispose?(): void;
}

export class InvalidHistorySearchPatternError extends Error {
  readonly pattern: string;

  constructor(pattern: string, cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(
      `Invalid history search pattern ${JSON.stringify(pattern)}: ${message}`
    );
    this.name = "InvalidHistorySearchPatternError";
    this.pattern = pattern;
  }
}

export class HistorySearchRegexTimeoutError extends Error {
  readonly pattern: string;

  constructor(pattern: string) {
    super(
      `History search regex evaluation exceeded ${REGEX_MATCH_TIMEOUT_MS}ms for ${JSON.stringify(pattern)}`
    );
    this.name = "HistorySearchRegexTimeoutError";
    this.pattern = pattern;
  }
}

export class HistorySearchMatcherCancelledError extends Error {
  constructor() {
    super("History search regex evaluation was cancelled");
    this.name = "HistorySearchMatcherCancelledError";
  }
}

export const REGEX_MATCH_TIMEOUT_MS = 1000;

export const HISTORY_SEARCH_MATCHER_MESSAGE_TYPES = {
  INIT: "init",
  READY: "ready",
  CANDIDATE: "candidate",
  RESULT: "result",
  END: "end",
  ERROR: "error",
} as const;

export interface HistorySearchMatcherInitMessage {
  type: typeof HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.INIT;
  pattern: string;
}

export interface HistorySearchMatcherCandidateMessage {
  type: typeof HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.CANDIDATE;
  requestId: number;
  text: string;
}

export interface HistorySearchMatcherResultMessage {
  type: typeof HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.RESULT;
  requestId: number;
  match?: HistorySearchMatch;
}

export interface HistorySearchMatcherReadyMessage {
  type: typeof HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.READY;
}

export interface HistorySearchMatcherErrorMessage {
  type: typeof HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.ERROR;
  message: string;
}

export type HistorySearchMatcherWorkerMessage =
  | HistorySearchMatcherInitMessage
  | HistorySearchMatcherCandidateMessage
  | HistorySearchMatcherReadyMessage
  | HistorySearchMatcherResultMessage
  | HistorySearchMatcherErrorMessage
  | { type: typeof HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.END };

interface PendingMatch {
  resolve: (match: HistorySearchMatch | undefined) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
  removeAbortListener?: () => void;
}

class HistorySearchMatcherWorkerClient {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private nextRequestId = 1;
  private pending?: PendingMatch;
  private disposed = false;

  constructor(private readonly pattern: string) {
    this.worker = new Worker(getMatcherWorkerScriptPath());
    this.ready = new Promise<void>((resolve, reject) => {
      const onMessage = (message: HistorySearchMatcherWorkerMessage): void => {
        if (message.type === HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.READY) {
          cleanup();
          resolve();
        } else if (
          message.type === HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.ERROR
        ) {
          cleanup();
          reject(
            new InvalidHistorySearchPatternError(this.pattern, message.message)
          );
        }
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onExit = (code: number): void => {
        if (code !== 0) {
          cleanup();
          reject(
            new Error(`History search matcher worker exited with code ${code}`)
          );
        }
      };
      const cleanup = (): void => {
        this.worker.off("message", onMessage);
        this.worker.off("error", onError);
        this.worker.off("exit", onExit);
      };
      this.worker.on("message", onMessage);
      this.worker.once("error", onError);
      this.worker.once("exit", onExit);
      this.worker.postMessage({
        type: HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.INIT,
        pattern: this.pattern,
      } satisfies HistorySearchMatcherInitMessage);
    });

    this.worker.on("message", (message: HistorySearchMatcherWorkerMessage) => {
      if (message.type !== HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.RESULT) {
        return;
      }
      if (message.requestId !== this.nextRequestId - 1 || !this.pending) {
        return;
      }
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.resolve(message.match);
    });
  }

  async find(
    text: string,
    signal?: AbortSignal
  ): Promise<HistorySearchMatch | undefined> {
    if (this.disposed) {
      throw new Error("History search matcher worker is disposed");
    }
    if (signal?.aborted) {
      throw new HistorySearchMatcherCancelledError();
    }
    await this.ready;
    if (signal?.aborted) {
      throw new HistorySearchMatcherCancelledError();
    }

    const requestId = this.nextRequestId++;
    return new Promise<HistorySearchMatch | undefined>((resolve, reject) => {
      let pending!: PendingMatch;
      const timer = setTimeout(() => {
        if (this.pending !== pending) {
          return;
        }
        this.pending = undefined;
        pending.removeAbortListener?.();
        void this.worker.terminate();
        reject(new HistorySearchRegexTimeoutError(this.pattern));
      }, REGEX_MATCH_TIMEOUT_MS);
      pending = { resolve, reject, timer };
      if (signal) {
        const onAbort = (): void => {
          if (this.pending !== pending) {
            return;
          }
          this.pending = undefined;
          clearTimeout(timer);
          void this.worker.terminate();
          reject(new HistorySearchMatcherCancelledError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.removeAbortListener = () =>
          signal.removeEventListener("abort", onAbort);
      }
      this.pending = pending;
      this.worker.postMessage({
        type: HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.CANDIDATE,
        requestId,
        text,
      } satisfies HistorySearchMatcherCandidateMessage);
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timer);
      pending.removeAbortListener?.();
      pending.reject(new HistorySearchMatcherCancelledError());
    }
    this.worker.postMessage({ type: HISTORY_SEARCH_MATCHER_MESSAGE_TYPES.END });
    void this.worker.terminate();
  }
}

export class SubstringHistorySearchMatcher implements HistorySearchMatcher {
  readonly requiredLiteral: string;
  private readonly loweredQuery: string;

  constructor(query: string) {
    this.requiredLiteral = query;
    this.loweredQuery = query.toLowerCase();
  }

  find(text: string): HistorySearchMatch | undefined {
    const loweredText = text.toLowerCase();
    const index = loweredText.indexOf(this.loweredQuery);
    if (index === -1) {
      return undefined;
    }
    if (this.loweredQuery.length === 0) {
      return { index: 0, length: 0 };
    }
    if (
      loweredText.length === text.length &&
      this.loweredQuery.length === this.requiredLiteral.length
    ) {
      return { index, length: this.requiredLiteral.length };
    }

    const originalStarts: number[] = [];
    const originalEnds: number[] = [];
    for (let originalIndex = 0; originalIndex < text.length;) {
      const codePoint = text.codePointAt(originalIndex);
      if (codePoint === undefined) break;
      const originalCharacter = String.fromCodePoint(codePoint);
      const loweredLength = originalCharacter.toLowerCase().length;
      const originalEnd = originalIndex + originalCharacter.length;
      for (let offset = 0; offset < loweredLength; offset += 1) {
        originalStarts.push(originalIndex);
        originalEnds.push(originalEnd);
      }
      originalIndex = originalEnd;
    }

    const originalStart = originalStarts[index];
    const originalEnd = originalEnds[index + this.loweredQuery.length - 1];
    if (originalStart === undefined || originalEnd === undefined) {
      return undefined;
    }
    return { index: originalStart, length: originalEnd - originalStart };
  }

  findAsync(
    text: string,
    signal?: AbortSignal
  ): Promise<HistorySearchMatch | undefined> {
    if (signal?.aborted) {
      return Promise.reject(new HistorySearchMatcherCancelledError());
    }
    return Promise.resolve(this.find(text));
  }

  dispose(): void {}
}

export class RegexHistorySearchMatcher implements HistorySearchMatcher {
  readonly requiredLiteral?: string;
  private readonly expression: RegExp;
  private workerClient?: HistorySearchMatcherWorkerClient;

  constructor(readonly pattern: string) {
    try {
      this.expression = new RegExp(pattern, "i");
    } catch (error) {
      throw new InvalidHistorySearchPatternError(pattern, error);
    }
    this.requiredLiteral = extractRequiredLiteral(pattern);
  }

  /**
   * Runs the pattern on the calling thread with no time bound. This is the
   * hang this whole design exists to prevent, so it is reachable only from
   * inside `historySearchMatcherWorker` — which the parent can terminate —
   * and from tests. Production callers use `findHistorySearchMatch`.
   */
  find(text: string): HistorySearchMatch | undefined {
    this.expression.lastIndex = 0;
    const match = this.expression.exec(text);
    return match?.index === undefined
      ? undefined
      : { index: match.index, length: match[0].length };
  }

  findAsync(
    text: string,
    signal?: AbortSignal
  ): Promise<HistorySearchMatch | undefined> {
    this.workerClient ??= new HistorySearchMatcherWorkerClient(this.pattern);
    return this.workerClient.find(text, signal);
  }

  dispose(): void {
    this.workerClient?.dispose();
    this.workerClient = undefined;
  }
}

export function createHistorySearchMatcher(
  query: string,
  regex: boolean
): HistorySearchMatcher {
  return regex
    ? new RegexHistorySearchMatcher(query)
    : new SubstringHistorySearchMatcher(query);
}

/**
 * The only sanctioned match entry point for production code. It always takes
 * the bounded path, so a regex can never be evaluated on the calling thread.
 */
export function findHistorySearchMatch(
  matcher: HistorySearchMatcher,
  text: string,
  signal?: AbortSignal
): Promise<HistorySearchMatch | undefined> {
  return matcher.findAsync(text, signal);
}

export function disposeHistorySearchMatcher(
  matcher: HistorySearchMatcher
): void {
  matcher.dispose?.();
}

function getMatcherWorkerScriptPath(): string {
  const candidates = [
    path.join(__dirname, "..", "..", "historySearchMatcherWorker.js"),
    path.join(__dirname, "historySearchMatcherWorker.js"),
  ];
  const workerPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!workerPath) {
    throw new Error(
      `Unable to locate compiled history search matcher worker; checked ${candidates.join(", ")}`
    );
  }
  return workerPath;
}

interface LiteralAnalysis {
  required: string[];
  canBeEmpty: boolean;
}

interface RegexNodeAnalysis {
  analysis: LiteralAnalysis;
  index: number;
  /** Whether the node consumes exactly its single required literal. */
  isExactLiteral: boolean;
}

function extractRequiredLiteral(pattern: string): string | undefined {
  const analysis = analyzeAlternation(pattern, 0, pattern.length).analysis;
  return analysis.required
    .filter((literal) => literal.length > 0)
    .sort((left, right) => right.length - left.length)[0];
}

function analyzeAlternation(
  source: string,
  start: number,
  end: number
): { analysis: LiteralAnalysis; index: number } {
  const branches: LiteralAnalysis[] = [];
  let branchStart = start;
  let index = start;
  let depth = 0;
  while (index < end) {
    const character = source[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "[") {
      index = skipCharacterClass(source, index, end);
      continue;
    }
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      if (depth === 0) break;
      depth -= 1;
    } else if (character === "|" && depth === 0) {
      branches.push(analyzeSequence(source, branchStart, index));
      branchStart = index + 1;
    }
    index += 1;
  }
  branches.push(analyzeSequence(source, branchStart, index));
  return { analysis: combineAlternatives(branches), index };
}

function analyzeSequence(
  source: string,
  start: number,
  end: number
): LiteralAnalysis {
  const required: string[] = [];
  let adjacentLiteral: string | undefined;
  let canBeEmpty = true;
  let index = start;
  while (index < end) {
    if (source[index] === "|") break;
    const node = analyzeNode(source, index, end);
    index = node.index;
    const quantifier = readQuantifier(source, index, end);
    index = quantifier.index;
    if (quantifier.minimum === 0) {
      if (adjacentLiteral !== undefined) {
        required.push(adjacentLiteral);
        adjacentLiteral = undefined;
      }
      continue;
    }
    if (!quantifier.exactlyOne) {
      if (adjacentLiteral !== undefined) {
        required.push(adjacentLiteral);
        adjacentLiteral = undefined;
      }
      required.push(...node.analysis.required);
    } else if (node.isExactLiteral && node.analysis.required.length === 1) {
      const literal = node.analysis.required[0];
      adjacentLiteral = `${adjacentLiteral ?? ""}${literal}`;
    } else {
      if (adjacentLiteral !== undefined) {
        required.push(adjacentLiteral);
        adjacentLiteral = undefined;
      }
      required.push(...node.analysis.required);
    }
    if (node.analysis.required.length === 0 && adjacentLiteral !== undefined) {
      required.push(adjacentLiteral);
      adjacentLiteral = undefined;
    }
    canBeEmpty = canBeEmpty && node.analysis.canBeEmpty;
  }
  if (adjacentLiteral !== undefined) required.push(adjacentLiteral);
  return { required: deduplicate(required), canBeEmpty };
}

function analyzeNode(
  source: string,
  start: number,
  end: number
): RegexNodeAnalysis {
  const character = source[start];
  if (character === undefined) {
    return {
      analysis: { required: [], canBeEmpty: true },
      index: start,
      isExactLiteral: false,
    };
  }
  if (character === "\\") {
    const escaped = source[start + 1];
    const literal = readEscapedLiteral(source, start, escaped);
    return {
      analysis: { required: literal ? [literal] : [], canBeEmpty: false },
      index: getEscapedEnd(source, start, end, escaped),
      isExactLiteral: literal !== undefined,
    };
  }
  if (character === "[") {
    return {
      analysis: { required: [], canBeEmpty: false },
      index: skipCharacterClass(source, start, end),
      isExactLiteral: false,
    };
  }
  if (character === "(") {
    const negativeAssertion =
      source[start + 1] === "?" &&
      (source[start + 2] === "!" ||
        (source[start + 2] === "<" && source[start + 3] === "!"));
    const groupStart =
      source[start + 1] === "?"
        ? readGroupPrefix(source, start, end)
        : start + 1;
    const group = analyzeAlternation(source, groupStart, end);
    const close = source[group.index] === ")" ? group.index + 1 : group.index;
    return {
      analysis: negativeAssertion
        ? { required: [], canBeEmpty: true }
        : group.analysis,
      index: close,
      // Group analysis can prove a required substring, but not that it is the
      // whole consumed text. Keeping it separate avoids joining partial
      // literals across alternations, wildcards, and zero-width assertions.
      isExactLiteral: false,
    };
  }
  if (
    character === "." ||
    character === "^" ||
    character === "$" ||
    character === "?"
  ) {
    return {
      analysis: { required: [], canBeEmpty: character === "?" },
      index: start + 1,
      isExactLiteral: false,
    };
  }
  return {
    analysis: { required: [character], canBeEmpty: false },
    index: start + 1,
    isExactLiteral: true,
  };
}

function combineAlternatives(branches: LiteralAnalysis[]): LiteralAnalysis {
  if (branches.length === 0) {
    return { required: [], canBeEmpty: true };
  }
  const common = longestCommonRequiredLiteral(branches);
  return {
    required: common ? [common] : [],
    canBeEmpty: branches.some((branch) => branch.canBeEmpty),
  };
}

function longestCommonRequiredLiteral(
  branches: LiteralAnalysis[]
): string | undefined {
  const firstBranch = branches[0]?.required ?? [];
  let longest: string | undefined;
  for (const candidate of firstBranch) {
    for (let start = 0; start < candidate.length; start += 1) {
      for (let end = candidate.length; end > start; end -= 1) {
        const literal = candidate.slice(start, end);
        if (
          literal.length <= (longest?.length ?? 0) ||
          !branches.every((branch) =>
            branch.required.some((required) => required.includes(literal))
          )
        ) {
          continue;
        }
        longest = literal;
      }
    }
  }
  return longest;
}

function readGroupPrefix(source: string, start: number, end: number): number {
  let index = start + 2;
  while (index < end && source[index] !== ":" && source[index] !== "=") {
    if (source[index] === "!") {
      return index + 1;
    }
    if (source[index] === "<" && source[index + 1] !== "=") {
      if (source[index + 1] === "!") {
        return index + 2;
      }
      index += 1;
      while (index < end && source[index] !== ">") index += 1;
      if (index < end) return index + 1;
    }
    index += 1;
  }
  return source[index] === ":" || source[index] === "=" ? index + 1 : start + 1;
}

function readQuantifier(
  source: string,
  start: number,
  end: number
): { minimum: number; exactlyOne: boolean; index: number } {
  if (source[start] === "*" || source[start] === "?")
    return { minimum: 0, exactlyOne: false, index: start + 1 };
  if (source[start] === "+")
    return { minimum: 1, exactlyOne: false, index: start + 1 };
  if (source[start] !== "{")
    return { minimum: 1, exactlyOne: true, index: start };
  const close = source.indexOf("}", start + 1);
  if (close === -1 || close >= end)
    return { minimum: 1, exactlyOne: true, index: start };
  const match = /^\{(\d+)(?:,(\d*)?)?\}/.exec(source.slice(start, close + 1));
  if (!match) return { minimum: 1, exactlyOne: true, index: start };
  const minimum = Number(match[1]);
  const maximum = match[2] === undefined ? minimum : Number(match[2]);
  return {
    minimum,
    exactlyOne: minimum === 1 && maximum === 1,
    index: close + 1,
  };
}

function skipCharacterClass(
  source: string,
  start: number,
  end: number
): number {
  let index = start + 1;
  if (source[index] === "^") index += 1;
  while (index < end) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "]") return index + 1;
    index += 1;
  }
  return end;
}

function isRegexClassEscape(character: string | undefined): boolean {
  return character !== undefined && /[dDsSwWpPkKbBAZzG]/.test(character);
}

function readEscapedLiteral(
  source: string,
  start: number,
  escaped: string | undefined
): string | undefined {
  if (
    escaped === undefined ||
    isRegexClassEscape(escaped) ||
    /[0-9]/.test(escaped) ||
    escaped === "k" ||
    escaped === "c"
  ) {
    return undefined;
  }
  if (escaped === "u") return readUnicodeEscape(source, start);
  if (escaped === "x") return readHexEscape(source, start);
  return (
    { n: "\n", r: "\r", t: "\t", f: "\f", v: "\v", "0": "\0" }[escaped] ??
    escaped
  );
}

function getEscapedEnd(
  source: string,
  start: number,
  end: number,
  escaped: string | undefined
): number {
  if (escaped === "u" && source[start + 2] === "{") {
    const close = source.indexOf("}", start + 3);
    return close === -1 ? end : close + 1;
  }
  if (escaped === "k" || escaped === "p" || escaped === "P") {
    const close = source.indexOf(escaped === "k" ? ">" : "}", start + 2);
    return close === -1 ? end : close + 1;
  }
  if (escaped === "c") return Math.min(end, start + 3);
  return Math.min(end, start + (escaped === "u" ? 6 : escaped === "x" ? 4 : 2));
}

function readUnicodeEscape(source: string, start: number): string | undefined {
  const value = source.slice(start + 2, start + 6);
  return value.length === 4 && /^[0-9a-f]{4}$/i.test(value)
    ? String.fromCharCode(Number.parseInt(value, 16))
    : undefined;
}

function readHexEscape(source: string, start: number): string | undefined {
  const value = source.slice(start + 2, start + 4);
  return value.length === 2 && /^[0-9a-f]{2}$/i.test(value)
    ? String.fromCharCode(Number.parseInt(value, 16))
    : undefined;
}

function deduplicate(values: string[]): string[] {
  return [...new Set(values)];
}
