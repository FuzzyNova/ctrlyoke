import * as fs from "fs/promises";
import * as path from "path";
import type { HarnessId } from "../types/DashboardConstants";
import { writeFileAtomic } from "./AtomicFileUtils";
import { PATH_CONSTANTS } from "./ConfigurationUtils";
import { withFileLock } from "./FileLockUtils";
import { Log } from "./Log";
import {
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
  hasNewerSchema,
} from "./PersistedSchemaGuard";
import { projectStateRoot } from "./ProjectStatePaths";
import { getFrozenRunHistoryLocation } from "./RunHistoryStoragePolicy";

/** The agents and skills a harness session has already been sent. */
export interface SessionAttachments {
  agents: string[];
  skills: string[];
}

interface SessionAttachmentEntry extends SessionAttachments {
  updatedAt: number;
}

interface SessionAttachmentLedgerFile {
  schemaVersion: number;
  sessions: Record<string, SessionAttachmentEntry>;
}

/** Oldest sessions are dropped beyond this; a dropped one only re-attaches. */
const DEFAULT_MAX_SESSIONS = 500;

interface SessionAttachmentLedgerOptions {
  maxSessions?: number;
  now?: () => number;
}

/**
 * Per-project record of the agents and skills sent into each harness session,
 * keyed by harness and session ID. Run working files only describe their own
 * steps, so this is what lets a resume of a session started in another run or
 * workflow (Reply to step, an explicit `sessionId`) omit what it already holds.
 *
 * The ledger is an optimisation, never a source of truth: every failure is
 * logged and swallowed, and a file written by a newer ctrlyoke is left alone
 * rather than refused, because the worst outcome of a missing entry is that
 * the instructions are sent again.
 */
export class SessionAttachmentLedger {
  private readonly maxSessions: number;
  private readonly now: () => number;

  constructor(
    private readonly filePath: string,
    options: SessionAttachmentLedgerOptions = {}
  ) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.now = options.now ?? Date.now;
  }

  static forStateRoot(stateRoot: string): SessionAttachmentLedger {
    return new SessionAttachmentLedger(
      path.join(
        projectStateRoot(stateRoot, getFrozenRunHistoryLocation()),
        PATH_CONSTANTS.SESSION_ATTACHMENTS_FILE
      )
    );
  }

  async get(
    harness: HarnessId,
    sessionId: string
  ): Promise<SessionAttachments | undefined> {
    try {
      const entry = (await this.read())?.sessions[this.key(harness, sessionId)];
      return entry ? { agents: entry.agents, skills: entry.skills } : undefined;
    } catch (error) {
      Log.warn(
        `[SessionAttachmentLedger] Could not read ${this.filePath}: ${String(error)}`
      );
      return undefined;
    }
  }

  /** Merge newly sent attachments into the session's entry. */
  async record(
    harness: HarnessId,
    sessionId: string,
    sent: { agent?: string; skills?: readonly string[] }
  ): Promise<void> {
    const agents = sent.agent ? [sent.agent] : [];
    const skills = sent.skills ?? [];
    if (agents.length === 0 && skills.length === 0) {
      return;
    }
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await withFileLock(this.filePath, async () => {
        const existing = await this.read();
        if (existing === null) {
          return;
        }
        const ledger = existing ?? {
          schemaVersion:
            CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.SESSION_ATTACHMENTS],
          sessions: {},
        };
        const key = this.key(harness, sessionId);
        const previous = ledger.sessions[key];
        ledger.sessions[key] = {
          agents: union(previous?.agents, agents),
          skills: union(previous?.skills, skills),
          updatedAt: this.now(),
        };
        this.prune(ledger);
        await writeFileAtomic(this.filePath, JSON.stringify(ledger, null, 2));
      });
    } catch (error) {
      Log.warn(
        `[SessionAttachmentLedger] Could not update ${this.filePath}: ${String(error)}`
      );
    }
  }

  private key(harness: HarnessId, sessionId: string): string {
    return `${harness}:${sessionId}`;
  }

  /**
   * The parsed ledger, `undefined` when absent or malformed (it is rebuilt),
   * or `null` when a newer ctrlyoke wrote it and it must not be touched.
   */
  private async read(): Promise<
    SessionAttachmentLedgerFile | null | undefined
  > {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (hasNewerSchema(PERSISTED_STORES.SESSION_ATTACHMENTS, parsed)) {
      return null;
    }
    const sessions = (parsed as Partial<SessionAttachmentLedgerFile> | null)
      ?.sessions;
    if (!sessions || typeof sessions !== "object") {
      return undefined;
    }
    return {
      schemaVersion:
        CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.SESSION_ATTACHMENTS],
      sessions: Object.fromEntries(
        Object.entries(sessions).flatMap(([key, entry]) =>
          isEntry(entry) ? [[key, entry]] : []
        )
      ),
    };
  }

  private prune(ledger: SessionAttachmentLedgerFile): void {
    const entries = Object.entries(ledger.sessions);
    if (entries.length <= this.maxSessions) {
      return;
    }
    entries.sort(([, a], [, b]) => b.updatedAt - a.updatedAt);
    ledger.sessions = Object.fromEntries(entries.slice(0, this.maxSessions));
  }
}

function union(
  existing: readonly string[] | undefined,
  added: readonly string[]
): string[] {
  return [...new Set([...(existing ?? []), ...added])];
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isEntry(value: unknown): value is SessionAttachmentEntry {
  const entry = value as Partial<SessionAttachmentEntry> | null;
  return (
    !!entry &&
    isStringArray(entry.agents) &&
    isStringArray(entry.skills) &&
    typeof entry.updatedAt === "number"
  );
}
