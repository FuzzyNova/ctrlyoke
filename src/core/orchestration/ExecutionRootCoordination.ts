import {
  COORDINATION_GLOB_TOKENS,
  COORDINATION_ENTRY_KINDS,
  COORDINATION_PARTICIPANT_KINDS,
  COORDINATION_PARTICIPANT_VIA,
} from "../../types/DashboardConstants";
import { configService } from "../../config/CtrlYokeConfigService";
import type {
  CoordinationEntry,
  CoordinationParticipant,
} from "../../types/CtrlYokeTypes";
import {
  generateOwnerToken,
  isProcessAlive,
  type ProcessLivenessCheck,
} from "../../utils/LockSafetyPrimitives";
import { resolveCoordinationParticipantKind } from "../../utils/CoordinationAttribution";
import { claimPathForCompare } from "../../utils/CoordinationClaimPath";
import {
  ExecutionRootCoordinationStore,
  DEFAULT_COORDINATION_SETTINGS,
  type CoordinationActiveClaim,
  type CoordinationReadOptions,
  type CoordinationReadResult,
  type CoordinationRetentionOptions,
  type CoordinationBoardTransaction,
  type CoordinationLiveParticipantResolver,
  type CoordinationUnresolvedClaimResolver,
} from "./ExecutionRootCoordinationStore";

export const COORDINATION_CLI_LEASE_TTL_MS =
  DEFAULT_COORDINATION_SETTINGS.cliParticipantTtlMinutes * 60 * 1_000;
export const DEFAULT_COORDINATION_CLI_PARTICIPANT_TTL_MINUTES =
  DEFAULT_COORDINATION_SETTINGS.cliParticipantTtlMinutes;

export interface CoordinationParticipantRegistration {
  kind: CoordinationParticipant["kind"];
  label: string;
  via: CoordinationParticipant["via"];
  address?: CoordinationParticipant["address"];
}

export interface CoordinationParticipantFold {
  participants: CoordinationParticipant[];
  claims: CoordinationClaim[];
}

export interface CoordinationClaim {
  path: string;
  owner: CoordinationParticipant;
  reason?: string;
  claimedAtSequence: number;
}

export interface CoordinationDeniedClaim {
  path: string;
  owner: CoordinationParticipant;
}

export interface CoordinationClaimResult {
  granted: string[];
  denied: CoordinationDeniedClaim[];
  claims: CoordinationClaim[];
}

export interface CoordinationParticipantLease extends CoordinationParticipant {
  heartbeat(): Promise<void>;
  leave(): Promise<void>;
  claim(
    paths: readonly string[],
    reason?: string
  ): Promise<CoordinationClaimResult>;
  release(paths?: readonly string[]): Promise<string[]>;
}

export interface CoordinationFoldOptions {
  now?: number;
  processLivenessCheck?: ProcessLivenessCheck;
}

function hasRunAddress(
  participant: CoordinationParticipant,
  address: NonNullable<CoordinationParticipant["address"]>
): boolean {
  return (
    participant.kind === COORDINATION_PARTICIPANT_KINDS.CTRL_YOKE_STEP &&
    participant.address?.workflowKey === address.workflowKey &&
    participant.address?.runRef === address.runRef
  );
}

interface ParticipantLeaseRecord {
  participant: CoordinationParticipant;
  live: boolean;
}

function participantFromEntry(
  entry: CoordinationEntry
): CoordinationParticipant | undefined {
  if (entry.participant) return entry.participant;
  if (entry.kind !== COORDINATION_ENTRY_KINDS.JOIN) return undefined;

  return {
    participantId: entry.from.participantId,
    kind: resolveCoordinationParticipantKind(
      entry.from.kind,
      entry.from.address
    ),
    attested: entry.from.attested,
    label: entry.from.label,
    via: entry.via,
    ...(entry.from.address ? { address: entry.from.address } : {}),
  };
}

