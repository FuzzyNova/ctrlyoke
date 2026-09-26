/**
 * In-memory format migrations for persisted ctrlyoke documents.
 *
 * Keep this module Node-only and vscode-free: the extension, CLI, MCP server,
 * and detached statusline launcher all load it.
 */
import {
  CURRENT_SCHEMA_VERSIONS,
  PERSISTED_STORES,
  readSchemaVersion,
  type PersistedStore,
} from "./PersistedSchemaGuard";

export { CURRENT_SCHEMA_VERSIONS, PERSISTED_STORES };

export interface FormatMigration {
  store: PersistedStore;
  from: number;
  /** One line shown by migration tooling and in backup logs. */
  describe: string;
  /** Pure transformation of untyped persisted JSON. */
  migrate(doc: unknown): unknown;
}

/** Baselines for the first release format. Keep aligned with the release build. */
export const BASELINE_SCHEMA_VERSIONS: Record<PersistedStore, number> = {
  [PERSISTED_STORES.WORKFLOW_DEFINITION]: 1,
  [PERSISTED_STORES.SETTINGS]: 1,
  [PERSISTED_STORES.RUN_FILE]: 1,
  [PERSISTED_STORES.LINEAGE_DESCRIPTOR]: 1,
  [PERSISTED_STORES.RUNNER_LOCK]: 2,
  [PERSISTED_STORES.TIMELINE]: 1,
  [PERSISTED_STORES.PROJECT_METADATA]: 1,
  [PERSISTED_STORES.EXTERNAL_ROOTS_TRUST]: 1,
  [PERSISTED_STORES.SECRET_GRANTS_TRUST]: 1,
  [PERSISTED_STORES.COORDINATION_BOARD]: 1,
  [PERSISTED_STORES.LIFETIME_USAGE]: 1,
  [PERSISTED_STORES.OBSERVED_USAGE]: 1,
  [PERSISTED_STORES.PROVIDER_USAGE]: 1,
  [PERSISTED_STORES.MANAGED_WORKTREE_RECORD]: 1,
  [PERSISTED_STORES.NAMED_WORKTREE_SETUP]: 1,
  [PERSISTED_STORES.INSTALLATIONS]: 1,
};

/** Ordered migrations, one entry for every version transition. */
export const MIGRATIONS: Record<PersistedStore, readonly FormatMigration[]> = {
  [PERSISTED_STORES.WORKFLOW_DEFINITION]: [],
  [PERSISTED_STORES.SETTINGS]: [],
  [PERSISTED_STORES.RUN_FILE]: [],
  [PERSISTED_STORES.LINEAGE_DESCRIPTOR]: [],
  [PERSISTED_STORES.RUNNER_LOCK]: [],
  [PERSISTED_STORES.TIMELINE]: [],
  [PERSISTED_STORES.PROJECT_METADATA]: [],
  [PERSISTED_STORES.EXTERNAL_ROOTS_TRUST]: [],
  [PERSISTED_STORES.SECRET_GRANTS_TRUST]: [],
  [PERSISTED_STORES.COORDINATION_BOARD]: [],
  [PERSISTED_STORES.LIFETIME_USAGE]: [],
  [PERSISTED_STORES.OBSERVED_USAGE]: [],
  [PERSISTED_STORES.PROVIDER_USAGE]: [],
  [PERSISTED_STORES.MANAGED_WORKTREE_RECORD]: [],
  [PERSISTED_STORES.NAMED_WORKTREE_SETUP]: [],
  [PERSISTED_STORES.INSTALLATIONS]: [],
};

export class MigrationError extends Error {
  constructor(
    readonly store: PersistedStore,
    readonly fromVersion: number,
    message: string,
    readonly migrationCause?: unknown
  ) {
    super(message);
    this.name = "MigrationError";
  }
}

function schemaVersionFor(
  store: PersistedStore,
  doc: unknown
): number | undefined {
  if (store === PERSISTED_STORES.RUN_FILE) {
    const runtime = (doc as { _runtime?: unknown } | null)?._runtime;
    return readSchemaVersion(runtime);
  }
  return readSchemaVersion(doc);
}

function validateMigrationChains(): void {
  for (const store of Object.values(PERSISTED_STORES)) {
    const chain = MIGRATIONS[store];
    let expectedFrom = BASELINE_SCHEMA_VERSIONS[store];
    for (const migration of chain) {
      if (migration.store !== store || migration.from !== expectedFrom) {
        throw new Error(`Invalid format migration chain for ${store}`);
      }
      expectedFrom++;
    }
    if (expectedFrom !== CURRENT_SCHEMA_VERSIONS[store]) {
      throw new Error(
        `Format migration chain for ${store} ends at ${expectedFrom}, but current format is ${CURRENT_SCHEMA_VERSIONS[store]}`
      );
    }
  }
}

validateMigrationChains();

/** Migrate a document in memory to this build's current persisted shape. */
export function migrateToCurrent(
  store: PersistedStore,
  doc: unknown
): { doc: unknown; fromVersion: number; applied: string[] } {
  const foundVersion = schemaVersionFor(store, doc);
  const fromVersion = foundVersion ?? BASELINE_SCHEMA_VERSIONS[store];
  if (fromVersion > CURRENT_SCHEMA_VERSIONS[store]) {
    return { doc, fromVersion, applied: [] };
  }
  if (fromVersion < BASELINE_SCHEMA_VERSIONS[store]) {
    throw new MigrationError(
      store,
      fromVersion,
      `No migration chain is available for ${store} format ${fromVersion}`
    );
  }

  let migrated = doc;
  const applied: string[] = [];
  for (const migration of MIGRATIONS[store]) {
    if (migration.from < fromVersion) continue;
    try {
      migrated = migration.migrate(migrated);
    } catch (error) {
      throw new MigrationError(
        store,
        migration.from,
        `Failed to migrate ${store} format ${migration.from}: ${migration.describe}`,
        error
      );
    }
    applied.push(migration.describe);
  }
  return { doc: migrated, fromVersion, applied };
}
