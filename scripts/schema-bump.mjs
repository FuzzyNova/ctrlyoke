#!/usr/bin/env node

/**
 * Bump a published schema to its next major version:
 *
 *   npm run schema:bump -- workflow
 *   npm run schema:bump -- settings
 *
 * Run it *before* making the breaking edit, on a committed schema file. It
 * freezes the currently published schema into schemas/archive/v<N>/ (which is
 * then published unchanged forever), moves the current schema's $id to
 * /schema/v<N+1>/, re-points cross-schema $refs at each sibling's current
 * version, and bumps the store's CURRENT_SCHEMA_VERSIONS entry. Additive
 * changes do not need this; see "Changing the schemas" in CONTRIBUTING.md.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPublishedSchema } from "./publish-schemas-to-landing.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GUARD_PATH = join("src", "utils", "PersistedSchemaGuard.ts");

/** Bumpable schemas: source file and the PERSISTED_STORES key it versions. */
export const BUMPABLE_SCHEMAS = {
  workflow: {
    file: "workflow-schema.json",
    storeKey: "WORKFLOW_DEFINITION",
    fixtureDir: "workflow-definition",
  },
  settings: {
    file: "settings-schema.json",
    storeKey: "SETTINGS",
    fixtureDir: "settings",
  },
};

function replaceCurrentFormatVersion(guardSource, storeKey, from, to) {
  const blockStart = guardSource.indexOf(
    "export const CURRENT_SCHEMA_VERSIONS"
  );
  const blockEnd = guardSource.indexOf("}", blockStart);
  if (blockStart === -1 || blockEnd === -1) {
    throw new Error(`CURRENT_SCHEMA_VERSIONS not found in ${GUARD_PATH}`);
  }
  const block = guardSource.slice(blockStart, blockEnd);
  const entry = new RegExp(`(\\[PERSISTED_STORES\\.${storeKey}\\]:\\s*)(\\d+)`);
  const match = block.match(entry);
  if (!match) {
    throw new Error(`CURRENT_SCHEMA_VERSIONS has no ${storeKey} entry`);
  }
  if (Number(match[2]) !== from) {
    throw new Error(
      `CURRENT_SCHEMA_VERSIONS.${storeKey} is ${match[2]} but the schema $id is v${from}; reconcile them before bumping.`
    );
  }
  return (
    guardSource.slice(0, blockStart) +
    block.replace(entry, `$1${to}`) +
    guardSource.slice(blockEnd)
  );
}

/** Point every cross-schema $ref at the sibling's current published version. */
function syncCrossSchemaRefs(schemasDir) {
  const current = readdirSync(schemasDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readPublishedSchema(join(schemasDir, name)));
  const versionByFile = new Map(
    current.map(({ fileName, versionNumber }) => [fileName, versionNumber])
  );
  for (const { schemaPath, versionNumber } of current) {
    const text = readFileSync(schemaPath, "utf8");
    const updated = text.replace(
      /("\$ref":\s*")(?:\.\.\/v\d+\/)?([\w.-]+\.json)#/g,
      (whole, prefix, fileName) => {
        const target = versionByFile.get(fileName);
        if (target === undefined) return whole;
        const path =
          target === versionNumber ? fileName : `../v${target}/${fileName}`;
        return `${prefix}${path}#`;
      }
    );
    if (updated !== text) writeFileSync(schemaPath, updated);
  }
}

/** Archive the current version of one schema and move it to the next. */
export function bumpSchema({ root = ROOT, name }) {
  const config = BUMPABLE_SCHEMAS[name];
  if (!config) {
    throw new Error(
      `Unknown schema "${name}". Expected one of: ${Object.keys(BUMPABLE_SCHEMAS).join(", ")}`
    );
  }
  const schemasDir = join(root, "schemas");
  const schemaPath = join(schemasDir, config.file);
  const { id, versionNumber: from } = readPublishedSchema(schemaPath);
  const to = from + 1;

  const guardPath = join(root, GUARD_PATH);
  const guardSource = replaceCurrentFormatVersion(
    readFileSync(guardPath, "utf8"),
    config.storeKey,
    from,
    to
  );

  const archivePath = join(schemasDir, "archive", `v${from}`, config.file);
  if (existsSync(archivePath)) {
    throw new Error(
      `${archivePath} already exists; v${from} is already frozen.`
    );
  }
  mkdirSync(dirname(archivePath), { recursive: true });
  copyFileSync(schemaPath, archivePath);

  const nextId = id.replace(`/schema/v${from}/`, `/schema/v${to}/`);
  const schemaText = readFileSync(schemaPath, "utf8");
  writeFileSync(
    schemaPath,
    schemaText.replace(JSON.stringify(id), JSON.stringify(nextId))
  );
  syncCrossSchemaRefs(schemasDir);
  writeFileSync(guardPath, guardSource);

  return { from, to, id, nextId, archivePath, config };
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const name = process.argv[2];
  try {
    const config = BUMPABLE_SCHEMAS[name];
    if (config) {
      const tracked = [join("schemas", config.file), GUARD_PATH];
      try {
        git(["diff", "--quiet", "HEAD", "--", ...tracked]);
      } catch {
        throw new Error(
          `${tracked.join(" or ")} has uncommitted changes. Commit them first: the archive must freeze the schema as last published, before the breaking edit.`
        );
      }
    }
    const result = bumpSchema({ name });
    if (name === "workflow") {
      execFileSync(
        "node",
        [join(ROOT, "scripts", "generate-yaml-schema.mjs")],
        {
          stdio: "inherit",
        }
      );
    }
    let staleRefs = "";
    try {
      staleRefs = git([
        "grep",
        "-l",
        "--fixed-strings",
        result.id,
        "--",
        ".",
        ":!schemas/archive",
        ":!dev",
      ]).trim();
    } catch {
      // git grep exits 1 when nothing matches.
    }
    const { from, to } = result;
    console.log(
      [
        `Froze ${name} v${from} at ${result.archivePath}`,
        `Current ${name} schema is now ${result.nextId}`,
        `CURRENT_SCHEMA_VERSIONS.${result.config.storeKey}: ${from} -> ${to}`,
        "",
        "Next:",
        `  1. Make the breaking change in schemas/${result.config.file}.`,
        `  2. Add the ${from} -> ${to} migration to MIGRATIONS in src/utils/FormatMigrations.ts`,
        "     (the extension fails to load until the chain reaches the new version).",
        `  3. Add src/test/fixtures/formats/${result.config.fixtureDir}/v${to}/; keep v${from} as is.`,
        "  4. Update remaining references to the old URL:",
        ...(staleRefs
          ? staleRefs.split("\n").map((f) => `       ${f}`)
          : ["       (none)"]),
        "  5. npm run schema:update, then npm test.",
      ].join("\n")
    );
  } catch (error) {
    console.error(`[schema:bump] ${error.message}`);
    process.exit(1);
  }
}