function isParticipantLive(
  participant: CoordinationParticipant,
  now: number,
  processLivenessCheck: ProcessLivenessCheck
): boolean {
  if (participant.via === COORDINATION_PARTICIPANT_VIA.MCP) {
    // PID liveness alone, not isOwnerStale's heartbeat-staleness half: unlike
    // runner locks/execution leases, nothing heartbeats a coordination
    // participant on a timer (HEARTBEAT_INTERVAL_MS) — lastHeartbeat only
    // advances when the participant happens to call a coordination tool, so a
    // quiet-but-alive agent would otherwise go "stale" after STALE_HEARTBEAT_MS
    // (30s) and be wrongly reaped, per Decision 2 of
    // EXECUTION_ROOT_COORDINATION_PLAN.md ("PID first, TTL only as a backstop").
    return (
      participant.pid !== undefined && processLivenessCheck(participant.pid)
    );
  }

  return (
    participant.leaseExpiresAt !== undefined && participant.leaseExpiresAt > now
  );
}

function pathsOverlap(left: string, right: string): boolean {
  const leftSegments = claimPathForCompare(left).split("/").filter(Boolean);
  const rightSegments = claimPathForCompare(right).split("/").filter(Boolean);
  // A claim includes its exact path and every descendant. Appending a globstar
  // represents that coverage for both literal and patterned claims.
  leftSegments.push(COORDINATION_GLOB_TOKENS.GLOBSTAR_SEGMENT);
  rightSegments.push(COORDINATION_GLOB_TOKENS.GLOBSTAR_SEGMENT);
  return globPatternsOverlap(leftSegments, rightSegments);
}

function findConflictingClaim(
  claims: Iterable<CoordinationClaim>,
  path: string,
  participantId: string
): CoordinationClaim | undefined {
  for (const claim of claims) {
    if (
      claim.owner.participantId !== participantId &&
      pathsOverlap(claim.path, path)
    ) {
      return claim;
    }
  }
  return undefined;
}

type SegmentToken =
  | { kind: typeof COORDINATION_GLOB_TOKENS.STAR }
  | { kind: typeof COORDINATION_GLOB_TOKENS.ANY }
  | { kind: typeof COORDINATION_GLOB_TOKENS.LITERAL; value: string }
  | {
      kind: typeof COORDINATION_GLOB_TOKENS.CLASS;
      ranges: Array<[number, number]>;
      negated: boolean;
    };

function parseSegment(pattern: string): SegmentToken[] | undefined {
  const tokens: SegmentToken[] = [];
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === "\\") {
      if (index + 1 >= pattern.length) return undefined;
      tokens.push({
        kind: COORDINATION_GLOB_TOKENS.LITERAL,
        value: pattern[index + 1],
      });
      index += 2;
    } else if (character === "*") {
      if (tokens[tokens.length - 1]?.kind !== COORDINATION_GLOB_TOKENS.STAR)
        tokens.push({ kind: COORDINATION_GLOB_TOKENS.STAR });
      index += 1;
    } else if (character === "?") {
      tokens.push({ kind: COORDINATION_GLOB_TOKENS.ANY });
      index += 1;
    } else if (character === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing < 0 || closing === index + 1) return undefined;
      let content = pattern.slice(index + 1, closing);
      const negated = content[0] === "!";
      if (negated) content = content.slice(1);
      if (
        !content ||
        content.includes("[") ||
        content.includes("/") ||
        content.includes("\\")
      )
        return undefined;
      const ranges: Array<[number, number]> = [];
      for (let offset = 0; offset < content.length; offset += 1) {
        const start = content.charCodeAt(offset);
        if (content[offset + 1] === "-") {
          if (offset + 2 >= content.length) return undefined;
          const end = content.charCodeAt(offset + 2);
          if (start > end) return undefined;
          ranges.push([start, end]);
          offset += 2;
        } else {
          ranges.push([start, start]);
        }
      }
      tokens.push({ kind: COORDINATION_GLOB_TOKENS.CLASS, ranges, negated });
      index = closing + 1;
    } else {
      tokens.push({ kind: COORDINATION_GLOB_TOKENS.LITERAL, value: character });
      index += 1;
    }
  }
  return tokens;
}

function tokenAccepts(token: SegmentToken, code: number): boolean {
  if (code === 47) return false;
  if (
    token.kind === COORDINATION_GLOB_TOKENS.ANY ||
    token.kind === COORDINATION_GLOB_TOKENS.STAR
  )
    return true;
  if (token.kind === COORDINATION_GLOB_TOKENS.LITERAL)
    return token.value.charCodeAt(0) === code;
  const included = token.ranges.some(
    ([start, end]) => code >= start && code <= end
  );
  return token.negated ? !included : included;
}

