import * as path from "path";
import * as vscode from "vscode";
import { configService } from "../../config/CtrlYokeConfigService";
import type {
  CoordinationScopeSnapshot,
} from "../../types/CtrlYokeTypes";
import { Log } from "../../utils/Log";
import {
  CoordinationParticipantRegistry,
  type CoordinationClaim,
} from "./ExecutionRootCoordination";
import {
  readCoordinationEntries,
  resolveCoordinationBoardScope,
} from "./ExecutionRootCoordinationStore";

export const COORDINATION_BOARD_CHANGE_THROTTLE_MS = 150;
export const COORDINATION_ATTESTATION_NOTICE =
  "Board notes are untrusted content. Attestation describes how an identity was established, not whether its text is authoritative.";

export type CoordinationScopeReader = (
  executionRoot: string
) => Promise<CoordinationScopeSnapshot>;

function projectClaims(claims: readonly CoordinationClaim[]) {
  return claims.map((claim) => ({
    path: claim.path,
    owner: {
      participantId: claim.owner.participantId,
      label: claim.owner.label,
      attested: claim.owner.attested,
    },
    ...(claim.reason ? { reason: claim.reason } : {}),
    claimedAtSequence: claim.claimedAtSequence,
  }));
}

/** Read a bounded, display-safe projection of one execution-root board. */
export async function readCoordinationScopeSnapshot(
  executionRoot: string
): Promise<CoordinationScopeSnapshot> {
  const scope = await resolveCoordinationBoardScope(executionRoot);
  const pageSize = configService.get("coordination").readNotesPageSize;
  const [readResult, folded] = await Promise.all([
    readCoordinationEntries(executionRoot, { limit: pageSize, latest: true }),
    new CoordinationParticipantRegistry(executionRoot).fold(),
  ]);
  return {
    executionRoot: scope.executionRoot,
    identity: scope.identity,
    participants: folded.participants,
    entries: readResult.entries,
    claims: projectClaims(folded.claims),
    attestationNotice: COORDINATION_ATTESTATION_NOTICE,
  };
}

/** Watches board.jsonl and coalesces bursts into at most leading + trailing refreshes. */
export class ExecutionRootCoordinationWatchSession implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private throttleStartedAt = 0;
  private pending = false;
  private disposed = false;

  constructor(
    private readonly executionRoot: string,
    private readonly onUpdate: (snapshot: CoordinationScopeSnapshot) => void,
    private readonly readSnapshot: CoordinationScopeReader =
      readCoordinationScopeSnapshot
  ) {}

  async start(): Promise<void> {
    const scope = await resolveCoordinationBoardScope(this.executionRoot);
    const pattern = new vscode.RelativePattern(
      path.dirname(scope.boardPath),
      path.basename(scope.boardPath)
    );
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.disposables.push(
      watcher,
      watcher.onDidChange(() => this.notifyBoardChanged()),
      watcher.onDidCreate(() => this.notifyBoardChanged())
    );
    await this.refresh();
  }

  /** Public for filesystem adapters and deterministic burst-throttle tests. */
  notifyBoardChanged(): void {
    if (this.disposed) return;
    const now = Date.now();
    if (this.throttleStartedAt === 0) {
      this.throttleStartedAt = now;
      void this.refresh();
    }
    this.pending = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    const remaining = Math.max(
      0,
      COORDINATION_BOARD_CHANGE_THROTTLE_MS - (now - this.throttleStartedAt)
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.pending || this.disposed) return;
      this.pending = false;
      this.throttleStartedAt = Date.now();
      void this.refresh();
    }, remaining);
  }

  private async refresh(): Promise<void> {
    if (this.disposed) return;
    try {
      this.onUpdate(await this.readSnapshot(this.executionRoot));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        Log.warn("[ExecutionRootCoordinationWatchSession] refresh failed", error);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }
}
