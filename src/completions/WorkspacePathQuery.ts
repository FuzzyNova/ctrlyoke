import {
  fuzzyMatches,
  scoreFuzzyQuery,
  type FuzzyKey,
} from "./FuzzyRanking";
import {
  WorkspacePathStore,
  type WorkspacePathEntry,
} from "./WorkspacePathStore";
import { normalizeReferencePath } from "./ContextReferenceBuilder";
import {
  WORKSPACE_ENTRY_KINDS,
  type WorkspaceFileTreeEntryKind,
} from "../types/DashboardConstants";

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
}

interface ScoredEntry {
  entry: WorkspacePathEntry;
  score: number;
}

const fileKeys: readonly FuzzyKey<WorkspacePathEntry>[] = [
  (entry) => entry.name,
  (entry) => entry.relativePath,
];
const pathKeys: readonly FuzzyKey<WorkspacePathEntry>[] = [
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
    const entries = this.store.entries;
    const filter = normalizeReferencePath(query)
      .replace(/^\.\.?\//, "")
      .replace(/^\//, "")
      .toLowerCase();
    const { hasPath, parent, child } = splitScopedQuery(filter);
    const selected = entries.filter(
      (entry) =>
        entry.kind === WORKSPACE_ENTRY_KINDS.FILE &&
        PROMPT_EXTENSIONS.some((ext) => entry.lowerPath.endsWith(ext)) &&
        (!filter ||
          (hasPath
            ? entry.lowerParent === parent &&
              (!child || fuzzyMatches(entry.name, child))
            : subsequenceWordsMatch(entry.lowerPath, filter) &&
              fuzzyMatches(`${entry.name} ${entry.relativePath}`, filter)))
    );
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
    const keys = child ? [(entry: WorkspacePathEntry) => entry.name] : pathKeys;
    const candidates = child
      ? selected.filter((entry) => fuzzyMatches(entry.name, child))
      : selected;
    return this.rankCandidates(candidates, rankQuery, keys, options, options.limit ?? PROMPT_LIMIT);
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
    const base = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
    if (!base || maxResults <= 0) return [];
    const parent = normalized.includes("/")
      ? normalized.slice(0, normalized.lastIndexOf("/"))
      : ".";
    const candidates = this.store.entries.filter((entry) => entry.kind === kind);
    const maxDelta = candidates.reduce(
      (maximum, entry) => Math.max(maximum, Math.abs(entry.name.length - base.length)),
      0
    );
    const pathsByRank = new Map(
      [...candidates]
        .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
        .map((entry, index) => [entry.relativePath, index])
    );
    const { entries: results } = await this.scan(candidates, options, maxResults, (entry) => {
      const candidate = entry.lowerName;
      const sameDir = entry.parent === parent;
      const prefix = base.startsWith(candidate) || candidate.startsWith(base);
      const tier =
        sameDir && prefix
          ? 0
          : sameDir && fuzzyMatches(candidate, base)
            ? 1
            : candidate === base
              ? 2
              : prefix
                ? 3
                : -1;
      if (tier < 0 || entry.relativePath === normalized) return undefined;
      const delta = Math.abs(candidate.length - base.length);
      const lexicalRank = pathsByRank.get(entry.relativePath) ?? 0;
      const deltaFactor = candidates.length + 1;
      const tierFactor = (maxDelta + 1) * deltaFactor;
      return { score: -(tier * tierFactor + delta * deltaFactor + lexicalRank), entry };
    });
    return results.map(asResult);
  }

  private async queryFileEntries(
    query: string,
    options: WorkspacePathQueryOptions
  ): Promise<WorkspacePathResult[]> {
    const entries = this.store.entries;
    const filter = normalizeReferencePath(query).replace(/^"/, "").toLowerCase();
    const hasPath = filter.includes("/");
    const endsInSlash = filter.endsWith("/");
    const parent = hasPath
      ? (endsInSlash ? filter.slice(0, -1) : filter.slice(0, filter.lastIndexOf("/"))
        ).replace(/\/+$/, "")
      : "";
    const child = hasPath && !endsInSlash ? filter.slice(filter.lastIndexOf("/") + 1) : "";
    if (!hasPath && filter) {
      const source = this.narrowedPositions(filter);
      const scanned = await this.scan(
        source.map((position) => entries[position]).filter((entry) => entry !== undefined),
        options,
        options.limit ?? FILE_LIMIT,
        (entry) => {
          if (!subsequenceWordsMatch(entry.lowerPath, filter)) return undefined;
          const score = scoreFuzzyQuery(filter, entry, fileKeys);
          return score === undefined ? undefined : { score, entry };
        }
      );
      this.rememberNarrowing(filter, scanned.survivors);
      return scanned.entries.map(asResult);
    }

    const candidates = hasPath
      ? entries.filter(
          (entry) => entry.lowerParent === parent && (!child || fuzzyMatches(entry.name, child))
        )
      : entries;
    if (!child) return orderedResults(candidates, options.limit ?? FILE_LIMIT);
    const narrowed = candidates.filter((entry) => fuzzyMatches(entry.name, child));
    return this.rankCandidates(
      narrowed,
      child,
      fileKeys,
      options,
      options.limit ?? FILE_LIMIT
    );
  }

  private narrowedPositions(query: string): number[] {
    if (
      this.previousVersion === this.store.version &&
      query.startsWith(this.previousQuery) &&
      this.previousQuery.length > 0
    ) {
      return this.previousSurvivors;
    }
    return this.store.entries.map((entry) => entry.position);
  }

  private rememberNarrowing(query: string, positions: number[]): void {
    this.previousQuery = query;
    this.previousVersion = this.store.version;
    this.previousSurvivors = positions;
  }

  private async rankCandidates(
    candidates: readonly WorkspacePathEntry[],
    query: string,
    keys: readonly FuzzyKey<WorkspacePathEntry>[],
    options: WorkspacePathQueryOptions,
    limit: number
  ): Promise<WorkspacePathResult[]> {
    const { entries: results } = await this.scan(candidates, options, limit, (entry) => {
      if (!subsequenceWordsMatch(entry.lowerPath, query)) return undefined;
      const score = scoreFuzzyQuery(query, entry, keys);
      return score === undefined ? undefined : { score, entry };
    });
    return results.map(asResult);
  }

  private async scan(
    candidates: readonly WorkspacePathEntry[],
    options: WorkspacePathQueryOptions,
    limit: number,
    score: (entry: WorkspacePathEntry) => ScoredEntry | undefined
  ): Promise<{ entries: WorkspacePathEntry[]; survivors: number[] }> {
    const heap = new TopKHeap(limit === 0 ? candidates.length : Math.max(0, limit));
    const survivors: number[] = [];
    let scanned = 0;
    let lastProgress = Date.now();
    const publish = (): void => {
      if (!options.onProgress || Date.now() - lastProgress < PROGRESS_INTERVAL_MS) return;
      options.onProgress({
        scanned,
        total: candidates.length,
        results: heap.sorted().map(({ entry }, rank) => asResult(entry, rank)),
      });
      lastProgress = Date.now();
    };
    for (let start = 0; start < candidates.length; start += SCAN_CHUNK_SIZE) {
      if (options.signal?.aborted) break;
      const end = Math.min(candidates.length, start + SCAN_CHUNK_SIZE);
      for (let i = start; i < end; i++) {
        if (options.signal?.aborted) break;
        scanned++;
        const match = score(candidates[i]);
        if (match) {
          heap.push(match);
          survivors.push(candidates[i].position);
        }
      }
      publish();
      if (end < candidates.length && !options.signal?.aborted) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    publish();
    return { entries: heap.sorted().map(({ entry }) => entry), survivors };
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
    ? (endsInSlash ? filter.slice(0, -1) : filter.slice(0, filter.lastIndexOf("/"))
      ).replace(/\/+$/, "")
    : "";
  const child = hasPath && !endsInSlash ? filter.slice(filter.lastIndexOf("/") + 1) : "";
  return { hasPath, parent, child };
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

function orderedResults(
  entries: readonly WorkspacePathEntry[],
  limit: number
): WorkspacePathResult[] {
  const directories = entries.filter((entry) => entry.kind === WORKSPACE_ENTRY_KINDS.DIRECTORY);
  const files = entries.filter((entry) => entry.kind === WORKSPACE_ENTRY_KINDS.FILE);
  return [...directories, ...files].slice(0, limit).map(asResult);
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
      [this.values[index], this.values[parent]] = [this.values[parent], this.values[index]];
      index = parent;
    }
  }

  private sink(index: number): void {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (left < this.values.length && compareScored(this.values[left], this.values[worst]) < 0) worst = left;
      if (right < this.values.length && compareScored(this.values[right], this.values[worst]) < 0) worst = right;
      if (worst === index) return;
      [this.values[index], this.values[worst]] = [this.values[worst], this.values[index]];
      index = worst;
    }
  }
}

function compareScored(a: ScoredEntry, b: ScoredEntry): number {
  return a.score - b.score || b.entry.position - a.entry.position;
}
