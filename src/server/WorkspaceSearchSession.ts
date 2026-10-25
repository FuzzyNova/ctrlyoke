import { randomUUID } from "crypto";
import * as path from "path";
import {
  WORKSPACE_ENTRY_KINDS,
  WORKSPACE_SEARCH_SCOPES,
  type WorkspaceSearchScope,
} from "../types/DashboardConstants";
import type {
  WorkspaceSearchContentMatch,
  WorkspaceSearchResponse,
  WorkspaceSearchResult,
} from "../types/HostedWorkspaceViewerTypes";

export interface WorkspaceSearchCandidate {
  absolutePath: string;
  viewerPath: string;
}

/** What identifies a search: a page request may only continue a session started with the same values. */
export interface WorkspaceSearchParams {
  query: string;
  scope: WorkspaceSearchScope;
  includeGitIgnored: boolean;
  repo: string | undefined;
}

export type WorkspaceSearchFileScanner = (
  candidate: WorkspaceSearchCandidate,
  queryLower: string,
  maxMatches: number
) => Promise<WorkspaceSearchContentMatch[]>;

/** Work one page request may do before it answers with what it has. */
export interface WorkspaceSearchPageBudget {
  /** `Date.now()` value past which the request stops scanning. */
  deadline: number;
  /** Candidates the request may examine. */
  maxFiles: number;
  /** How long to keep counting past the requested page. */
  lookaheadMs: number;
  /**
   * After this long, a page that has at least one new result answers with
   * what it has rather than scanning on to fill `limit`. With sparse matches
   * the first few can otherwise sit unseen for the whole `deadline`.
   */
  partialPageMs: number;
}

/** Files read concurrently during a content scan. */
const CONTENT_SCAN_CONCURRENCY = 8;
/** Candidates name-matched per step when nothing is read from disk. */
const FILENAME_SCAN_BATCH = 256;

/**
 * One workspace search, scanned incrementally across page requests.
 *
 * Results are appended in scan order and never reordered, so a page read once
 * stays valid while later pages extend the list. A file whose name matches is
 * reported as a filename result and not content-scanned as well.
 */
export class WorkspaceSearchSession {
  readonly id = randomUUID();
  lastUsedAt = Date.now();