function tokensOverlap(left: SegmentToken, right: SegmentToken): boolean {
  // Unicode is represented as UTF-16 code units, so checking range boundaries
  // and literals is sufficient to decide whether these predicates intersect.
  const candidates = new Set<number>([0, 1, 46, 47, 48, 65, 97, 0xffff]);
  for (const token of [left, right]) {
    if (token.kind === COORDINATION_GLOB_TOKENS.LITERAL)
      candidates.add(token.value.charCodeAt(0));
    if (token.kind === COORDINATION_GLOB_TOKENS.CLASS) {
      for (const [start, end] of token.ranges) {
        candidates.add(start);
        candidates.add(end);
        if (start > 0) candidates.add(start - 1);
        if (end < 0xffff) candidates.add(end + 1);
      }
    }
  }
  return [...candidates].some(
    (code) => tokenAccepts(left, code) && tokenAccepts(right, code)
  );
}

function segmentsOverlap(left: string, right: string): boolean {
  const leftTokens = parseSegment(left);
  const rightTokens = parseSegment(right);
  // Unknown class/escape syntax is treated as possibly intersecting.
  if (!leftTokens || !rightTokens) return true;
  const visited = new Set<string>();
  const walk = (leftIndex: number, rightIndex: number): boolean => {
    const key = `${leftIndex}:${rightIndex}`;
    if (visited.has(key)) return false;
    visited.add(key);
    if (leftIndex === leftTokens.length && rightIndex === rightTokens.length)
      return true;
    const a = leftTokens[leftIndex];
    const b = rightTokens[rightIndex];
    if (
      a?.kind === COORDINATION_GLOB_TOKENS.STAR &&
      walk(leftIndex + 1, rightIndex)
    )
      return true;
    if (
      b?.kind === COORDINATION_GLOB_TOKENS.STAR &&
      walk(leftIndex, rightIndex + 1)
    )
      return true;
    if (a && b && tokensOverlap(a, b)) {
      const nextA =
        a.kind === COORDINATION_GLOB_TOKENS.STAR ? leftIndex : leftIndex + 1;
      const nextB =
        b.kind === COORDINATION_GLOB_TOKENS.STAR ? rightIndex : rightIndex + 1;
      if (walk(nextA, nextB)) return true;
    }
    return false;
  };
  return walk(0, 0);
}

function globPatternsOverlap(
  left: readonly string[],
  right: readonly string[]
): boolean {
  const visited = new Set<string>();
  const walk = (leftIndex: number, rightIndex: number): boolean => {
    const key = `${leftIndex}:${rightIndex}`;
    if (visited.has(key)) return false;
    visited.add(key);
    if (leftIndex === left.length && rightIndex === right.length) return true;
    const a = left[leftIndex];
    const b = right[rightIndex];
    if (
      a === COORDINATION_GLOB_TOKENS.GLOBSTAR_SEGMENT &&
      walk(leftIndex + 1, rightIndex)
    )
      return true;
    if (
      b === COORDINATION_GLOB_TOKENS.GLOBSTAR_SEGMENT &&
      walk(leftIndex, rightIndex + 1)
    )
      return true;
    if (
      a !== undefined &&
      b !== undefined &&
      a !== COORDINATION_GLOB_TOKENS.GLOBSTAR_SEGMENT &&
      b !== COORDINATION_GLOB_TOKENS.GLOBSTAR_SEGMENT &&
      segmentsOverlap(a, b)
    ) {
      if (walk(leftIndex + 1, rightIndex + 1)) return true;
    }
    if (
      a === COORDINATION_GLOB_TOKENS.GLOBSTAR_SEGMENT &&
      rightIndex < right.length &&
      b !== COORDINATION_GLOB_TOKENS.GLOBSTAR_SEGMENT &&
      walk(leftIndex, rightIndex + 1)
    )
      return true;
    if (
      b === COORDINATION_GLOB_TOKENS.GLOBSTAR_SEGMENT &&
      leftIndex < left.length &&
      a !== COORDINATION_GLOB_TOKENS.GLOBSTAR_SEGMENT &&
      walk(leftIndex + 1, rightIndex)
    )
      return true;
    return false;
  };
  return walk(0, 0);
}

