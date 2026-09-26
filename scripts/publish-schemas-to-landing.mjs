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

function schemaUrlPath(schemaPath) {
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  if (typeof schema.$id !== "string") {
    throw new Error(`Schema is missing $id: ${schemaPath}`);
  }
  const url = new URL(schema.$id);
  const match = url.pathname.match(/^\/schema\/(v\d+)\/([^/]+)$/);
  if (!match) {
    throw new Error(`Schema $id must use /schema/v<N>/<file>: ${schema.$id}`);
  }
  return { version: match[1], fileName: match[2] };
}

function collectFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(filePath) : [filePath];
  });
}

function assertArchiveMatchesCurrent(schemasDir, archiveDir) {
  const currentFiles = readdirSync(schemasDir).filter((name) =>
    /\.(json|yaml)$/.test(name)
  );
  for (const fileName of currentFiles) {
    const currentPath = join(schemasDir, fileName);
    const archivedPath = join(archiveDir, fileName);
    if (
      !existsSync(archivedPath) ||
      !readFileSync(currentPath).equals(readFileSync(archivedPath))
    ) {
      throw new Error(
        `schemas/archive/v1/${fileName} must exactly match schemas/${fileName} while v1 is current.`
      );
    }
  }
}

/** Publish current and archived JSON schemas into a landing build directory. */
export function publishSchemas({ root = ROOT, outputDir } = {}) {
  if (!outputDir) throw new Error("outputDir is required");
  const schemasDir = join(root, "schemas");
  const archiveDir = join(schemasDir, "archive");
  const currentSchemaPaths = readdirSync(schemasDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => join(schemasDir, name));
  const currentSchemas = currentSchemaPaths.map((schemaPath) => ({
    schemaPath,
    ...schemaUrlPath(schemaPath),
  }));
  const currentVersions = new Set(currentSchemas.map(({ version }) => version));

  for (const version of currentVersions) {
    const archiveVersionDir = join(archiveDir, version);
    if (version === "v1" && existsSync(archiveVersionDir)) {
      assertArchiveMatchesCurrent(schemasDir, archiveVersionDir);
    }
  }

  const publishJson = (schemaPath, version, fileName) => {
    const destination = join(outputDir, "schema", version, fileName);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(schemaPath, destination);
  };

  for (const { schemaPath, version, fileName } of currentSchemas) {
    publishJson(schemaPath, version, fileName);
  }

  for (const archiveVersionDir of collectFiles(archiveDir)) {
    if (!archiveVersionDir.endsWith(".json")) continue;
    const { version, fileName } = schemaUrlPath(archiveVersionDir);
    const archiveVersion = relative(archiveDir, archiveVersionDir).split(
      /[\\/]/
    )[0];
    if (version !== archiveVersion) {
      throw new Error(
        `Archived schema $id version ${version} does not match its directory ${archiveVersion}: ${archiveVersionDir}`
      );
    }
    if (currentVersions.has(version)) continue;
    publishJson(archiveVersionDir, version, fileName);
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
