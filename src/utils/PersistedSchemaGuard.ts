/**
 * PersistedSchemaGuard — refuse to modify shared state written by a newer ctrlyoke.
 *
 * The VS Code extension, the npm CLI and the MCP server can run different
 * ctrlyoke versions against the same `~/.ctrlyoke` state
 * (dev/backlog/CLI_DISTRIBUTION_PLAN.md §3.4 rule 3). Each shared store carries
 * an integer `schemaVersion`, bumped only on a breaking change. A host that
 * finds a **newer** version:
 *
 * - may read and display the data;
 * - must not write, mutate, continue or append to it — it throws
 *   {@link NewerSchemaError} instead, which the CLI maps to exit code 2;
 * - must treat a newer runner lock as held, never as stale.
 *
 * A missing version is "written before versioning" and is always writable.
 * Pre-1.0 there are no migrations; only the refuse-to-write guard exists.
 *
 * Node-only and `vscode`-free: imported by the extension, CLI and MCP bundles.
 */

/** Shared stores guarded against writes by an older host. */
export const PERSISTED_STORES = {
  WORKFLOW_DEFINITION: "workflow-definition",
  SETTINGS: "settings",
  RUN_FILE: "run-file",
  LINEAGE_DESCRIPTOR: "lineage-descriptor",
  RUNNER_LOCK: "runner-lock",
  TIMELINE: "timeline",
  PROJECT_METADATA: "project-metadata",
  EXTERNAL_ROOTS_TRUST: "external-roots-trust",
  SECRET_GRANTS_TRUST: "secret-grants-trust",
  WORKSPACE_SETTINGS_TRUST: "workspace-settings-trust",
  COORDINATION_BOARD: "coordination-board",
  LIFETIME_USAGE: "lifetime-usage",
  OBSERVED_USAGE: "observed-usage",
  PROVIDER_USAGE: "provider-usage",
  MANAGED_WORKTREE_RECORD: "managed-worktree-record",
  NAMED_WORKTREE_SETUP: "named-worktree-setup",
  INSTALLATIONS: "installations",
  HISTORY_TRASH_ENTRY: "history-trash-entry",
} as const;

export type PersistedStore =
  (typeof PERSISTED_STORES)[keyof typeof PERSISTED_STORES];

/**
 * The schema version this build writes for each store. Bump a store's value
 * only for a change an older host would misread or silently drop.
 */
export const CURRENT_SCHEMA_VERSIONS = {
  [PERSISTED_STORES.WORKFLOW_DEFINITION]: 1,
  [PERSISTED_STORES.SETTINGS]: 1,
  [PERSISTED_STORES.RUN_FILE]: 2,
  [PERSISTED_STORES.LINEAGE_DESCRIPTOR]: 1,
  [PERSISTED_STORES.RUNNER_LOCK]: 2,
  [PERSISTED_STORES.TIMELINE]: 2,
  [PERSISTED_STORES.PROJECT_METADATA]: 1,
  [PERSISTED_STORES.EXTERNAL_ROOTS_TRUST]: 1,
  [PERSISTED_STORES.SECRET_GRANTS_TRUST]: 1,
  [PERSISTED_STORES.WORKSPACE_SETTINGS_TRUST]: 1,
  [PERSISTED_STORES.COORDINATION_BOARD]: 1,
  [PERSISTED_STORES.LIFETIME_USAGE]: 1,
  [PERSISTED_STORES.OBSERVED_USAGE]: 1,
  [PERSISTED_STORES.PROVIDER_USAGE]: 1,
  [PERSISTED_STORES.MANAGED_WORKTREE_RECORD]: 1,
  [PERSISTED_STORES.NAMED_WORKTREE_SETUP]: 1,
  [PERSISTED_STORES.INSTALLATIONS]: 1,
  [PERSISTED_STORES.HISTORY_TRASH_ENTRY]: 1,
} as const satisfies Record<PersistedStore, number>;

const STORE_LABELS: Record<PersistedStore, string> = {
  [PERSISTED_STORES.WORKFLOW_DEFINITION]: "workflow definition",
  [PERSISTED_STORES.SETTINGS]: "settings",
  [PERSISTED_STORES.RUN_FILE]: "workflow run",
  [PERSISTED_STORES.LINEAGE_DESCRIPTOR]: "workflow history",
  [PERSISTED_STORES.RUNNER_LOCK]: "runner lock",
  [PERSISTED_STORES.TIMELINE]: "workflow timeline",
  [PERSISTED_STORES.PROJECT_METADATA]: "project metadata",
  [PERSISTED_STORES.EXTERNAL_ROOTS_TRUST]: "external file-root approvals",
  [PERSISTED_STORES.SECRET_GRANTS_TRUST]: "secret approvals",
  [PERSISTED_STORES.WORKSPACE_SETTINGS_TRUST]: "workspace setting approvals",
  [PERSISTED_STORES.COORDINATION_BOARD]: "coordination board",
  [PERSISTED_STORES.LIFETIME_USAGE]: "lifetime usage statistics",
  [PERSISTED_STORES.OBSERVED_USAGE]: "observed usage statistics",
  [PERSISTED_STORES.PROVIDER_USAGE]: "harness quota snapshot",
  [PERSISTED_STORES.MANAGED_WORKTREE_RECORD]: "managed worktree record",
  [PERSISTED_STORES.NAMED_WORKTREE_SETUP]: "named worktree setup record",
  [PERSISTED_STORES.INSTALLATIONS]: "installation registry",
  [PERSISTED_STORES.HISTORY_TRASH_ENTRY]: "recently deleted entry",
};

