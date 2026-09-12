import * as fs from "fs/promises";
import * as path from "path";
import type { CoordinationEntry } from "../../types/CtrlYokeTypes";
import { withFileLock } from "../../utils/FileLockUtils";
import {
  resolveExecutionRootScope,
  scopeStorageRoot,
  verifyScopeRecord,
  type ExecutionRootScope,
} from "./ExecutionRootScope";

const BOARD_FILE_NAME = "board.jsonl";
const SCOPE_RECORD_FILE_NAME = "scope.json";
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 1_000;

export interface CoordinationBoardScope {
  identity: string;
  scopeHash: string;
  executionRoot: string;
  storageRoot: string;
  boardPath: string;
  scopeRecordPath: string;
}

export type CoordinationEntryInput = Omit<CoordinationEntry, "seq" | "at"> & {
  at?: string;
};

export interface CoordinationReadOptions {
  /** Return entries with sequence numbers strictly greater than this cursor. */
  since?: number;
  /** Restrict results to these participant IDs. */
  from?: readonly string[];
  /** Page size; bounded to prevent an untrusted board from causing huge reads. */
  limit?: number;
}

export interface CoordinationReadResult {
  entries: CoordinationEntry[];
  nextCursor?: number;
}

function readScopeStorage(scope: ExecutionRootScope): CoordinationBoardScope {
  const storageRoot = scopeStorageRoot(scope, "coordination");
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

  return contents
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as CoordinationEntry);
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

function pageSize(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error("Coordination board page size must be a positive number");
  }
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

export class ExecutionRootCoordinationStore {
  constructor(private readonly executionRoot: string) {}

  async getScopeInfo(): Promise<CoordinationBoardScope> {
    return readScopeStorage(
      await resolveExecutionRootScope(this.executionRoot)
    );
  }

  async append(entry: CoordinationEntryInput): Promise<CoordinationEntry> {
    const scope = await this.getScopeInfo();
    await fs.mkdir(scope.storageRoot, { recursive: true });
    return withFileLock(scope.boardPath, async () => {
      await verifyBoardScope(scope);
      const entries = await readEntries(scope.boardPath);
      const lastSequence = entries.at(-1)?.seq ?? 0;
      const persisted: CoordinationEntry = {
        ...entry,
        seq: lastSequence + 1,
        at: entry.at ?? new Date().toISOString(),
      };
      await fs.appendFile(
        scope.boardPath,
        `${JSON.stringify(persisted)}\n`,
        "utf8"
      );
      return persisted;
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
      const entries = await readEntries(scope.boardPath);
      const from = options.from && new Set(options.from);
      const filtered = entries.filter(
        (entry) =>
          (options.since === undefined || entry.seq > options.since) &&
          (!from || from.size === 0 || from.has(entry.from.participantId))
      );
      const limit = pageSize(options.limit);
      const page = filtered.slice(0, limit);
      return {
        entries: page,
        ...(filtered.length > page.length
          ? { nextCursor: page.at(-1)?.seq }
          : {}),
      };
    });
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

export async function readCoordinationEntries(
  executionRoot: string,
  options?: CoordinationReadOptions
): Promise<CoordinationReadResult> {
  return new ExecutionRootCoordinationStore(executionRoot).read(options);
}
