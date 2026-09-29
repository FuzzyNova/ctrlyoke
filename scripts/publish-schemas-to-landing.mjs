import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Read a schema and the `/schema/v<N>/<file>` location its `$id` publishes to. */
export function readPublishedSchema(schemaPath) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  if (typeof schema.$id !== "string") {
    throw new Error(`Schema is missing $id: ${schemaPath}`);
  }
  const url = new URL(schema.$id);
  const match = url.pathname.match(/^\/schema\/v(\d+)\/([^/]+)$/);
  if (!match) {
    throw new Error(`Schema $id must use /schema/v<N>/<file>: ${schema.$id}`);
  }
  return {
    schema,
    schemaPath,
    id: schema.$id,
    version: `v${match[1]}`,
    versionNumber: Number(match[1]),
    fileName: match[2],
  };
}

function collectFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(filePath) : [filePath];
  });
}

function collectRefs(node, refs = []) {
  if (Array.isArray(node)) {
    for (const value of node) collectRefs(value, refs);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") refs.push(value);
      else collectRefs(value, refs);
    }
  }
  return refs;
}

/** Every `$ref` into another schema must land on a URL this build publishes. */
function assertCrossSchemaRefsResolve(root, published) {
  const urls = new Set(published.map(({ id }) => id));
  for (const { schema, schemaPath, id } of published) {
    for (const ref of collectRefs(schema)) {
      if (ref.startsWith("#")) continue;
      const target = new URL(ref, id);
      target.hash = "";
      if (!urls.has(target.href)) {
        throw new Error(
          `${relative(root, schemaPath)} references ${ref}, which resolves to unpublished ${target.href}.`
        );
      }
    }
  }
}

/**
 * Publish current and archived JSON schemas into a landing build directory.
 * `schemas/*.json` is current; `schemas/archive/v<N>/` holds versions frozen
 * by `npm run schema:bump` and is published unchanged forever.
 */
export function publishSchemas({ root = ROOT, outputDir } = {}) {
  if (!outputDir) throw new Error("outputDir is required");
  const schemasDir = join(root, "schemas");
  const archiveDir = join(schemasDir, "archive");
  const current = readdirSync(schemasDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readPublishedSchema(join(schemasDir, name)));
  const currentIds = new Set(current.map(({ id }) => id));

  const archived = collectFiles(archiveDir)
    .filter((filePath) => filePath.endsWith(".json"))
    .map((filePath) => {
      const entry = readPublishedSchema(filePath);
      const archiveVersion = relative(archiveDir, filePath).split(/[\\/]/)[0];
      if (entry.version !== archiveVersion) {
        throw new Error(
          `Archived schema $id version ${entry.version} does not match its directory ${archiveVersion}: ${filePath}`
        );
      }
      if (currentIds.has(entry.id)) {
        throw new Error(
          `${relative(root, filePath)} has the same $id as a current schema (${entry.id}). Only superseded versions belong in schemas/archive/; use npm run schema:bump.`
        );
      }
      return entry;
    });

  const published = [...current, ...archived];
  assertCrossSchemaRefsResolve(root, published);

  for (const { schemaPath, version, fileName } of published) {
    const destination = join(outputDir, "schema", version, fileName);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(schemaPath, destination);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const outputDir = join(ROOT, "landing", "dist");
  if (!existsSync(outputDir)) {
    console.error(`[publish-schemas] landing build not found at ${outputDir}`);
    process.exit(1);
  }
  publishSchemas({ outputDir });
  console.log(
    `[publish-schemas] Published schemas under ${join(outputDir, "schema")}`
  );
}