export function foldCoordinationEntries(
  entries: readonly CoordinationEntry[],
  options: CoordinationFoldOptions = {}
): CoordinationParticipantFold {
  const now = options.now ?? Date.now();
  const processLivenessCheck = options.processLivenessCheck ?? isProcessAlive;
  const participantRecords = new Map<string, ParticipantLeaseRecord>();
  const claims = new Map<string, CoordinationClaim>();
  const activeLifecycles = new Map<string, ParticipantLeaseRecord>();
  const lifecycleByEntry = new Map<CoordinationEntry, ParticipantLeaseRecord>();

  // Refresh joins update one lifecycle's liveness for every claim/release in
  // that lifecycle. Resolve the latest join first so an earlier lease expiring
  // does not erase claims that a later refresh still keeps live.
  for (const entry of entries) {
    if (entry.kind === COORDINATION_ENTRY_KINDS.JOIN) {
      const participant = participantFromEntry(entry);
      if (!participant) continue;
      const lifecycle = activeLifecycles.get(participant.participantId) ?? {
        participant,
        live: false,
      };
      lifecycle.participant = participant;
      lifecycle.live = isParticipantLive(
        participant,
        now,
        processLivenessCheck
      );
      activeLifecycles.set(participant.participantId, lifecycle);
      lifecycleByEntry.set(entry, lifecycle);
    } else if (entry.kind === COORDINATION_ENTRY_KINDS.LEAVE) {
      const lifecycle = activeLifecycles.get(entry.from.participantId);
      if (lifecycle) lifecycleByEntry.set(entry, lifecycle);
      activeLifecycles.delete(entry.from.participantId);
    } else {
      const lifecycle = activeLifecycles.get(entry.from.participantId);
      if (lifecycle) lifecycleByEntry.set(entry, lifecycle);
    }
  }

  for (const entry of entries) {
    const lifecycle = lifecycleByEntry.get(entry);
    if (entry.kind === COORDINATION_ENTRY_KINDS.JOIN && lifecycle) {
      participantRecords.set(lifecycle.participant.participantId, lifecycle);
      continue;
    }

    if (entry.kind === COORDINATION_ENTRY_KINDS.LEAVE) {
      participantRecords.delete(entry.from.participantId);
      for (const [claimPath, claim] of claims) {
        if (claim.owner.participantId === entry.from.participantId) {
          claims.delete(claimPath);
        }
      }
      continue;
    }

    const participantRecord = lifecycle;
    if (!participantRecord?.live) continue;

    if (entry.kind === COORDINATION_ENTRY_KINDS.CLAIM) {
      for (const claimPath of entry.paths ?? []) {
        const existing = findConflictingClaim(
          claims.values(),
          claimPath,
          entry.from.participantId
        );
        if (existing) continue;
        claims.set(claimPath, {
          path: claimPath,
          owner: participantRecord.participant,
          ...(entry.reason ? { reason: entry.reason } : {}),
          claimedAtSequence: entry.seq,
        });
      }
    } else if (entry.kind === COORDINATION_ENTRY_KINDS.RELEASE) {
      const releasePaths = entry.paths?.map(claimPathForCompare);
      for (const [claimPath, claim] of claims) {
        if (
          claim.owner.participantId === entry.from.participantId &&
          (releasePaths === undefined ||
            releasePaths.includes(claimPathForCompare(claimPath)))
        ) {
          claims.delete(claimPath);
        }
      }
    }
  }

  return {
    participants: [...participantRecords.values()]
      .filter((record) => record.live)
      .map((record) => record.participant),
    claims: [...claims.values()],
  };
}

function participantEntry(
  participant: CoordinationParticipant,
  kind: "join" | "leave" | "release"
): Omit<CoordinationEntry, "seq" | "at"> {
  return {
    kind,
    from: {
      participantId: participant.participantId,
      label: participant.label,
      kind: participant.kind,
      attested: participant.attested,
      ...(participant.address ? { address: participant.address } : {}),
    },
    via: participant.via,
    ...(kind === COORDINATION_ENTRY_KINDS.JOIN ? { participant } : {}),
  };
}

function sameParticipantAddress(
  left: CoordinationParticipant["address"],
  right: CoordinationParticipant["address"]
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.workflowKey === right.workflowKey &&
    left.runRef === right.runRef &&
    left.stepIndex === right.stepIndex &&
    left.parallelGroupId === right.parallelGroupId
  );
}

