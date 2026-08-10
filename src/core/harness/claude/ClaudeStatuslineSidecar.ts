import type { CliExecutionSidecar } from "../shared/interfaces/ICliProvider";
import { StatuslineSnapshotWatcher } from "../shared/StatuslineSnapshotWatcher";
import {
  parseClaudeQuotaSnapshot,
  type ClaudeStatuslineSnapshot,
} from "../shared/usage/providers/ClaudeUsageProvider";
import type { HarnessQuotaSnapshot } from "../../../types/UsageTypes";

export interface ClaudeStatuslineSidecarDeps {
  snapshotPath: string;
  onProviderUsageUpdate?: (quota: HarnessQuotaSnapshot) => void;
}

/** Claude-specific payload parsing around the shared statusline transport watcher. */
export class ClaudeStatuslineSidecar implements CliExecutionSidecar {
  private readonly watcher: StatuslineSnapshotWatcher<ClaudeStatuslineSnapshot>;

  constructor(deps: ClaudeStatuslineSidecarDeps) {
    this.watcher = new StatuslineSnapshotWatcher({
      snapshotPath: deps.snapshotPath,
      onSnapshot: (snapshot) => {
        const quota = parseClaudeQuotaSnapshot(
          snapshot,
          snapshot._ctrlyoke?.writtenAt ?? Date.now()
        );
        if (quota) {
          deps.onProviderUsageUpdate?.(quota);
        }
      },
    });
  }

  getLatestSnapshot(): ClaudeStatuslineSnapshot | undefined {
    return this.watcher.getLatestSnapshot();
  }

  async readLatestSnapshot(): Promise<ClaudeStatuslineSnapshot | undefined> {
    return this.watcher.readLatestSnapshot();
  }

  stop(): void {
    this.watcher.stop();
  }
}
