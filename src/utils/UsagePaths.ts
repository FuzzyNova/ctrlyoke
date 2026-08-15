import * as path from "path";
import { PATH_CONSTANTS } from "./ConfigurationUtils";
import { ctrlyokeStateHome, projectStateRoot } from "./ProjectStatePaths";
import { getFrozenRunHistoryLocation } from "./RunHistoryStoragePolicy";

const OBSERVED_USAGE_FILE_NAME = "observed-usage.json";
const PROVIDER_SNAPSHOTS_FILE_NAME = "provider-snapshots.json";
const LIFETIME_STATS_FILE_NAME = "lifetime-stats.json";
const ACCOUNT_USAGE_DIR_NAME = "usage";

export function observedUsagePath(workspaceRoot: string): string {
  return observedUsagePathForProject(
    projectStateRoot(workspaceRoot, getFrozenRunHistoryLocation())
  );
}

/** Resolve observed usage for an already-resolved project state directory. */
export function observedUsagePathForProject(projectRoot: string): string {
  return path.join(
    projectUsageDirForProject(projectRoot),
    OBSERVED_USAGE_FILE_NAME
  );
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
  return projectUsageDirForProject(
    projectStateRoot(stateRoot, getFrozenRunHistoryLocation())
  );
}

function projectUsageDirForProject(projectRoot: string): string {
  return path.join(projectRoot, PATH_CONSTANTS.USAGE_DIR);
}