/**
 * A CLI-delivered participant has no process that outlives one tool call, so
 * each call registers again. Its run address is the only stable identity it
 * has; reuse the live participant already holding that address so its claims
 * stay releasable across calls. Addressless (external) CLI callers have no
 * stable key and still register per call.
 */
function findResumableCliParticipant(
  participants: readonly CoordinationParticipant[],
  registration: CoordinationParticipantRegistration,
  attested: boolean
): CoordinationParticipant | undefined {
  if (
    registration.via !== COORDINATION_PARTICIPANT_VIA.CLI ||
    !registration.address
  ) {
    return undefined;
  }
  return participants.find(
    (participant) =>
      participant.via === COORDINATION_PARTICIPANT_VIA.CLI &&
      participant.kind === registration.kind &&
      participant.attested === attested &&
      sameParticipantAddress(participant.address, registration.address)
  );
}

function findLiveParticipant(
  entries: readonly CoordinationEntry[],
  participantId: string,
  options?: CoordinationFoldOptions
): CoordinationParticipant | undefined {
  return foldCoordinationEntries(entries, options).participants.find(
    (participant) => participant.participantId === participantId
  );
}

export class CoordinationParticipantRegistry {
  private readonly store: ExecutionRootCoordinationStore;
  private readonly processLivenessCheck?: ProcessLivenessCheck;
  private readonly now: () => number;

  constructor(
    executionRoot: string,
    options: {
      now?: () => number;
      processLivenessCheck?: ProcessLivenessCheck;
      retention?: Partial<CoordinationRetentionOptions>;
      cliParticipantTtlMinutes?: number;
    } = {}
  ) {
    this.store = new ExecutionRootCoordinationStore(executionRoot, {
      ...(options.retention ? { retention: options.retention } : {}),
      ...(options.now ? { now: options.now } : {}),
      unresolvedClaims: ((entries) =>
        this.resolveLiveClaims(
          entries
        )) satisfies CoordinationUnresolvedClaimResolver,
      liveParticipants: ((entries) =>
        this.resolveLiveParticipantIds(
          entries
        )) satisfies CoordinationLiveParticipantResolver,
    });
    this.now = options.now ?? Date.now;
    this.processLivenessCheck = options.processLivenessCheck;
    this.cliParticipantTtlMinutes = options.cliParticipantTtlMinutes;
  }

  private readonly cliParticipantTtlMinutes?: number;

  private resolveLiveParticipantIds(
    entries: readonly CoordinationEntry[]
  ): ReadonlySet<string> {
    return new Set(
      foldCoordinationEntries(entries, this.foldOptions()).participants.map(
        (participant) => participant.participantId
      )
    );
  }

  private resolveLiveClaims(
    entries: readonly CoordinationEntry[]
  ): CoordinationActiveClaim[] {
    const liveClaims = foldCoordinationEntries(
      entries,
      this.foldOptions()
    ).claims;
    return liveClaims.flatMap((claim) => {
      const entry = entries.find(
        (candidate) =>
          candidate.seq === claim.claimedAtSequence &&
          candidate.kind === COORDINATION_ENTRY_KINDS.CLAIM &&
          candidate.paths?.includes(claim.path)
      );
      return entry ? [{ entry, path: claim.path }] : [];
    });
  }

  async registerParticipant(
    registration: CoordinationParticipantRegistration
  ): Promise<CoordinationParticipantLease> {
    return this.register(registration, false);
  }

  async registerAttestedParticipant(
    registration: CoordinationParticipantRegistration
  ): Promise<CoordinationParticipantLease> {
    return this.register(registration, true);
  }

  async heartbeatParticipant(
    participantId: string
  ): Promise<CoordinationParticipant> {
    return this.store.transaction((transaction) =>
      this.refresh(participantId, transaction)
    );
  }

  async leaveParticipant(participantId: string): Promise<void> {
    await this.store.transaction(async (transaction) => {
      const participant = findLiveParticipant(
        transaction.entries,
        participantId,
        this.foldOptions()
      );
      if (participant) {
        await transaction.append(
          participantEntry(participant, COORDINATION_ENTRY_KINDS.LEAVE)
        );
      }
    });
  }