/** Thrown instead of writing a store that a newer ctrlyoke version owns. */
export class NewerSchemaError extends Error {
  constructor(
    readonly store: PersistedStore,
    readonly foundVersion: number,
    readonly filePath?: string
  ) {
    const supported = CURRENT_SCHEMA_VERSIONS[store];
    const label = STORE_LABELS[store];
    const message =
      store === PERSISTED_STORES.WORKFLOW_DEFINITION
        ? `${filePath ? `${filePath} ` : "This workflow file "}uses workflow format ${foundVersion}, which needs a newer ctrlyoke — this version (${getHostVersion()}) supports format ${supported}. Update ctrlyoke to open it.`
        : `This ${label} was written by a newer version of ctrlyoke (format ${foundVersion}; this version supports up to ${supported}). Update ctrlyoke to modify it.${filePath ? ` (${filePath})` : ""}`;
    super(message);
    this.name = "NewerSchemaError";
  }
}

function getHostVersion(): string {
  const path = require("path") as typeof import("path");
  const candidates = [
    path.resolve(__dirname, "../package.json"),
    path.resolve(__dirname, "../../package.json"),
  ];
  for (const candidate of candidates) {
    try {
      const packageJson = require(candidate) as { version?: unknown };
      if (typeof packageJson.version === "string") return packageJson.version;
    } catch {
      // Try the next package location used by compiled and bundled consumers.
    }
  }
  return "unknown";
}

export function isNewerSchemaError(error: unknown): error is NewerSchemaError {
  return error instanceof NewerSchemaError;
}

export type NewerSchemaRefusalListener = (error: NewerSchemaError) => void;

const refusalListeners = new Set<NewerSchemaRefusalListener>();

/**
 * Observe every refusal in this process, including ones a caller catches and
 * turns into something else (the executor reports a failed write as a failed
 * step). The CLI uses this to exit `2` rather than `1` when a run stopped
 * because a newer ctrlyoke owns its state. Returns an unsubscribe function.
 */
export function onNewerSchemaRefusal(
  listener: NewerSchemaRefusalListener
): () => void {
  refusalListeners.add(listener);
  return () => refusalListeners.delete(listener);
}

/**
 * Throw {@link NewerSchemaError} after notifying the refusal listeners. Every
 * refusal goes through here so no listener misses one.
 */
export function refuseNewerSchema(
  store: PersistedStore,
  foundVersion: number,
  filePath?: string
): never {
  const error = new NewerSchemaError(store, foundVersion, filePath);
  for (const listener of refusalListeners) {
    try {
      listener(error);
    } catch {
      // A listener must never change what the writer sees.
    }
  }
  throw error;
}

/** The integer version recorded on `value`, or `undefined` when absent. */
export function readSchemaVersion(value: unknown): number | undefined {
  if (value === null || typeof value !== "object") {
    return undefined;
  }
  const version = (value as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === "number" && Number.isInteger(version)
    ? version
    : undefined;
}

/** True when `version` is newer than this build supports for `store`. */
export function isNewerSchemaVersion(
  store: PersistedStore,
  version: number | undefined
): boolean {
  return version !== undefined && version > CURRENT_SCHEMA_VERSIONS[store];
}

/** True when `record` carries a version newer than this build supports. */
export function hasNewerSchema(
  store: PersistedStore,
  record: unknown
): boolean {
  return isNewerSchemaVersion(store, readSchemaVersion(record));
}

/** Throw {@link NewerSchemaError} when `record` belongs to a newer ctrlyoke. */
export function assertWritableSchema(
  store: PersistedStore,
  record: unknown,
  filePath?: string
): void {
  const version = readSchemaVersion(record);
  if (isNewerSchemaVersion(store, version)) {
    refuseNewerSchema(store, version as number, filePath);
  }
}

/**
 * A run working file ready to write: refuses one whose `_runtime` a newer
 * ctrlyoke stamped, and stamps this build's version otherwise. The version
 * lives in `_runtime` because that block is runtime-only and never reaches an
 * exported workflow definition.
 */
export function prepareRunFileForWrite<T extends { _runtime?: object }>(
  workingFile: T,
  filePath: string
): T {
  if (workingFile._runtime) {
    assertWritableSchema(
      PERSISTED_STORES.RUN_FILE,
      workingFile._runtime,
      filePath
    );
  }
  return {
    ...workingFile,
    schemaVersion:
      CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.WORKFLOW_DEFINITION],
    ...(workingFile._runtime
      ? {
          _runtime: {
            ...workingFile._runtime,
            schemaVersion: CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.RUN_FILE],
          },
        }
      : {}),
  };
}

/** True when a parsed run file's `_runtime` was stamped by a newer ctrlyoke. */
export function isNewerRunFile(workingFile: unknown): boolean {
  return hasNewerSchema(
    PERSISTED_STORES.RUN_FILE,
    (workingFile as { _runtime?: unknown } | null)?._runtime
  );
}
