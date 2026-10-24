import { fuzzyMatches, scoreFuzzyQuery, type FuzzyKey } from "./FuzzyRanking";
import {
  WorkspacePathStore,
  type WorkspacePathEntry,
} from "./WorkspacePathStore";
import { normalizeReferencePath } from "./ContextReferenceBuilder";
import { type WorkspaceFileTreeEntryKind } from "../types/DashboardConstants";

const FILE_LIMIT = 500;
const PROMPT_LIMIT = 200;
const PROMPT_EXTENSIONS = [".prompt.md", ".md", ".txt"];
const SCAN_CHUNK_SIZE = 20_000;
const PROGRESS_INTERVAL_MS = 50;

export interface WorkspacePathResult {
  readonly kind: WorkspaceFileTreeEntryKind;
  readonly relativePath: string;
  readonly rank: number;
}

export interface WorkspacePathProgress {
  readonly scanned: number;
  readonly total: number;
  readonly results: readonly WorkspacePathResult[];
}

export interface WorkspacePathQueryOptions {
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: WorkspacePathProgress) => void;
  /** Preserve incomplete scans so a longer query can resume from their end. */
  readonly resumeOnAbort?: boolean;
  /** Deterministic scan budget for query tests. */
  readonly maxScanEntries?: number;
}

interface ScoredEntry {
  entry: WorkspacePathEntry;
  score: number;
}

/** Store positions to scan; `undefined` scans the whole store in order. */
type Positions = readonly number[] | undefined;

const fileKeys: readonly FuzzyKey<WorkspacePathEntry>[] = [
  (entry) => entry.name,
  (entry) => entry.relativePath,
];

/**
 * Pure query engine over an ordered store. A query instance retains only the
 * latest unscoped survivor set to accelerate successive typed characters.
 */
export class WorkspacePathQuery {
  private previousQuery = "";
  private previousVersion = -1;
  private previousSurvivors: number[] = [];
  private partialQuery = "";
  private partialVersion = -1;
  private partialPosition = 0;
  private partialSurvivors: number[] = [];
  private narrowingGeneration = 0;

  constructor(private readonly store: WorkspacePathStore) {}

  queryFiles(
    query: string,
    options: WorkspacePathQueryOptions = {}
  ): Promise<WorkspacePathResult[]> {
    return this.queryFileEntries(query, options);
  }

