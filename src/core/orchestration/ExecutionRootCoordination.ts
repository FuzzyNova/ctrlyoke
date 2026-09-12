import {
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
  isOwnerStale,
  type ProcessLivenessCheck,
} from "../../utils/LockSafetyPrimitives";
import {
  ExecutionRootCoordinationStore,
  DEFAULT_COORDINATION_SETTINGS,
  type CoordinationActiveClaim,
  type CoordinationRetentionOptions,
  type CoordinationBoardTransaction,
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
    kind: entry.from.address
      ? COORDINATION_PARTICIPANT_KINDS.CTRL_YOKE_STEP
      : COORDINATION_PARTICIPANT_KINDS.EXTERNAL,
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
    return (
      participant.pid !== undefined &&
      participant.lastHeartbeat !== undefined &&
      !isOwnerStale(
        participant.pid,
        participant.lastHeartbeat,
        now,
        processLivenessCheck
      )
    );
  }

  return (
    participant.leaseExpiresAt !== undefined && participant.leaseExpiresAt > now
  );
}

function pathsOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return (
    globMatches(left, right) ||
    globMatches(right, left) ||
    globSamplesOverlap(left, right)
  );
}

function hasMagic(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.includes("[");
}

function globMatches(pattern: string, candidate: string): boolean {
  if (!hasMagic(pattern)) return pattern === candidate;

  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        if (pattern[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else {
        expression += "[^/]*";
      }
    } else if (character === "?") {
      expression += "[^/]";
    } else if (character === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing > index + 1) {
        expression += pattern.slice(index, closing + 1);
        index = closing;
      } else {
        expression += "\\[";
      }
    } else {
      expression += escapeRegExp(character);
    }
  }
  expression += "$";
  return new RegExp(expression).test(candidate);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globSamples(pattern: string): string[] {
  const samples = [""];
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      const existing = [...samples];
      for (const sample of existing) samples.push(`${sample}nested/`);
      index += pattern[index + 2] === "/" ? 3 : 2;
      continue;
    }
    if (character === "*" || character === "?") {
      for (const sampleIndex of samples.keys()) {
        samples[sampleIndex] += character === "*" ? "x" : "x";
      }
      index += 1;
      continue;
    }
    if (character === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing > index + 1) {
        const content = pattern.slice(index + 1, closing);
        const candidate = content[0] === "!" ? "x" : content[0];
        for (const sampleIndex of samples.keys())
          samples[sampleIndex] += candidate;
        index = closing + 1;
        continue;
      }
    }
    for (const sampleIndex of samples.keys()) samples[sampleIndex] += character;
    index += 1;
  }
  return samples;
}

function globSamplesOverlap(left: string, right: string): boolean {
  if (!hasMagic(left) && !hasMagic(right)) return false;
  return (
    globSamples(left).some((sample) => globMatches(right, sample)) ||
    globSamples(right).some((sample) => globMatches(left, sample))
  );
}

export function foldCoordinationEntries(
  entries: readonly CoordinationEntry[],
  options: CoordinationFoldOptions = {}
): CoordinationParticipantFold {
  const now = options.now ?? Date.now();
  const processLivenessCheck = options.processLivenessCheck ?? isProcessAlive;
  const participantRecords = new Map<string, ParticipantLeaseRecord>();
  const claims = new Map<string, CoordinationClaim>();

  for (const entry of entries) {
    const participant = participantFromEntry(entry);
    if (entry.kind === COORDINATION_ENTRY_KINDS.JOIN && participant) {
      const live = isParticipantLive(participant, now, processLivenessCheck);
      participantRecords.set(participant.participantId, { participant, live });
      if (!live) {
        for (const [claimPath, claim] of claims) {
          if (claim.owner.participantId === participant.participantId) {
            claims.delete(claimPath);
          }
        }
      }
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

    const participantRecord = participantRecords.get(entry.from.participantId);
    if (!participantRecord?.live) continue;

    if (entry.kind === COORDINATION_ENTRY_KINDS.CLAIM) {
      for (const claimPath of entry.paths ?? []) {
        const existing = [...claims.values()].find((claim) =>
          pathsOverlap(claim.path, claimPath)
        );
        if (
          existing &&
          existing.owner.participantId !== entry.from.participantId
        ) {
          continue;
        }
        claims.set(claimPath, {
          path: claimPath,
          owner: participantRecord.participant,
          ...(entry.reason ? { reason: entry.reason } : {}),
          claimedAtSequence: entry.seq,
        });
      }
    } else if (entry.kind === COORDINATION_ENTRY_KINDS.RELEASE) {
      const releasePaths = entry.paths;
      for (const [claimPath, claim] of claims) {
        if (
          claim.owner.participantId === entry.from.participantId &&
          (releasePaths === undefined || releasePaths.includes(claimPath))
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
      attested: participant.attested,
      ...(participant.address ? { address: participant.address } : {}),
    },
    via: participant.via,
    ...(kind === COORDINATION_ENTRY_KINDS.JOIN ? { participant } : {}),
  };
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
    });
    this.now = options.now ?? Date.now;
    this.processLivenessCheck = options.processLivenessCheck;
    this.cliParticipantTtlMinutes = options.cliParticipantTtlMinutes;
  }

  private readonly cliParticipantTtlMinutes?: number;

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

  async fold(): Promise<CoordinationParticipantFold> {
    return this.store.transaction(async (transaction) =>
      foldCoordinationEntries(transaction.entries, this.foldOptions())
    );
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
    const now = this.now();
    const configuredTtlMinutes =
      this.cliParticipantTtlMinutes ??
      configService.get("coordination").cliParticipantTtlMinutes;
    const ttlMinutes =
      configuredTtlMinutes > 0 && Number.isFinite(configuredTtlMinutes)
        ? configuredTtlMinutes
        : DEFAULT_COORDINATION_CLI_PARTICIPANT_TTL_MINUTES;
    const participant: CoordinationParticipant = {
      participantId: generateOwnerToken(),
      kind: registration.kind,
      attested,
      label: registration.label,
      via: registration.via,
      ...(registration.address ? { address: registration.address } : {}),
      ...(registration.via === COORDINATION_PARTICIPANT_VIA.MCP
        ? { pid: process.pid, lastHeartbeat: now }
        : { leaseExpiresAt: now + ttlMinutes * 60 * 1_000 }),
    };
    await this.store.append(
      participantEntry(participant, COORDINATION_ENTRY_KINDS.JOIN)
    );
    return this.createLease(participant);
  }

  private foldOptions(): CoordinationFoldOptions {
    return {
      now: this.now(),
      ...(this.processLivenessCheck
        ? { processLivenessCheck: this.processLivenessCheck }
        : {}),
    };
  }

  private async refresh(
    participantId: string,
    transaction: CoordinationBoardTransaction
  ): Promise<CoordinationParticipant> {
    const participant = findLiveParticipant(
      transaction.entries,
      participantId,
      this.foldOptions()
    );
    if (!participant) {
      throw new Error(`Coordination participant is not live: ${participantId}`);
    }
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
        const owner = fold.claims.find((claim) =>
          pathsOverlap(claim.path, claimPath)
        )?.owner;
        if (owner && owner.participantId !== participant.participantId) {
          denied.push({ path: claimPath, owner });
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
            (paths === undefined || paths.includes(claim.path))
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
