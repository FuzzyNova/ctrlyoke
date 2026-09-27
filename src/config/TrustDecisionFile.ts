import * as fs from "fs";
import * as path from "path";
import {
  assertWritableSchema,
  CURRENT_SCHEMA_VERSIONS,
  readSchemaVersion,
  type PersistedStore,
} from "../utils/PersistedSchemaGuard";
import { migrateToCurrent } from "../utils/FormatMigrations";

/** On-disk shape shared by the user-local trust-decision stores. */
export interface TrustDecisionFile<Decision> {
  /** Format version (`PersistedSchemaGuard`); absent in files written before versioning. */
  schemaVersion?: number;
  decisions: Record<string, Decision>;
}

/**
 * Read a trust-decision file. A missing file is empty; invalid JSON is treated
 * as empty with a warning. The version is carried through so a later save can
 * refuse to downgrade a file a newer ctrlyoke wrote.
 */
export function loadTrustDecisionFile<Decision>(
  store: PersistedStore,
  storePath: string,
  label: string
): TrustDecisionFile<Decision> {
  let content: string;
  try {
    content = fs.readFileSync(storePath, "utf-8");
  } catch {
    return { decisions: {} };
  }
  try {
    const parsed = migrateToCurrent(store, JSON.parse(content)).doc as Partial<
      TrustDecisionFile<Decision>
    >;
    const schemaVersion = readSchemaVersion(parsed);
    return {
      ...(schemaVersion !== undefined ? { schemaVersion } : {}),
      decisions: parsed.decisions ?? {},
    };
  } catch {
    console.warn(
      `[ctrlyoke] ${label} has invalid JSON and will be treated as empty: ${storePath}`
    );
    return { decisions: {} };
  }
}

/** Write a trust-decision file stamped with this build's version. */
export async function saveTrustDecisionFile<Decision>(
  store: PersistedStore,
  storePath: string,
  data: TrustDecisionFile<Decision>
): Promise<void> {
  assertWritableSchema(store, data, storePath);
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  const tmpPath = `${storePath}.tmp`;
  await fs.promises.writeFile(
    tmpPath,
    JSON.stringify(
      { ...data, schemaVersion: CURRENT_SCHEMA_VERSIONS[store] },
      null,
      2
    ),
    "utf-8"
  );
  await fs.promises.rename(tmpPath, storePath);
}