  /**
   * Close ctrlyoke participants for a settled run target. Sequential
   * participants are run-scoped because a reused PTY can retain an older
   * step index; grouped participants are narrowed by their group and step.
   */
  async closeRunParticipants(
    address: NonNullable<CoordinationParticipant["address"]>
  ): Promise<void> {
    await this.store.transaction(async (transaction) => {
      const participants = foldCoordinationEntries(
        transaction.entries,
        this.foldOptions()
      ).participants.filter(
        (participant) =>
          hasRunAddress(participant, address) &&
          (address.parallelGroupId === undefined
            ? participant.address?.parallelGroupId === undefined
            : participant.address?.parallelGroupId ===
                address.parallelGroupId &&
              participant.address?.stepIndex === address.stepIndex)
      );
      for (const participant of participants) {
        await transaction.append(
          participantEntry(participant, COORDINATION_ENTRY_KINDS.LEAVE)
        );
      }
    });
  }

  /** Close every participant from a group after its join boundary. */
  async closeGroupParticipants(
    address: NonNullable<CoordinationParticipant["address"]>
  ): Promise<void> {
    if (!address.parallelGroupId) return;
    await this.store.transaction(async (transaction) => {
      const participants = foldCoordinationEntries(
        transaction.entries,
        this.foldOptions()
      ).participants.filter(
        (participant) =>
          hasRunAddress(participant, address) &&
          participant.address?.parallelGroupId === address.parallelGroupId
      );
      for (const participant of participants) {
        await transaction.append(
          participantEntry(participant, COORDINATION_ENTRY_KINDS.LEAVE)
        );
      }
    });
  }

  /** Release claims without closing the group participants themselves. */
  async releaseClaimsForGroup(
    address: NonNullable<CoordinationParticipant["address"]>
  ): Promise<void> {
    if (!address.parallelGroupId) return;
    await this.store.transaction(async (transaction) => {
      const fold = foldCoordinationEntries(
        transaction.entries,
        this.foldOptions()
      );
      for (const participant of fold.participants) {
        if (
          !hasRunAddress(participant, address) ||
          participant.address?.parallelGroupId !== address.parallelGroupId
        ) {
          continue;
        }
        const paths = fold.claims
          .filter(
            (claim) => claim.owner.participantId === participant.participantId
          )
          .map((claim) => claim.path);
        if (paths.length > 0) {
          await transaction.append({
            ...participantEntry(participant, COORDINATION_ENTRY_KINDS.RELEASE),
            paths,
          });
        }
      }
    });
  }

  /** A read: it never creates the board, so the dashboard can call it anywhere. */
  async fold(): Promise<CoordinationParticipantFold> {
    return foldCoordinationEntries(
      await this.store.readAll(),
      this.foldOptions()
    );
  }

  async postNote(
    participantId: string,
    text: string,
    to?: readonly string[]
  ): Promise<CoordinationEntry> {
    return this.store.transaction(async (transaction) => {
      const participant = await this.refresh(participantId, transaction);
      return transaction.append({
        kind: COORDINATION_ENTRY_KINDS.NOTE,
        from: {
          participantId: participant.participantId,
          label: participant.label,
          kind: participant.kind,
          attested: participant.attested,
          ...(participant.address ? { address: participant.address } : {}),
        },
        ...(to && to.length > 0 ? { to: [...to] } : {}),
        text,
        via: participant.via,
      });
    });
  }

  /**
   * Read the notes this participant has not seen yet.
   *
   * The cursor lives on the participant's lease record rather than with the
   * caller, because a skill-mode caller is a fresh process per call and has
   * nowhere else to keep it. Without `since`, a participant's first read
   * returns the newest page (older matches are only counted) and later reads
   * return what arrived since. An explicit `since` pages from there instead;
   * it never moves the cursor backwards. A `from` filter leaves the cursor
   * alone, since notes it skipped have not been read. A reader's own notes are
   * left out unless `from` asks for them.
   */
  async readNotes(
    participantId: string,
    options: { since?: number; from?: readonly string[] } = {}
  ): Promise<CoordinationReadResult> {
    return this.store.transaction(async (transaction) => {
      const participant = this.requireLiveParticipant(
        transaction.entries,
        participantId
      );
      const cursor = options.since ?? participant.readCursor;
      const filtered = options.from !== undefined && options.from.length > 0;
      const result = this.store.select(transaction.entries, {
        kind: COORDINATION_ENTRY_KINDS.NOTE,
        recipient: participantId,
        ...(filtered ? { from: options.from } : { excludeFrom: participantId }),
        ...(cursor === undefined ? { latest: true } : { since: cursor }),
      });
      const boardHead = transaction.entries.reduce(
        (maximum, entry) => Math.max(maximum, entry.seq),
        0
      );
      const readThrough = result.nextCursor ?? boardHead;
      const readCursor = filtered
        ? participant.readCursor
        : Math.max(participant.readCursor ?? 0, readThrough);
      await this.refresh(participantId, transaction, {
        ...(readCursor !== undefined ? { readCursor } : {}),
      });
      return result;
    });
  }