  async queryPromptFiles(
    query: string,
    options: WorkspacePathQueryOptions = {}
  ): Promise<WorkspacePathResult[]> {
    const store = this.store;
    const filter = normalizeReferencePath(query)
      .replace(/^\.\.?\//, "")
      .replace(/^\//, "")
      .toLowerCase();
    const { hasPath, parent, child } = splitScopedQuery(filter);
    const selected: WorkspacePathEntry[] = [];
    for (let position = 0; position < store.size; position++) {
      if (!store.isFileAt(position)) continue;
      const lowerPath = store.lowerPathAt(position);
      if (!PROMPT_EXTENSIONS.some((ext) => lowerPath.endsWith(ext))) continue;
      if (filter) {
        if (hasPath && !store.hasLowerParent(position, parent)) continue;
        if (!hasPath && !subsequenceWordsMatch(lowerPath, filter)) continue;
      }
      const entry = store.entryAt(position);
      if (
        !filter ||
        (hasPath
          ? !child || fuzzyMatches(entry.name, child)
          : fuzzyMatches(`${entry.name} ${entry.relativePath}`, filter))
      ) {
        selected.push(entry);
      }
    }
    const shouldRank = Boolean(child || (filter && !hasPath));
    if (!shouldRank) {
      selected.sort((a, b) =>
        `${a.relativePath.split("/").length}_${a.relativePath}`.localeCompare(
          `${b.relativePath.split("/").length}_${b.relativePath}`
        )
      );
      return selected.slice(0, options.limit ?? PROMPT_LIMIT).map(asResult);
    }
    const rankQuery = child || filter;
    const keys = child ? [(entry: WorkspacePathEntry) => entry.name] : fileKeys;
    const candidates = child
      ? selected.filter((entry) => fuzzyMatches(entry.name, child))
      : selected;
    return this.rankCandidates(
      candidates.map((entry) => entry.position),
      rankQuery,
      keys,
      options,
      options.limit ?? PROMPT_LIMIT
    );
  }

  async suggestPaths(
    typedPath: string,
    kind: WorkspaceFileTreeEntryKind,
    maxResults = 3,
    options: WorkspacePathQueryOptions = {}
  ): Promise<WorkspacePathResult[]> {
    const normalized = normalizeReferencePath(typedPath)
      .replace(/^\.\.?\//, "")
      .replace(/\/+$/, "");
    const base = normalized
      .slice(normalized.lastIndexOf("/") + 1)
      .toLowerCase();
    if (!base || maxResults <= 0) return [];
    const parent = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/"))
      : ".";
    const store = this.store;
    const matches: Array<{
      entry: WorkspacePathEntry;
      tier: number;
      delta: number;
    }> = [];
    for (let start = 0; start < store.size; start += SCAN_CHUNK_SIZE) {
      if (options.signal?.aborted) break;
      const end = Math.min(store.size, start + SCAN_CHUNK_SIZE);
      for (let i = start; i < end; i++) {
        if (store.kindAt(i) !== kind) continue;
        const lowerName = store.lowerNameAt(i);
        const tier = suggestionTier(
          lowerName,
          store.hasParent(i, parent),
          base
        );
        if (tier < 0 || store.pathAt(i) === normalized) continue;
        matches.push({
          entry: store.entryAt(i),
          tier,
          delta: Math.abs(lowerName.length - base.length),
        });
      }
      if (end < store.size) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    // Only the (few) matches are sorted, never the whole store.
    matches.sort(
      (a, b) =>
        a.tier - b.tier ||
        a.delta - b.delta ||
        a.entry.relativePath.localeCompare(b.entry.relativePath)
    );
    return matches
      .slice(0, maxResults)
      .map(({ entry }, rank) => asResult(entry, rank));
  }

  private async queryFileEntries(
    query: string,
    options: WorkspacePathQueryOptions
  ): Promise<WorkspacePathResult[]> {
    const store = this.store;
    const filter = normalizeReferencePath(query)
      .replace(/^"/, "")
      .toLowerCase();
    const hasPath = filter.includes("/");
    const endsInSlash = filter.endsWith("/");
    const parent = hasPath
      ? (endsInSlash
          ? filter.slice(0, -1)
          : filter.slice(0, filter.lastIndexOf("/"))
        ).replace(/\/+$/, "")
      : "";
    const child =
      hasPath && !endsInSlash ? filter.slice(filter.lastIndexOf("/") + 1) : "";
    if (!hasPath && filter) {
      const partial = this.partialNarrowing(filter);
      const narrowed = partial ? undefined : this.narrowedPositions(filter);
      const canResumeFromStoreStart = narrowed === undefined || partial;
      const generation = ++this.narrowingGeneration;
      const version = store.version;
      const scanned = await this.scan(
        narrowed,
        options,
        options.limit ?? FILE_LIMIT,
        (position) => this.scoreAt(position, filter, fileKeys),
        partial,
        options.resumeOnAbort && canResumeFromStoreStart
          ? (position, survivors) =>
              generation === this.narrowingGeneration &&
              version === store.version &&
              this.rememberPartialNarrowing(filter, position, survivors)
          : undefined
      );
      if (
        generation !== this.narrowingGeneration ||
        version !== store.version
      ) {
        return scanned.entries.map(asResult);
      }
      if (scanned.complete) {
        this.rememberNarrowing(filter, scanned.survivors);
      } else if (options.resumeOnAbort && canResumeFromStoreStart) {
        this.rememberPartialNarrowing(
          filter,
          scanned.scannedThrough,
          scanned.survivors
        );
      }
      return scanned.entries.map(asResult);
    }

    const limit = options.limit ?? FILE_LIMIT;
    if (!hasPath) return orderedResults(store, undefined, limit);
    const candidates: number[] = [];
    for (let position = 0; position < store.size; position++) {
      if (
        store.hasLowerParent(position, parent) &&
        (!child || fuzzyMatches(store.entryAt(position).name, child))
      ) {
        candidates.push(position);
      }
    }
    // `backlog/secre` names no root-level `backlog/`: rather than an empty
    // list, match the whole query fuzzily against every path, so it finds
    // `dev/bugs/backlog/secret-...` the way a slash-free query would.
    if (candidates.length === 0) {
      const scanned = await this.scan(undefined, options, limit, (position) =>
        this.scoreAt(position, filter, fileKeys)
      );
      return scanned.entries.map(asResult);
    }
    if (!child) return orderedResults(store, candidates, limit);
    return this.rankCandidates(candidates, child, fileKeys, options, limit);
  }

  /** The previous query's survivors when this one extends it, else all. */
  private narrowedPositions(query: string): Positions {
    if (
      this.previousVersion === this.store.version &&
      query.startsWith(this.previousQuery) &&
      this.previousQuery.length > 0
    ) {
      return this.previousSurvivors;
    }
    return undefined;
  }

  /** Partial survivors cover [0, position); later queries can filter them. */
  private partialNarrowing(
    query: string
  ): { position: number; survivors: number[] } | undefined {
    if (
      this.partialVersion === this.store.version &&
      this.partialQuery.length > 0 &&
      query.startsWith(this.partialQuery)
    ) {
      return {
        position: this.partialPosition,
        survivors: this.partialSurvivors.filter(
          (position) => this.scoreAt(position, query, fileKeys) !== undefined
        ),
      };
    }
    return undefined;
  }

  private scoreAt(
    position: number,
    query: string,
    keys: readonly FuzzyKey<WorkspacePathEntry>[]
  ): ScoredEntry | undefined {
    if (!subsequenceWordsMatch(this.store.lowerPathAt(position), query)) {
      return undefined;
    }
    const entry = this.store.entryAt(position);
    const score = scoreFuzzyQuery(query, entry, keys);
    return score === undefined ? undefined : { score, entry };
  }

  private rememberNarrowing(query: string, positions: number[]): void {
    this.previousQuery = query;
    this.previousVersion = this.store.version;
    this.previousSurvivors = positions;
    this.partialQuery = "";
    this.partialVersion = -1;
    this.partialPosition = 0;
    this.partialSurvivors = [];
  }

  private rememberPartialNarrowing(
    query: string,
    position: number,
    survivors: number[]
  ): void {
    this.partialQuery = query;
    this.partialVersion = this.store.version;
    this.partialPosition = position;
    this.partialSurvivors = [...survivors];
  }

  private async rankCandidates(
    candidates: readonly number[],
    query: string,
    keys: readonly FuzzyKey<WorkspacePathEntry>[],
    options: WorkspacePathQueryOptions,
    limit: number
  ): Promise<WorkspacePathResult[]> {
    const { entries: results } = await this.scan(
      candidates,
      options,
      limit,
      (position) => this.scoreAt(position, query, keys)
    );
    return results.map(asResult);
  }

  private async scan(
    candidates: Positions,
    options: WorkspacePathQueryOptions,
    limit: number,
    score: (position: number) => ScoredEntry | undefined,
    resume?: { position: number; survivors: number[] },
    onCheckpoint?: (position: number, survivors: number[]) => void
  ): Promise<{
    entries: WorkspacePathEntry[];
    survivors: number[];
    scannedThrough: number;
    complete: boolean;
  }> {
    const total = resume
      ? this.store.size
      : (candidates?.length ?? this.store.size);
    const heap = new TopKHeap(limit === 0 ? total : Math.max(0, limit));
    const survivors: number[] = [];
    if (resume) {
      for (const position of resume.survivors) {
        const match = score(position);
        if (match) {
          heap.push(match);
          survivors.push(position);
        }
      }
    }
    let scanned = 0;
    let lastProgress = Date.now();
    let scannedThrough = resume?.position ?? 0;
    const publish = (): void => {
      if (
        !options.onProgress ||
        Date.now() - lastProgress < PROGRESS_INTERVAL_MS
      )
        return;
      options.onProgress({
        scanned,
        total,
        results: heap.sorted().map(({ entry }, rank) => asResult(entry, rank)),
      });
      lastProgress = Date.now();
    };
    const scanStart = resume?.position ?? 0;
    const scanTotal = resume ? total - scanStart : total;
    for (let start = 0; start < scanTotal; start += SCAN_CHUNK_SIZE) {
      if (options.signal?.aborted) break;
      const end = Math.min(scanTotal, start + SCAN_CHUNK_SIZE);
      for (let i = start; i < end; i++) {
        if (
          options.maxScanEntries !== undefined &&
          scanned >= options.maxScanEntries
        )
          break;
        if (options.signal?.aborted) break;
        scanned++;
        const position = resume
          ? scanStart + i
          : candidates
            ? candidates[i]
            : i;
        const match = score(position);
        if (match) {
          heap.push(match);
          survivors.push(position);
        }
        scannedThrough = position + 1;
      }
      onCheckpoint?.(scannedThrough, survivors);
      publish();
      if (
        end < scanTotal &&
        !options.signal?.aborted &&
        (options.maxScanEntries === undefined ||
          scanned < options.maxScanEntries)
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (
        options.maxScanEntries !== undefined &&
        scanned >= options.maxScanEntries
      )
        break;
    }
    publish();
    const complete = resume
      ? scannedThrough >= this.store.size
      : scanned >= total || total === 0;
    if (!resume && complete) scannedThrough = this.store.size;
    return {
      entries: heap.sorted().map(({ entry }) => entry),
      survivors,
      scannedThrough,
      complete,
    };
  }
}

function splitScopedQuery(filter: string): {
  hasPath: boolean;
  parent: string;
  child: string;
} {
  const hasPath = filter.includes("/");
  const endsInSlash = filter.endsWith("/");
  const parent = hasPath
    ? (endsInSlash
        ? filter.slice(0, -1)
        : filter.slice(0, filter.lastIndexOf("/"))
      ).replace(/\/+$/, "")
    : "";
  const child =
    hasPath && !endsInSlash ? filter.slice(filter.lastIndexOf("/") + 1) : "";
  return { hasPath, parent, child };
}

/**
 * Path-suggestion tier: 0 same directory with a prefix match, 1 same
 * directory fuzzy match, 2 exact name elsewhere, 3 prefix elsewhere, -1 none.
 */
function suggestionTier(
  candidate: string,
  sameDir: boolean,
  base: string
): number {
  const prefix = base.startsWith(candidate) || candidate.startsWith(base);
  if (sameDir && prefix) return 0;
  if (sameDir && fuzzyMatches(candidate, base)) return 1;
  if (candidate === base) return 2;
  return prefix ? 3 : -1;
}

function subsequenceWordsMatch(lowerPath: string, query: string): boolean {
  return query
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => isSubsequence(word, lowerPath));
}

function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (let i = 0; i < haystack.length && at < needle.length; i++) {
    if (haystack[i] === needle[at]) at++;
  }
  return at === needle.length;
}

function asResult(entry: WorkspacePathEntry, rank = 0): WorkspacePathResult {
  return { kind: entry.kind, relativePath: entry.relativePath, rank };
}

/** Directories, then files, each in store order, stopping at `limit`. */
function orderedResults(
  store: WorkspacePathStore,
  candidates: Positions,
  limit: number
): WorkspacePathResult[] {
  const total = candidates?.length ?? store.size;
  const results: WorkspacePathResult[] = [];
  for (const wantFile of [false, true]) {
    for (let i = 0; i < total && results.length < limit; i++) {
      const position = candidates ? candidates[i] : i;
      if (store.isFileAt(position) === wantFile) {
        results.push(asResult(store.entryAt(position)));
      }
    }
  }
  return results;
}

/** Min-heap whose root is the worst retained item. */
class TopKHeap {
  private readonly values: ScoredEntry[] = [];

  constructor(private readonly limit: number) {}

  push(value: ScoredEntry): void {
    if (this.limit === 0) return;
    if (this.values.length < this.limit) {
      this.values.push(value);
      this.bubbleUp(this.values.length - 1);
      return;
    }
    if (compareScored(value, this.values[0]) <= 0) return;
    this.values[0] = value;
    this.sink(0);
  }

  sorted(): ScoredEntry[] {
    return [...this.values].sort((a, b) => compareScored(b, a));
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareScored(this.values[index], this.values[parent]) >= 0) break;
      [this.values[index], this.values[parent]] = [
        this.values[parent],
        this.values[index],
      ];
      index = parent;
    }
  }

  private sink(index: number): void {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (
        left < this.values.length &&
        compareScored(this.values[left], this.values[worst]) < 0
      )
        worst = left;
      if (
        right < this.values.length &&
        compareScored(this.values[right], this.values[worst]) < 0
      )
        worst = right;
      if (worst === index) return;
      [this.values[index], this.values[worst]] = [
        this.values[worst],
        this.values[index],
      ];
      index = worst;
    }
  }
}

function compareScored(a: ScoredEntry, b: ScoredEntry): number {
  return a.score - b.score || b.entry.position - a.entry.position;
}
