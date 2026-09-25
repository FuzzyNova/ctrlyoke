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
  RUN_FILE: "run-file",
  LINEAGE_DESCRIPTOR: "lineage-descriptor",
  RUNNER_LOCK: "runner-lock",
  EXTERNAL_ROOTS_TRUST: "external-roots-trust",
  SECRET_GRANTS_TRUST: "secret-grants-trust",
  COORDINATION_BOARD: "coordination-board",
} as const;

export type PersistedStore =
  (typeof PERSISTED_STORES)[keyof typeof PERSISTED_STORES];

/**
 * The schema version this build writes for each store. Bump a store's value
 * only for a change an older host would misread or silently drop.
 */
export const CURRENT_SCHEMA_VERSIONS = {
  [PERSISTED_STORES.RUN_FILE]: 1,
  [PERSISTED_STORES.LINEAGE_DESCRIPTOR]: 1,
  [PERSISTED_STORES.RUNNER_LOCK]: 2,
  [PERSISTED_STORES.EXTERNAL_ROOTS_TRUST]: 1,
  [PERSISTED_STORES.SECRET_GRANTS_TRUST]: 1,
  [PERSISTED_STORES.COORDINATION_BOARD]: 1,
} as const satisfies Record<PersistedStore, number>;

const STORE_LABELS: Record<PersistedStore, string> = {
  [PERSISTED_STORES.RUN_FILE]: "workflow run",
  [PERSISTED_STORES.LINEAGE_DESCRIPTOR]: "workflow history",
  [PERSISTED_STORES.RUNNER_LOCK]: "runner lock",
  [PERSISTED_STORES.EXTERNAL_ROOTS_TRUST]: "external file-root approvals",
  [PERSISTED_STORES.SECRET_GRANTS_TRUST]: "secret approvals",
  [PERSISTED_STORES.COORDINATION_BOARD]: "coordination board",
};

/** Thrown instead of writing a store that a newer ctrlyoke version owns. */
export class NewerSchemaError extends Error {
  constructor(
    readonly store: PersistedStore,
    readonly foundVersion: number,
    readonly filePath?: string
  ) {
    const supported = CURRENT_SCHEMA_VERSIONS[store];
    super(
      `This ${STORE_LABELS[store]} was written by a newer version of ctrlyoke ` +
        `(format ${foundVersion}; this version supports up to ${supported}). ` +
        `Update ctrlyoke — the VS Code extension, and the CLI with ` +
        `\`npm install -g ctrlyoke@latest\` — to modify it.` +
        (filePath ? ` (${filePath})` : "")
    );
    this.name = "NewerSchemaError";
  }
}

export function isNewerSchemaError(error: unknown): error is NewerSchemaError {
  return error instanceof NewerSchemaError;
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
    throw new NewerSchemaError(store, version as number, filePath);
  }
}

/**
 * A run working file ready to write: refuses one whose `_runtime` a newer
 * ctrlyoke stamped, and stamps this build's version otherwise. The version
 * lives in `_runtime` because that block is runtime-only and never reaches an
 * exported workflow definition.
 */
export function prepareRunFileForWrite<
  T extends { _runtime?: object },
>(workingFile: T, filePath: string): T {
  if (!workingFile._runtime) {
    return workingFile;
  }
  assertWritableSchema(
    PERSISTED_STORES.RUN_FILE,
    workingFile._runtime,
    filePath
  );
  return {
    ...workingFile,
    _runtime: {
      ...workingFile._runtime,
      schemaVersion: CURRENT_SCHEMA_VERSIONS[PERSISTED_STORES.RUN_FILE],
    },
  };
}

/** True when a parsed run file's `_runtime` was stamped by a newer ctrlyoke. */
export function isNewerRunFile(workingFile: unknown): boolean {
  return hasNewerSchema(
    PERSISTED_STORES.RUN_FILE,
    (workingFile as { _runtime?: unknown } | null)?._runtime
  );
}