  /** Read a page of raw board entries, hiding expired notes like {@link readNotes}. */
  async readEntries(
    options: CoordinationReadOptions = {}
  ): Promise<CoordinationReadResult> {
    return this.store.read(options);
  }

  /**
   * Return the live participants when they differ from the set this
   * participant was last shown, recording the new set; otherwise `undefined`.
   * Lets tool responses carry the participant list only when it changed.
   */
  async participantsIfChanged(
    participantId: string
  ): Promise<CoordinationParticipant[] | undefined> {
    return this.store.transaction(async (transaction) => {
      const { participants } = foldCoordinationEntries(
        transaction.entries,
        this.foldOptions()
      );
      const participant = participants.find(
        (candidate) => candidate.participantId === participantId
      );
      const seenParticipants = participants
        .map((candidate) => candidate.participantId)
        .sort()
        .join(",");
      if (!participant || participant.seenParticipants === seenParticipants) {
        return undefined;
      }
      await this.refresh(participantId, transaction, { seenParticipants });
      return participants;
    });
  }

  private async register(
    registration: CoordinationParticipantRegistration,
    attested: boolean
  ): Promise<CoordinationParticipantLease> {
    if (!registration.label.trim()) {
      throw new Error("Coordination participant label is required");
    }
    if (
      registration.kind === COORDINATION_PARTICIPANT_KINDS.EXTERNAL &&
      !configService.get("coordination").allowExternalParticipants
    ) {
      throw new Error("External coordination participants are disabled");
    }
    // Find and register under one board lock, so two concurrent CLI calls
    // from the same step cannot both miss and register twice.
    return this.store.transaction(async (transaction) => {
      const resumable = findResumableCliParticipant(
        foldCoordinationEntries(transaction.entries, this.foldOptions())
          .participants,
        registration,
        attested
      );
      if (resumable) {
        return this.createLease(
          await this.refresh(resumable.participantId, transaction)
        );
      }

      const now = this.now();
      const participant: CoordinationParticipant = {
        participantId: generateOwnerToken(),
        kind: registration.kind,
        attested,
        label: registration.label,
        via: registration.via,
        ...(registration.address ? { address: registration.address } : {}),
        ...(registration.via === COORDINATION_PARTICIPANT_VIA.MCP
          ? { pid: process.pid, lastHeartbeat: now }
          : {
              leaseExpiresAt:
                now + this.getCliParticipantTtlMinutes() * 60 * 1_000,
            }),
      };
      await transaction.append(
        participantEntry(participant, COORDINATION_ENTRY_KINDS.JOIN)
      );
      return this.createLease(participant);
    });
  }

  private foldOptions(): CoordinationFoldOptions {
    return {
      now: this.now(),
      ...(this.processLivenessCheck
        ? { processLivenessCheck: this.processLivenessCheck }
        : {}),
    };
  }

  private requireLiveParticipant(
    entries: readonly CoordinationEntry[],
    participantId: string
  ): CoordinationParticipant {
    const participant = findLiveParticipant(
      entries,
      participantId,
      this.foldOptions()
    );
    if (!participant) {
      throw new Error(`Coordination participant is not live: ${participantId}`);
    }
    return participant;
  }

  /**
   * Extend the participant's lease by appending a fresh join. `update` carries
   * per-participant reader state (read cursor, participants last shown) on
   * that same record, so it survives across one-shot CLI calls.
   */
  private async refresh(
    participantId: string,
    transaction: CoordinationBoardTransaction,
    update: Pick<
      CoordinationParticipant,
      "readCursor" | "seenParticipants"
    > = {}
  ): Promise<CoordinationParticipant> {
    const participant = {
      ...this.requireLiveParticipant(transaction.entries, participantId),
      ...update,
    };
    const now = this.now();
    const refreshed: CoordinationParticipant =
      participant.via === COORDINATION_PARTICIPANT_VIA.MCP
        ? { ...participant, lastHeartbeat: now }
        : {
            ...participant,
            leaseExpiresAt:
              now + this.getCliParticipantTtlMinutes() * 60 * 1_000,
          };
    await transaction.append(
      participantEntry(refreshed, COORDINATION_ENTRY_KINDS.JOIN)
    );
    return refreshed;
  }

