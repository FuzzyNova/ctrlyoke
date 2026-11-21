#!/usr/bin/env node
/**
 * Archive of every published version of ctrlyoke's legal documents.
 *
 * `legal/versions.json` lists each document and each version of it that has
 * been published, with the date it was published and the SHA-256 of its text.
 * `legal/archive/<document>/<version>.md` holds that text exactly as
 * published. The landing site serves each one at `<route><version>/`, so a
 * version recorded at checkout or named in a distributed copy keeps a
 * permanent link. See legal/README.md for the release process.
 *
 *   node --experimental-strip-types scripts/legal-archive.mjs --check
 *   node --experimental-strip-types scripts/legal-archive.mjs --archive [--date YYYY-MM-DD]
 *
 * `--check` fails when a published text changed, an archived file is missing
 * or unlisted, or a root document's text differs from the archived copy of
 * its version (an edit made without a version bump). `--archive` adds the
 * current text of each root document whose version is not archived yet.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLegalDocumentVersion } from "../src/license/LemonSqueezyConstants.ts";

export const LEGAL_VERSIONS_FILE = "legal/versions.json";
export const LEGAL_ARCHIVE_DIR = "legal/archive";
const PROCESS_DOC = "legal/README.md";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Repo-relative path of one archived version's text. */
export function archivedVersionPath(documentId, version) {
  return `${LEGAL_ARCHIVE_DIR}/${documentId}/${version}.md`;
}

/** Hash of a legal text, independent of the checkout's line endings. */
export function hashLegalText(text) {
  return createHash("sha256")
    .update(text.replace(/\r\n/g, "\n"), "utf8")
    .digest("hex");
}

/**
 * Every problem with the archive, as messages; empty when it is consistent.
 *
 * @param {object} input
 * @param {{documents: {id: string, file: string}[], versions: {document: string, version: string, published: string, sha256: string}[]}} input.registry
 *   Parsed legal/versions.json.
 * @param {Record<string, string>} input.currentTexts Root document file name → its text.
 * @param {Record<string, string>} input.archivedTexts archivedVersionPath() → its text.
 */
export function findLegalArchiveProblems({
  registry,
  currentTexts,
  archivedTexts,
}) {
  const problems = [];
  const documentIds = new Set(registry.documents.map((doc) => doc.id));
  const listedPaths = new Set();
  const latestPublished = new Map();

  for (const entry of registry.versions) {
    const label = `${entry.document}@${entry.version}`;
    const archivePath = archivedVersionPath(entry.document, entry.version);
    if (!documentIds.has(entry.document)) {
      problems.push(
        `${label}: no document "${entry.document}" in ${LEGAL_VERSIONS_FILE}.`
      );
    }
    if (listedPaths.has(archivePath)) {
      problems.push(
        `${label} is listed more than once in ${LEGAL_VERSIONS_FILE}.`
      );
    }
    listedPaths.add(archivePath);
    if (!ISO_DATE.test(entry.published)) {
      problems.push(`${label}: "published" must be a YYYY-MM-DD date.`);
    }
    const previous = latestPublished.get(entry.document);
    if (previous !== undefined && entry.published < previous) {
      problems.push(
        `${label} is listed out of order: list each document's versions oldest first.`
      );
    }
    latestPublished.set(entry.document, entry.published);

    const text = archivedTexts[archivePath];
    if (text === undefined) {
      problems.push(`${label}: ${archivePath} is missing.`);
      continue;
    }
    if (hashLegalText(text) !== entry.sha256) {
      problems.push(
        `${archivePath} no longer matches the text published as ${label}. Published versions are permanent: restore it with git, and publish any change as a new version (${PROCESS_DOC}).`
      );
    }
    if (readLegalDocumentVersion(text, archivePath) !== entry.version) {
      problems.push(
        `${archivePath} does not carry "**Version:** ${entry.version}".`
      );
    }
  }

  for (const archivePath of Object.keys(archivedTexts)) {
    if (!listedPaths.has(archivePath)) {
      problems.push(`${archivePath} is not listed in ${LEGAL_VERSIONS_FILE}.`);
    }
  }

  for (const doc of registry.documents) {
    const text = currentTexts[doc.file];
    if (text === undefined) {
      problems.push(`${doc.file} is missing.`);
      continue;
    }
    const version = readLegalDocumentVersion(text, doc.file);
    const versions = registry.versions.filter((v) => v.document === doc.id);
    const entry = versions.find((v) => v.version === version);
    if (!entry) {
      problems.push(
        `${doc.file} is version ${version}, which is not archived. Once the new version is approved, run \`npm run legal:archive\` (${PROCESS_DOC}).`
      );
      continue;
    }
    if (entry !== versions.at(-1)) {
      problems.push(
        `${doc.file} is version ${version}, but ${LEGAL_VERSIONS_FILE} lists a later ${doc.id} version.`
      );
    }
    if (hashLegalText(text) !== entry.sha256) {
      problems.push(
        `${doc.file} changed after version ${version} was published. Never edit a published version: give the change a new **Version:** and date, then run \`npm run legal:archive\` (${PROCESS_DOC}).`
      );
    }
  }
  return problems;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Reads the registry, root documents and archive from a checkout. */
export function readLegalArchive(rootDir) {
  const registry = readJson(path.join(rootDir, LEGAL_VERSIONS_FILE));
  const currentTexts = {};
  for (const doc of registry.documents) {
    const file = path.join(rootDir, doc.file);
    if (fs.existsSync(file))
      currentTexts[doc.file] = fs.readFileSync(file, "utf8");
  }
  const archivedTexts = {};
  const archiveRoot = path.join(rootDir, LEGAL_ARCHIVE_DIR);
  for (const documentId of fs.existsSync(archiveRoot)
    ? fs.readdirSync(archiveRoot)
    : []) {
    const dir = path.join(archiveRoot, documentId);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      archivedTexts[`${LEGAL_ARCHIVE_DIR}/${documentId}/${name}`] =
        fs.readFileSync(path.join(dir, name), "utf8");
    }
  }
  return { registry, currentTexts, archivedTexts };
}

