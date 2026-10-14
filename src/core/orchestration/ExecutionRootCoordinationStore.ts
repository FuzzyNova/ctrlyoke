import * as fs from "fs/promises";
import * as path from "path";
import { configService } from "../../config/CtrlYokeConfigService";
import {
  CTRLYOKE_SETTINGS_DEFAULTS,
  type CoordinationSettings,
} from "../../types/CtrlYokeSettings";
import type { CoordinationEntry } from "../../types/CtrlYokeTypes";
import { COORDINATION_ENTRY_KINDS } from "../../types/DashboardConstants";
import { withFileLock } from "../../utils/FileLockUtils";
import { splitLines } from "../../utils/TextLines";
import { claimPathForCompare } from "../../utils/CoordinationClaimPath";
import {
  assertWritableSchema,
  CURRENT_SCHEMA_VERSIONS,
  hasNewerSchema,
  PERSISTED_STORES,
} from "../../utils/PersistedSchemaGuard";
import { migrateToCurrent } from "../../utils/FormatMigrations";
import {
  resolveExecutionRootScope,
  SCOPE_STORAGE_CATEGORIES,
  scopeStorageRoot,
  verifyScopeRecord,
  type ExecutionRootScope,
} from "./ExecutionRootScope";

const BOARD_FILE_NAME = "board.jsonl";
const SCOPE_RECORD_FILE_NAME = "scope.json";

export const DEFAULT_COORDINATION_SETTINGS: CoordinationSettings =
  CTRLYOKE_SETTINGS_DEFAULTS.coordination;

export type CoordinationRetentionOptions = Pick<
  CoordinationSettings,
  | "readNotesPageSize"
  | "maxNoteLength"
  | "maxEntries"
  | "maxBoardBytes"
  | "maxNoteAgeHours"
>;

const HOUR_MS = 60 * 60 * 1_000;

export interface CoordinationStoreOptions {
  retention?: Partial<CoordinationRetentionOptions>;
  now?: () => number;
  unresolvedClaims?: CoordinationUnresolvedClaimResolver;
  liveParticipants?: CoordinationLiveParticipantResolver;
}

export interface CoordinationBoardScope {
  identity: string;
  scopeHash: string;
  executionRoot: string;
  storageRoot: string;
  boardPath: string;
  scopeRecordPath: string;
}

export type CoordinationEntryInput = Omit<
  CoordinationEntry,
  "seq" | "at" | "schemaVersion"
> & {
  at?: string;
};

export interface CoordinationReadOptions {
  /** Return entries with sequence numbers strictly greater than this cursor. */
  since?: number;
  /** Restrict results to these participant IDs. */
  from?: readonly string[];
  /** Page size; bounded to prevent an untrusted board from causing huge reads. */
  limit?: number;
  /** Restrict the page to one entry kind before applying pagination. */
  kind?: CoordinationEntry["kind"];
  /** For notes, include broadcasts and notes addressed to this participant. */
  recipient?: string;
  /** Return the newest page rather than the oldest page. */
  latest?: boolean;
  /** Leave out entries written by this participant (a reader's own notes). */
  excludeFrom?: string;
}

export interface CoordinationReadResult {
  entries: CoordinationEntry[];
  /** Forward page only: pass as `since` to read the entries after this page. */
  nextCursor?: number;
  /** `latest` page only: how many older matching entries the page left out. */
  omittedOlder?: number;
}

export interface CoordinationBoardTransaction {
  readonly entries: CoordinationEntry[];
  append(entry: CoordinationEntryInput): Promise<CoordinationEntry>;
}

function readScopeStorage(scope: ExecutionRootScope): CoordinationBoardScope {
  const storageRoot = scopeStorageRoot(
    scope,
    SCOPE_STORAGE_CATEGORIES.COORDINATION
  );
  return {
    identity: scope.identity,
    scopeHash: scope.scopeHash,
    executionRoot: scope.executionRoot,
    storageRoot,
    boardPath: path.join(storageRoot, BOARD_FILE_NAME),
    scopeRecordPath: path.join(storageRoot, SCOPE_RECORD_FILE_NAME),
  };
}