  private readonly results: WorkspaceSearchResult[] = [];
  private readonly pending: WorkspaceSearchCandidate[] = [];
  private readonly queryLower: string;
  private sourceDone = false;
  private exhausted = false;
  private capped = false;
  /** Page requests run one at a time; two interleaved fills would race on `results`. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly params: WorkspaceSearchParams,
    private readonly candidates: AsyncIterator<WorkspaceSearchCandidate[]>,
    private readonly scanFile: WorkspaceSearchFileScanner,
    private readonly maxResults: number
  ) {
    this.queryLower = params.query.toLowerCase();
  }

  matches(params: WorkspaceSearchParams): boolean {
    return (
      this.params.query === params.query &&
      this.params.scope === params.scope &&
      this.params.includeGitIgnored === params.includeGitIgnored &&
      this.params.repo === params.repo
    );
  }

  /**
   * Scan until `offset + limit` results exist (or the budget runs out), then
   * keep counting for up to `lookaheadMs` more so the reported total is often
   * exact for a small result set instead of reading "50+" at 51.
   */
  page(
    offset: number,
    limit: number,
    budget: WorkspaceSearchPageBudget
  ): Promise<WorkspaceSearchResponse> {
    const run = this.tail.then(async () => {
      this.lastUsedAt = Date.now();
      const files = { remaining: budget.maxFiles };
      await this.fill(offset + limit, budget.deadline, files, {
        minResults: offset + 1,
        at: Date.now() + budget.partialPageMs,
      });
      await this.fill(
        Number.POSITIVE_INFINITY,
        Math.min(budget.deadline, Date.now() + budget.lookaheadMs),
        files
      );
      this.lastUsedAt = Date.now();
      return {
        searchId: this.id,
        results: this.results.slice(offset, offset + limit),
        totalCount: this.results.length,
        complete: this.isComplete,
        capped: this.capped,
      };
    });
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Stops the candidate source, e.g. a directory walk still in progress. */
  dispose(): void {
    void this.candidates.return?.();
  }

  private get isComplete(): boolean {
    return this.exhausted || this.capped;
  }

  private async fill(
    target: number,
    deadline: number,
    files: { remaining: number },
    /** Stop early once `minResults` exist and it is past `at`. */
    partial?: { minResults: number; at: number }
  ): Promise<void> {
    const batchSize =
      this.params.scope === WORKSPACE_SEARCH_SCOPES.FILES
        ? FILENAME_SCAN_BATCH
        : CONTENT_SCAN_CONCURRENCY;
    while (!this.isComplete && this.results.length < target) {
      if (Date.now() >= deadline || files.remaining <= 0) return;
      if (
        partial &&
        this.results.length >= partial.minResults &&
        Date.now() >= partial.at
      ) {
        return;
      }
      const batch = await this.takeCandidates(
        Math.min(batchSize, files.remaining)
      );
      if (batch.length === 0) {
        this.exhausted = true;
        return;
      }
      files.remaining -= batch.length;

      const capacity = this.maxResults - this.results.length;
      const perCandidate = await Promise.all(
        batch.map((candidate) => this.matchCandidate(candidate, capacity))
      );
      for (const matches of perCandidate) {
        for (const match of matches) {
          if (this.results.length >= this.maxResults) {
            this.capped = true;
            return;
          }
          this.results.push(match);
        }
      }
    }
  }

  private async takeCandidates(
    count: number
  ): Promise<WorkspaceSearchCandidate[]> {
    while (this.pending.length < count && !this.sourceDone) {
      const next = await this.candidates.next();
      if (next.done) {
        this.sourceDone = true;
        break;
      }
      // Not `push(...next.value)`: a source batch can be large enough to
      // overflow the argument limit of a spread call.
      for (const candidate of next.value) this.pending.push(candidate);
    }
    return this.pending.splice(0, count);
  }

  private async matchCandidate(
    candidate: WorkspaceSearchCandidate,
    capacity: number
  ): Promise<WorkspaceSearchResult[]> {
    if (candidate.viewerPath.endsWith("/")) return [];
    if (this.params.scope !== WORKSPACE_SEARCH_SCOPES.CONTENT) {
      const name = path.basename(candidate.absolutePath);
      if (name.toLowerCase().includes(this.queryLower)) {
        return [
          {
            kind: WORKSPACE_ENTRY_KINDS.FILE,
            path: candidate.viewerPath,
            name,
          },
        ];
      }
    }
    if (this.params.scope === WORKSPACE_SEARCH_SCOPES.FILES) return [];
    // One past capacity, so a file holding more matches than fit still
    // tells `fill` the cap was reached with results left over.
    return this.scanFile(candidate, this.queryLower, capacity + 1);
  }
}

/**
 * Bounded set of live search sessions. A session holds its scan position and
 * every result found so far, so idle ones expire and the oldest is evicted
 * once the store is full.
 */
export class WorkspaceSearchSessionStore {
  private readonly sessions = new Map<string, WorkspaceSearchSession>();

  constructor(
    private readonly maxSessions: number,
    private readonly idleTtlMs: number
  ) {}

  /** The named session, if it is still live and was started with `params`. */
  find(
    searchId: string | undefined,
    params: WorkspaceSearchParams
  ): WorkspaceSearchSession | undefined {
    this.evictExpired();
    if (!searchId) return undefined;
    const session = this.sessions.get(searchId);
    if (!session?.matches(params)) return undefined;
    // Re-inserting keeps the map in least-recently-used order.
    this.sessions.delete(searchId);
    this.sessions.set(searchId, session);
    return session;
  }

  add(session: WorkspaceSearchSession): void {
    this.evictExpired();
    this.sessions.set(session.id, session);
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.values().next().value;
      if (!oldest) break;
      this.remove(oldest);
    }
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) this.remove(session);
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastUsedAt > this.idleTtlMs) this.remove(session);
    }
  }

  private remove(session: WorkspaceSearchSession): void {
    this.sessions.delete(session.id);
    session.dispose();
  }
}
