import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { parse, type ParseError } from "jsonc-parser";
import {
  assertWritableSchema,
  CURRENT_SCHEMA_VERSIONS,
  readSchemaVersion,
  type PersistedStore,
} from "../utils/PersistedSchemaGuard";
import { migrateToCurrent } from "../utils/FormatMigrations";
import { stripLeadingBom } from "../utils/TextUtils";

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
  let content: string;
  try {
    content = fs.readFileSync(storePath, "utf-8");
  } catch {
    return { decisions: {} };
  }
  try {
    const errors: ParseError[] = [];
    const parsedJson = parse(stripLeadingBom(content), errors, {
      allowTrailingComma: true,
    });
    if (errors.length > 0 || parsedJson === undefined) {
      throw new Error("Invalid JSONC syntax");
    }
    const parsed = migrateToCurrent(store, parsedJson).doc as Partial<
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
  const tmpPath = `${storePath}.${process.pid}.${randomUUID()}.tmp`;
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