async function readEntries(boardPath: string): Promise<CoordinationEntry[]> {
  let contents: string;
  try {
    contents = await fs.readFile(boardPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return splitLines(contents)
    .filter((line) => line.trim().length > 0)
    .map(
      (line) =>
        migrateToCurrent(PERSISTED_STORES.COORDINATION_BOARD, JSON.parse(line))
          .doc as CoordinationEntry
    );
}

async function verifyBoardScope(scope: CoordinationBoardScope): Promise<void> {
  await verifyScopeRecord({
    storageRoot: scope.storageRoot,
    scopeIdentity: scope.identity,
    hasExistingData: async () => {
      try {
        await fs.access(scope.boardPath);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    mismatchMessage: "Coordination scope mismatch",
    missingMessage: "Coordination scope metadata is missing",
  });
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 1
    ? Math.floor(value)
    : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function retentionOptions(
  overrides: Partial<CoordinationRetentionOptions> = {}
): CoordinationRetentionOptions {
  const configured = configService.get("coordination");
  return {
    readNotesPageSize: positiveInteger(
      overrides.readNotesPageSize ?? configured.readNotesPageSize,
      DEFAULT_COORDINATION_SETTINGS.readNotesPageSize
    ),
    maxNoteLength: positiveInteger(
      overrides.maxNoteLength ?? configured.maxNoteLength,
      DEFAULT_COORDINATION_SETTINGS.maxNoteLength
    ),
    maxEntries: positiveInteger(
      overrides.maxEntries ?? configured.maxEntries,
      DEFAULT_COORDINATION_SETTINGS.maxEntries
    ),
    maxBoardBytes: positiveInteger(
      overrides.maxBoardBytes ?? configured.maxBoardBytes,
      DEFAULT_COORDINATION_SETTINGS.maxBoardBytes
    ),
    maxNoteAgeHours: positiveNumber(
      overrides.maxNoteAgeHours ?? configured.maxNoteAgeHours,
      DEFAULT_COORDINATION_SETTINGS.maxNoteAgeHours
    ),
  };
}

function pageSize(
  limit: number | undefined,
  configuredPageSize: number
): number {
  if (limit === undefined) return configuredPageSize;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error("Coordination board page size must be a positive number");
  }
  return Math.min(Math.floor(limit), configuredPageSize);
}

function serializedEntryBytes(entry: CoordinationEntry): number {
  return Buffer.byteLength(`${JSON.stringify(entry)}\n`, "utf8");
}

export interface CoordinationActiveClaim {
  entry: CoordinationEntry;
  path: string;
}

export type CoordinationUnresolvedClaimResolver = (
  entries: readonly CoordinationEntry[]
) => readonly CoordinationActiveClaim[];

export type CoordinationLiveParticipantResolver = (
  entries: readonly CoordinationEntry[]
) => ReadonlySet<string>;

/**
 * Return explicit claims that have not been cancelled by a later release.
 * This deliberately errs on the side of protecting a claim: liveness-aware
 * ownership folding happens in ExecutionRootCoordination, while retention
 * must never make an unresolved claim disappear from the board.
 */
function unresolvedClaims(
  entries: readonly CoordinationEntry[]
): CoordinationActiveClaim[] {
  const active = new Map<string, CoordinationActiveClaim>();

  for (const entry of entries) {
    if (entry.kind === COORDINATION_ENTRY_KINDS.CLAIM) {
      for (const claimPath of entry.paths ?? []) {
        active.set(claimPathForCompare(claimPath), {
          entry,
          path: claimPath,
        });
      }
    } else if (entry.kind === COORDINATION_ENTRY_KINDS.RELEASE) {
      if (entry.paths === undefined) {
        for (const [claimPath, claim] of active) {
          if (claim.entry.from.participantId === entry.from.participantId) {
            active.delete(claimPath);
          }
        }
      } else {
        for (const claimPath of entry.paths) {
          const claimKey = claimPathForCompare(claimPath);
          const claim = active.get(claimKey);
          if (claim?.entry.from.participantId === entry.from.participantId) {
            active.delete(claimKey);
          }
        }
      }
    } else if (entry.kind === COORDINATION_ENTRY_KINDS.LEAVE) {
      for (const [claimPath, claim] of active) {
        if (claim.entry.from.participantId === entry.from.participantId) {
          active.delete(claimPath);
        }
      }
    }
  }

  return [...active.values()];
}

/**
 * Named safety property for retention: compaction may remove settled claim /
 * release history, but it cannot remove an explicit unresolved claim.
 */
export function trimmingPreservesUnresolvedClaims(
  before: readonly CoordinationEntry[],
  after: readonly CoordinationEntry[],
  resolveClaims: CoordinationUnresolvedClaimResolver = unresolvedClaims
): boolean {
  const beforeClaims = resolveClaims(before);
  const afterClaims = resolveClaims(after);
  return beforeClaims.every((claim) =>
    afterClaims.some(
      (candidate) =>
        candidate.path === claim.path &&
        candidate.entry.from.participantId === claim.entry.from.participantId
    )
  );
}

/**
 * Fold away the join/leave pairs of participants that have departed.
 *
 * A settled pair carries no remaining state: the ownership fold rebuilds
 * participants from `join` entries and a `leave` removes them again, and every
 * surviving entry denormalises `from` (Decision 3) precisely so attribution
 * never has to resolve a lease that was compacted away.
 *
 * This is not hygiene, it is the same safety property as settled claims.
 * `trimNotesToCaps` can only evict notes, so join/leave entries that are never
 * folded accumulate without bound on a long-lived board — the main checkout's
 * board spans months of unrelated workflows and external sessions. Once they
 * alone reach `maxEntries`, every subsequent append fails permanently with no
 * removable candidate, and the only recovery is deleting the board by hand.
 *
 * A lifecycle is every `join` since the participant's last `leave`. For an
 * open lifecycle, retain its first join as the lifecycle start marker (so
 * claims before later refreshes still belong to a registered participant) and
 * its last join as the current lease/liveness record; intermediate refresh
 * joins are redundant. This bounds a long-lived participant to two joins per
 * lifecycle. Matching by sequence also folds each completed cycle of a
 * participant that re-registers (a reused MCP server rejoining after an
 * orchestrator-issued close) rather than only its last one.
 *
 * Claims remain in the board independently of refresh joins. Keeping both
 * lifecycle endpoints preserves the liveness record needed to fold those
 * claims, and the retention invariant verifies that compaction did not drop
 * any unresolved claim.
 */
function compactDepartedParticipants(
  entries: readonly CoordinationEntry[],
  liveParticipants: ReadonlySet<string> | undefined,
  activeClaims: readonly CoordinationActiveClaim[],
  now: number,
  maxNoteAgeHours: number
): CoordinationEntry[] {
  const settled = new Set<number>();
  const openJoins = new Map<string, number[]>();
  const unresolvedClaimParticipants = new Set(
    activeClaims.map((claim) => claim.entry.from.participantId)
  );
  // Only consulted without a liveness resolver (a bare store): a participant
  // whose latest join is older than the note window is treated as departed.
  const cutoff = now - maxNoteAgeHours * HOUR_MS;
  const entryBySequence = new Map(entries.map((entry) => [entry.seq, entry]));

  for (const entry of entries) {
    const { participantId } = entry.from;
    if (entry.kind === COORDINATION_ENTRY_KINDS.JOIN) {
      const open = openJoins.get(participantId) ?? [];
      open.push(entry.seq);
      openJoins.set(participantId, open);
    } else if (entry.kind === COORDINATION_ENTRY_KINDS.LEAVE) {
      for (const joinSequence of openJoins.get(participantId) ?? []) {
        settled.add(joinSequence);
      }
      openJoins.delete(participantId);
      settled.add(entry.seq);
    }
  }

  for (const [participantId, joinSequences] of openJoins) {
    const latestJoin = entryBySequence.get(joinSequences.at(-1)!);
    const latestJoinAt = latestJoin ? Date.parse(latestJoin.at) : Number.NaN;
    const departed = liveParticipants
      ? !liveParticipants.has(participantId)
      : Number.isFinite(latestJoinAt) && latestJoinAt < cutoff;
    if (departed && !unresolvedClaimParticipants.has(participantId)) {
      for (const sequence of joinSequences) settled.add(sequence);
      continue;
    }

    for (const sequence of joinSequences.slice(1, -1)) {
      settled.add(sequence);
    }
  }

  return entries.filter((entry) => !settled.has(entry.seq));
}

function compactSettledClaims(
  entries: readonly CoordinationEntry[],
  resolveClaims: CoordinationUnresolvedClaimResolver = unresolvedClaims
): CoordinationEntry[] {
  const activeClaims = resolveClaims(entries);
  const activeByEntry = new Map<number, string[]>();
  for (const claim of activeClaims) {
    const paths = activeByEntry.get(claim.entry.seq) ?? [];
    paths.push(claim.path);
    activeByEntry.set(claim.entry.seq, paths);
  }

  return entries
    .filter((entry) => entry.kind !== COORDINATION_ENTRY_KINDS.RELEASE)
    .flatMap((entry) => {
      if (entry.kind !== COORDINATION_ENTRY_KINDS.CLAIM) return [entry];
      const paths = activeByEntry.get(entry.seq);
      return paths && paths.length > 0 ? [{ ...entry, paths }] : [];
    });
}

/**
 * A note expires once it is older than `maxNoteAgeHours` and its author is no
 * longer on the board. A sibling that is still running may have posted its
 * plan hours ago and it is still the plan, so a live author's notes never age
 * out. Without a liveness resolver (a bare store) age alone decides.
 *
 * Reads and compaction share this predicate, so a note is hidden at exactly
 * the moment it becomes removable rather than lingering until the next write.
 */
function isExpiredNote(
  entry: CoordinationEntry,
  now: number,
  maxNoteAgeHours: number,
  liveParticipants: ReadonlySet<string> | undefined
): boolean {
  if (entry.kind !== COORDINATION_ENTRY_KINDS.NOTE) return false;
  const timestamp = Date.parse(entry.at);
  if (!Number.isFinite(timestamp)) return false;
  if (timestamp >= now - maxNoteAgeHours * HOUR_MS) return false;
  return !liveParticipants?.has(entry.from.participantId);
}

function removeExpiredNotes(
  entries: readonly CoordinationEntry[],
  now: number,
  maxNoteAgeHours: number,
  liveParticipants: ReadonlySet<string> | undefined
): CoordinationEntry[] {
  return entries.filter(
    (entry) => !isExpiredNote(entry, now, maxNoteAgeHours, liveParticipants)
  );
}

function noteContributor(entry: CoordinationEntry): string {
  return entry.from.participantId;
}

function trimNotesToCaps(
  entries: CoordinationEntry[],
  settings: CoordinationRetentionOptions,
  protectedSequence?: number
): CoordinationEntry[] {
  const removable = () =>
    entries.filter(
      (entry) =>
        entry.kind === COORDINATION_ENTRY_KINDS.NOTE &&
        entry.seq !== protectedSequence
    );

  const exceedsCaps = () =>
    entries.length > settings.maxEntries ||
    entries.reduce((total, entry) => total + serializedEntryBytes(entry), 0) >
      settings.maxBoardBytes;

  while (exceedsCaps()) {
    const candidates = removable();
    if (candidates.length === 0) {
      const hasUnresolvedClaims = entries.some(
        (entry) => entry.kind === COORDINATION_ENTRY_KINDS.CLAIM
      );
      throw new Error(
        hasUnresolvedClaims
          ? "Coordination board capacity exceeded: unresolved claims fill the board; release claims or increase maxEntries or maxBoardBytes"
          : "Coordination board capacity exceeded: only non-evictable participant lifecycle entries remain; increase maxEntries or maxBoardBytes"
      );
    }

    const contribution = new Map<string, { bytes: number; count: number }>();
    for (const entry of candidates) {
      const current = contribution.get(noteContributor(entry)) ?? {
        bytes: 0,
        count: 0,
      };
      current.bytes += serializedEntryBytes(entry);
      current.count += 1;
      contribution.set(noteContributor(entry), current);
    }
    const largestContributor = [...contribution.entries()].sort(
      ([leftId, left], [rightId, right]) =>
        right.bytes - left.bytes ||
        right.count - left.count ||
        leftId.localeCompare(rightId)
    )[0][0];
    const note = candidates.find(
      (entry) => noteContributor(entry) === largestContributor
    );
    entries.splice(entries.indexOf(note!), 1);
  }

  return entries;
}

function sameEntries(
  left: readonly CoordinationEntry[],
  right: readonly CoordinationEntry[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (entry, index) =>
        right[index] && JSON.stringify(entry) === JSON.stringify(right[index])
    )
  );
}

export class ExecutionRootCoordinationStore {
  private readonly options: CoordinationStoreOptions;

  constructor(
    private readonly executionRoot: string,
    options: CoordinationStoreOptions = {}
  ) {
    this.options = options;
  }

  async getScopeInfo(): Promise<CoordinationBoardScope> {
    return readScopeStorage(
      await resolveExecutionRootScope(this.executionRoot)
    );
  }

  async append(entry: CoordinationEntryInput): Promise<CoordinationEntry> {
    return this.transaction(async (transaction) => transaction.append(entry));
  }

  async transaction<T>(
    action: (transaction: CoordinationBoardTransaction) => Promise<T>
  ): Promise<T> {
    const scope = await this.getScopeInfo();
    await fs.mkdir(scope.storageRoot, { recursive: true });
    return withFileLock(scope.boardPath, async () => {
      await verifyBoardScope(scope);
      const entries = await readEntries(scope.boardPath);
      let lastSequence = entries.reduce(
        (maximum, entry) => Math.max(maximum, entry.seq),
        0
      );
      const transaction: CoordinationBoardTransaction = {
        entries,
        append: async (entry) => {
          // Compaction rewrites the whole board, so one entry a newer
          // ctrlyoke wrote makes the board read-only for this build.
          const newer = entries.find((existing) =>
            hasNewerSchema(PERSISTED_STORES.COORDINATION_BOARD, existing)
          );
          if (newer) {
            assertWritableSchema(
              PERSISTED_STORES.COORDINATION_BOARD,
              newer,
              scope.boardPath
            );
          }
          if (
            entry.kind === COORDINATION_ENTRY_KINDS.NOTE &&
            (entry.text?.length ?? 0) >
              retentionOptions(this.options.retention).maxNoteLength
          ) {
            throw new Error(
              `Coordination note exceeds maxNoteLength (${retentionOptions(this.options.retention).maxNoteLength} characters)`
            );
          }
          const settings = retentionOptions(this.options.retention);
          const persisted: CoordinationEntry = {
            ...entry,
            schemaVersion:
              CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.COORDINATION_BOARD],
            seq: ++lastSequence,
            at: entry.at ?? new Date().toISOString(),
          };
          const now = this.options.now?.() ?? Date.now();
          const resolveClaims =
            this.options.unresolvedClaims ?? unresolvedClaims;
          const activeClaims = resolveClaims(entries);
          const liveParticipants = this.options.liveParticipants?.(entries);
          const compactedExisting = removeExpiredNotes(
            compactDepartedParticipants(
              compactSettledClaims(entries, this.options.unresolvedClaims),
              liveParticipants,
              activeClaims,
              now,
              settings.maxNoteAgeHours
            ),
            now,
            settings.maxNoteAgeHours,
            liveParticipants
          );
          if (
            !trimmingPreservesUnresolvedClaims(
              entries,
              compactedExisting,
              this.options.unresolvedClaims
            )
          ) {
            throw new Error(
              "Coordination board retention invariant violated: unresolved claim would be dropped"
            );
          }
          const compacted = compactDepartedParticipants(
            compactSettledClaims(
              [...compactedExisting, persisted],
              this.options.unresolvedClaims
            ),
            this.options.liveParticipants?.([...compactedExisting, persisted]),
            resolveClaims([...compactedExisting, persisted]),
            now,
            settings.maxNoteAgeHours
          );
          const fitted = trimNotesToCaps(
            compacted,
            settings,
            compacted.some((candidate) => candidate.seq === persisted.seq)
              ? persisted.seq
              : undefined
          );
          if (!sameEntries(entries, fitted)) {
            await fs.writeFile(
              scope.boardPath,
              fitted.map((candidate) => JSON.stringify(candidate)).join("\n") +
                (fitted.length > 0 ? "\n" : ""),
              "utf8"
            );
          }
          entries.splice(0, entries.length, ...fitted);
          return persisted;
        },
      };
      return action(transaction);
    });
  }

  async read(
    options: CoordinationReadOptions = {}
  ): Promise<CoordinationReadResult> {
    const scope = await this.getScopeInfo();
    try {
      await fs.access(scope.boardPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { entries: [] };
      }
      throw error;
    }

    return withFileLock(scope.boardPath, async () => {
      await verifyBoardScope(scope);
      return this.select(await readEntries(scope.boardPath), options);
    });
  }

  /**
   * Filter and page entries already loaded under the board lock. `read()` and
   * callers holding a {@link transaction} share this, so both hide expired
   * notes identically.
   */
  select(
    entries: readonly CoordinationEntry[],
    options: CoordinationReadOptions = {}
  ): CoordinationReadResult {
    const settings = retentionOptions(this.options.retention);
    const now = this.options.now?.() ?? Date.now();
    const liveParticipants = this.options.liveParticipants?.(entries);
    const from = options.from && new Set(options.from);
    const filtered = entries.filter(
      (entry) =>
        (options.kind === undefined || entry.kind === options.kind) &&
        (options.recipient === undefined ||
          entry.to === undefined ||
          entry.to.includes(options.recipient)) &&
        (options.since === undefined || entry.seq > options.since) &&
        (!from || from.size === 0 || from.has(entry.from.participantId)) &&
        (options.excludeFrom === undefined ||
          entry.from.participantId !== options.excludeFrom) &&
        !isExpiredNote(entry, now, settings.maxNoteAgeHours, liveParticipants)
    );
    const limit = pageSize(options.limit, settings.readNotesPageSize);
    const page = options.latest
      ? filtered.slice(Math.max(0, filtered.length - limit))
      : filtered.slice(0, limit);
    const omitted = filtered.length - page.length;
    if (omitted === 0) return { entries: page };
    return options.latest
      ? { entries: page, omittedOlder: omitted }
      : { entries: page, nextCursor: page.at(-1)?.seq };
  }
}

export async function resolveCoordinationBoardScope(
  executionRoot: string
): Promise<CoordinationBoardScope> {
  return readScopeStorage(await resolveExecutionRootScope(executionRoot));
}

export async function appendCoordinationEntry(
  executionRoot: string,
  entry: CoordinationEntryInput
): Promise<CoordinationEntry> {
  return new ExecutionRootCoordinationStore(executionRoot).append(entry);
}
