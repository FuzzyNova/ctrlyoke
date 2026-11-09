import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../utils/AtomicFileUtils";
import {
  assertWritableSchema,
  CURRENT_SCHEMA_VERSIONS,
  readSchemaVersion,
  type PersistedStore,
} from "../utils/PersistedSchemaGuard";
import { migrateToCurrent } from "../utils/FormatMigrations";
import {
  JSONC_OBJECT_FILE_RESULT_KIND,
  readJsoncObjectFile,
} from "./JsoncObjectFile";

/** On-disk shape shared by the user-local trust-decision stores. */
export interface TrustDecisionFile<Decision> {
  /** Format version (`PersistedSchemaGuard`); absent in files written before versioning. */
  schemaVersion?: number;
  decisions: Record<string, Decision>;
  /** In-memory marker preventing a malformed file from being overwritten. */
  invalidContent?: true;
}

/**
 * Read a trust-decision file. A missing file is empty; malformed JSONC is
 * treated as empty for reads, but marked so a later save refuses to overwrite it.
 */
export function loadTrustDecisionFile<Decision>(
  store: PersistedStore,
  storePath: string,
  label: string
): TrustDecisionFile<Decision> {
  const result = readJsoncObjectFile(storePath);
  if (
    result.kind === JSONC_OBJECT_FILE_RESULT_KIND.MISSING ||
    result.kind === JSONC_OBJECT_FILE_RESULT_KIND.EMPTY
  ) {
    return { decisions: {} };
  }
  if (result.kind === JSONC_OBJECT_FILE_RESULT_KIND.INVALID) {
    console.warn(
      `[ctrlyoke] ${label} has invalid JSON and will be treated as empty: ${storePath}`
    );
    return { decisions: {}, invalidContent: true };
  }
  try {
    const parsed = migrateToCurrent(store, result.value).doc as Partial<
      TrustDecisionFile<Decision>
    >;
    const schemaVersion = readSchemaVersion(parsed);
    if (
      parsed.decisions !== undefined &&
      (parsed.decisions === null ||
        typeof parsed.decisions !== "object" ||
        Array.isArray(parsed.decisions))
    ) {
      throw new Error("Trust decisions must be an object");
    }
    return {
      ...(schemaVersion !== undefined ? { schemaVersion } : {}),
      decisions: parsed.decisions ?? {},
    };
  } catch {
    console.warn(
      `[ctrlyoke] ${label} has invalid JSON and will be treated as empty: ${storePath}`
    );
    return { decisions: {}, invalidContent: true };
  }
}

/** Write a trust-decision file stamped with this build's version. */
export async function saveTrustDecisionFile<Decision>(
  store: PersistedStore,
  storePath: string,
  data: TrustDecisionFile<Decision>
): Promise<void> {
  if (data.invalidContent) {
    throw new Error(
      `Cannot update trust-decision file because it contains invalid JSON: ${storePath}`
    );
  }
  assertWritableSchema(store, data, storePath);
  await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
  await writeFileAtomic(
    storePath,
    JSON.stringify(
      { ...data, schemaVersion: CURRENT_SCHEMA_VERSIONS[store] },
      null,
      2
    )
  );
}
