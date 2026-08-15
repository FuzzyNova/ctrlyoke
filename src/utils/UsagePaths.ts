import * as path from "path";
import { PATH_CONSTANTS } from "./ConfigurationUtils";
import { ctrlyokeStateHome, projectStateRoot } from "./ProjectStatePaths";
import { getFrozenRunHistoryLocation } from "./RunHistoryStoragePolicy";

const OBSERVED_USAGE_FILE_NAME = "observed-usage.json";
const PROVIDER_SNAPSHOTS_FILE_NAME = "provider-snapshots.json";
const LIFETIME_STATS_FILE_NAME = "lifetime-stats.json";
const ACCOUNT_USAGE_DIR_NAME = "usage";

/** Canonical authority for workspace-scoped usage files. */
export function usageDir(workspaceRoot: string): string {
  return path.join(
    workspaceRoot,
    PATH_CONSTANTS.CTRLYOKE_DIR,
    PATH_CONSTANTS.USAGE_DIR
  );
}

export function observedUsagePath(workspaceRoot: string): string {
  return path.join(projectUsageDir(workspaceRoot), OBSERVED_USAGE_FILE_NAME);
}

export function providerSnapshotsPath(): string {
  return path.join(
    ctrlyokeStateHome(),
    ACCOUNT_USAGE_DIR_NAME,
    PROVIDER_SNAPSHOTS_FILE_NAME
  );
}

export function lifetimeStatsPath(workspaceRoot: string): string {
  return path.join(projectUsageDir(workspaceRoot), LIFETIME_STATS_FILE_NAME);
}

function projectUsageDir(stateRoot: string): string {
  return path.join(
    projectStateRoot(stateRoot, getFrozenRunHistoryLocation()),
    PATH_CONSTANTS.USAGE_DIR
  );
}
