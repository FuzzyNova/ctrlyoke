import * as path from "path";
import { PATH_CONSTANTS } from "./ConfigurationUtils";

const OBSERVED_USAGE_FILE_NAME = "observed-usage.json";
const PROVIDER_SNAPSHOTS_FILE_NAME = "provider-snapshots.json";
const LIFETIME_STATS_FILE_NAME = "lifetime-stats.json";

/** Canonical authority for every file directly under `.ctrlyoke/.usage`. */
export function usageDir(workspaceRoot: string): string {
  return path.join(
    workspaceRoot,
    PATH_CONSTANTS.CTRLYOKE_DIR,
    PATH_CONSTANTS.USAGE_DIR
  );
}

export function observedUsagePath(workspaceRoot: string): string {
  return path.join(usageDir(workspaceRoot), OBSERVED_USAGE_FILE_NAME);
}

export function providerSnapshotsPath(workspaceRoot: string): string {
  return path.join(usageDir(workspaceRoot), PROVIDER_SNAPSHOTS_FILE_NAME);
}

export function lifetimeStatsPath(workspaceRoot: string): string {
  return path.join(usageDir(workspaceRoot), LIFETIME_STATS_FILE_NAME);
}