  private getCliParticipantTtlMinutes(): number {
    const configuredTtlMinutes =
      this.cliParticipantTtlMinutes ??
      configService.get("coordination").cliParticipantTtlMinutes;
    return configuredTtlMinutes > 0 && Number.isFinite(configuredTtlMinutes)
      ? configuredTtlMinutes
      : DEFAULT_COORDINATION_CLI_PARTICIPANT_TTL_MINUTES;
  }

  private createLease(
    initialParticipant: CoordinationParticipant
  ): CoordinationParticipantLease {
    let participant = initialParticipant;
    let closed = false;
    const assertOpen = () => {
      if (closed) throw new Error("Coordination participant lease is closed");
    };
    const lease: CoordinationParticipantLease = {
      ...participant,
      heartbeat: async () => {
        assertOpen();
        participant = await this.heartbeatParticipant(
          participant.participantId
        );
        Object.assign(lease, participant);
      },
      leave: async () => {
        if (closed) return;
        await this.leaveParticipant(participant.participantId);
        closed = true;
      },
      claim: (paths, reason) => {
        assertOpen();
        return this.claimPaths(participant.participantId, paths, reason).then(
          async (result) => {
            await this.syncLease(lease, participant);
            return result;
          }
        );
      },
      release: (paths) => {
        assertOpen();
        return this.releasePaths(participant.participantId, paths).then(
          async (result) => {
            await this.syncLease(lease, participant);
            return result;
          }
        );
      },
    };
    return lease;
  }

  private async syncLease(
    lease: CoordinationParticipantLease,
    current: CoordinationParticipant
  ): Promise<void> {
    const refreshed = (await this.fold()).participants.find(
      (candidate) => candidate.participantId === current.participantId
    );
    if (refreshed) Object.assign(lease, refreshed);
  }

  async claimPaths(
    participantId: string,
    paths: readonly string[],
    reason?: string
  ): Promise<CoordinationClaimResult> {
    return this.store.transaction(async (transaction) => {
      const participant = await this.refresh(participantId, transaction);
      const fold = foldCoordinationEntries(
        transaction.entries,
        this.foldOptions()
      );
      const granted: string[] = [];
      const denied: CoordinationDeniedClaim[] = [];
      for (const claimPath of paths) {
        const conflictingClaim = findConflictingClaim(
          fold.claims,
          claimPath,
          participant.participantId
        );
        if (conflictingClaim) {
          denied.push({ path: claimPath, owner: conflictingClaim.owner });
        } else {
          granted.push(claimPath);
        }
      }
      if (granted.length > 0) {
        await transaction.append({
          kind: COORDINATION_ENTRY_KINDS.CLAIM,
          from: {
            participantId: participant.participantId,
            label: participant.label,
            kind: participant.kind,
            attested: participant.attested,
            ...(participant.address ? { address: participant.address } : {}),
          },
          paths: granted,
          ...(reason ? { reason } : {}),
          via: participant.via,
        });
      }
      const nextFold = foldCoordinationEntries(
        transaction.entries,
        this.foldOptions()
      );
      return { granted, denied, claims: nextFold.claims };
    });
  }

  async releasePaths(
    participantId: string,
    paths?: readonly string[]
  ): Promise<string[]> {
    return this.store.transaction(async (transaction) => {
      const participant = await this.refresh(participantId, transaction);
      const fold = foldCoordinationEntries(
        transaction.entries,
        this.foldOptions()
      );
      const released = fold.claims
        .filter(
          (claim) =>
            claim.owner.participantId === participant.participantId &&
            (paths === undefined ||
              paths.some(
                (path) =>
                  claimPathForCompare(path) === claimPathForCompare(claim.path)
              ))
        )
        .map((claim) => claim.path);
      if (released.length > 0) {
        await transaction.append({
          ...participantEntry(participant, COORDINATION_ENTRY_KINDS.RELEASE),
          ...(paths ? { paths: [...paths] } : {}),
        });
      }
      return released;
    });
  }
}
