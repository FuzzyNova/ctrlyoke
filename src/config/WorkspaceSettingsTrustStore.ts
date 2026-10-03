import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { TRUST_DECISIONS } from "../types/DashboardConstants";
import { PERSISTED_STORES } from "../utils/PersistedSchemaGuard";
import { AsyncWriteQueue } from "./AsyncWriteQueue";
import { ExternalRootsTrustStore } from "./ExternalRootsTrustStore";
import {
  loadTrustDecisionFile,
  saveTrustDecisionFile,
  type TrustDecisionFile,
} from "./TrustDecisionFile";
import {
  workspaceSensitiveSettingRequestKey,
  type WorkspaceSensitiveSettingRequest,
} from "./WorkspaceSensitiveSettings";

export type WorkspaceSettingTrustDecision =
  (typeof TRUST_DECISIONS)[keyof typeof TRUST_DECISIONS];

/** Keys are `${workspaceIdentity}␟${settingPath}␟${fingerprint}`. */
type WorkspaceSettingsTrustFile =
  TrustDecisionFile<WorkspaceSettingTrustDecision>;

const DECISION_KEY_SEPARATOR = "␟";

/** Listener told the first time this process sees an undecided request. */
export type UndecidedWorkspaceSettingsListener = (
  workspaceIdentity: string
) => void;

/** Read surface the settings layer needs; tests substitute their own. */
export interface WorkspaceSettingsTrustDecisions {
  getDecision(
    workspaceIdentity: string,
    request: WorkspaceSensitiveSettingRequest
  ): WorkspaceSettingTrustDecision | undefined;
  setDecisions(
    workspaceIdentity: string,
    requests: readonly WorkspaceSensitiveSettingRequest[],
    decision: WorkspaceSettingTrustDecision
  ): Promise<void>;
  reportUndecided(
    workspaceIdentity: string,
    requests: readonly WorkspaceSensitiveSettingRequest[]
  ): void;
}

/**
 * User-local store of decisions about workspace settings that can launch a
 * program (see `WorkspaceSensitiveSettings.ts`). Like
 * `ExternalRootsTrustStore`, it is deliberately not a settings backend: a
 * workspace's `.ctrlyoke/settings.json` only *requests* those values, and
 * whether they apply is recorded here, outside anything a repository can
 * commit. Both "allow" and "deny" are durable for that exact value.
 *
 * The settings layer consults this on every merged read of a workspace that
 * requests a sensitive value, so the parsed file is cached and re-read only
 * when its mtime changes (another process, such as the CLI's
 * `trust-workspace-settings`, may have written it).
 */
export class WorkspaceSettingsTrustStore implements WorkspaceSettingsTrustDecisions {
  private readonly writeQueue = new AsyncWriteQueue();
  private cached?: {
    storePath: string;
    mtimeMs: number;
    data: WorkspaceSettingsTrustFile;
  };
  private readonly reportedKeys = new Set<string>();
  private readonly undecidedListeners =
    new Set<UndecidedWorkspaceSettingsListener>();

  /**
   * @param storePathOrResolver The store file, or a function resolving it on
   *   each access (the singleton follows the current home directory, which
   *   tests redirect).
   */
  constructor(private readonly storePathOrResolver: string | (() => string)) {}

  private get storePath(): string {
    return typeof this.storePathOrResolver === "string"
      ? this.storePathOrResolver
      : this.storePathOrResolver();
  }

  /** Canonical workspace identity, shared with the other trust stores. */
  static canonicalizeWorkspace(workspaceRoot: string): string {
    return ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
  }

  private static keyFor(
    workspaceIdentity: string,
    request: Pick<
      WorkspaceSensitiveSettingRequest,
      "settingPath" | "fingerprint"
    >
  ): string {
    return `${workspaceIdentity}${DECISION_KEY_SEPARATOR}${workspaceSensitiveSettingRequestKey(request)}`;
  }

  private load(): WorkspaceSettingsTrustFile {
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(this.storePath).mtimeMs;
    } catch {
      this.cached = undefined;
      return { decisions: {} };
    }
    if (
      this.cached?.storePath === this.storePath &&
      this.cached.mtimeMs === mtimeMs
    ) {
      return this.cached.data;
    }
    const data = loadTrustDecisionFile<WorkspaceSettingTrustDecision>(
      PERSISTED_STORES.WORKSPACE_SETTINGS_TRUST,
      this.storePath,
      "Workspace settings trust store"
    );
    this.cached = { storePath: this.storePath, mtimeMs, data };
    return data;
  }

  getDecision(
    workspaceIdentity: string,
    request: WorkspaceSensitiveSettingRequest
  ): WorkspaceSettingTrustDecision | undefined {
    return this.load().decisions[
      WorkspaceSettingsTrustStore.keyFor(workspaceIdentity, request)
    ];
  }

  /** Record the same decision for a batch of requests in one write. */
  async setDecisions(
    workspaceIdentity: string,
    requests: readonly WorkspaceSensitiveSettingRequest[],
    decision: WorkspaceSettingTrustDecision
  ): Promise<void> {
    if (requests.length === 0) {
      return;
    }
    await this.writeQueue.enqueue(async () => {
      // Copy so a failed save cannot leave the cache claiming a decision.
      const current = this.load();
      const data: WorkspaceSettingsTrustFile = {
        ...current,
        decisions: { ...current.decisions },
      };
      for (const request of requests) {
        data.decisions[
          WorkspaceSettingsTrustStore.keyFor(workspaceIdentity, request)
        ] = decision;
      }
      await saveTrustDecisionFile(
        PERSISTED_STORES.WORKSPACE_SETTINGS_TRUST,
        this.storePath,
        data
      );
      // Coarse filesystem mtime resolution could otherwise hide this write.
      this.cached = undefined;
    });
  }

  /**
   * Called by readers that just withheld undecided values. Listeners hear
   * about each request once per process, so a host can ask the user without
   * re-prompting on every settings read.
   */
  reportUndecided(
    workspaceIdentity: string,
    requests: readonly WorkspaceSensitiveSettingRequest[]
  ): void {
    const fresh = requests.filter((request) => {
      const key = WorkspaceSettingsTrustStore.keyFor(
        workspaceIdentity,
        request
      );
      if (this.reportedKeys.has(key)) return false;
      this.reportedKeys.add(key);
      return true;
    });
    if (fresh.length === 0 || this.undecidedListeners.size === 0) {
      return;
    }
    // Deferred: this runs inside synchronous settings reads, and a listener
    // that reads settings again must not re-enter that read.
    queueMicrotask(() => {
      for (const listener of this.undecidedListeners) {
        listener(workspaceIdentity);
      }
    });
  }

  /** Subscribe to newly seen undecided requests. Returns an unsubscribe. */
  onUndecided(listener: UndecidedWorkspaceSettingsListener): () => void {
    this.undecidedListeners.add(listener);
    return () => {
      this.undecidedListeners.delete(listener);
    };
  }
}

/** Create the store backed by `~/.ctrlyoke/workspace-settings-trust.json`. */
function createWorkspaceSettingsTrustStore(): WorkspaceSettingsTrustStore {
  return new WorkspaceSettingsTrustStore(() =>
    path.join(os.homedir(), ".ctrlyoke", "workspace-settings-trust.json")
  );
}

/** Process-wide singleton, mirroring `externalRootsTrustStore`. */
export const workspaceSettingsTrustStore = createWorkspaceSettingsTrustStore();