/**
 * Archives the current text of each root document whose version is not yet
 * in the registry, dated `published`. Returns the `document@version` labels
 * it added. Never touches a version that is already archived.
 */
export function archiveCurrentVersions(rootDir, published) {
  if (!ISO_DATE.test(published)) {
    throw new Error(`--date must be YYYY-MM-DD, got "${published}"`);
  }
  const { registry, currentTexts } = readLegalArchive(rootDir);
  const added = [];
  for (const doc of registry.documents) {
    const text = currentTexts[doc.file];
    if (text === undefined) continue;
    const version = readLegalDocumentVersion(text, doc.file);
    if (
      registry.versions.some(
        (v) => v.document === doc.id && v.version === version
      )
    ) {
      continue;
    }
    const normalized = text.replace(/\r\n/g, "\n");
    const target = path.join(rootDir, archivedVersionPath(doc.id, version));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, normalized, { encoding: "utf8", flag: "wx" });
    registry.versions.push({
      document: doc.id,
      version,
      published,
      sha256: hashLegalText(normalized),
    });
    added.push(`${doc.id}@${version}`);
  }
  if (added.length > 0) {
    fs.writeFileSync(
      path.join(rootDir, LEGAL_VERSIONS_FILE),
      `${JSON.stringify(registry, null, 2)}\n`,
      "utf8"
    );
  }
  return added;
}

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function main(argv) {
  const rootDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
  );
  if (argv.includes("--archive")) {
    const dateIndex = argv.indexOf("--date");
    const published = dateIndex >= 0 ? argv[dateIndex + 1] : today();
    const added = archiveCurrentVersions(rootDir, published);
    console.log(
      added.length > 0
        ? `Archived ${added.join(", ")} as published ${published}.`
        : "Every legal document's current version is already archived."
    );
  }
  const problems = findLegalArchiveProblems(readLegalArchive(rootDir));
  if (problems.length > 0) {
    console.error(
      `Legal document archive check failed:\n- ${problems.join("\n- ")}`
    );
    process.exitCode = 1;
    return;
  }
  console.log("Legal document archive is consistent.");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2));
}
