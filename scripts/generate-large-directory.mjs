#!/usr/bin/env node

/**
 * Generate disposable files for manually exercising the paged workspace
 * browser.
 *
 * Usage:
 *   node scripts/generate-large-directory.mjs
 *   node scripts/generate-large-directory.mjs --count 1000
 *   node scripts/generate-large-directory.mjs --count 10000 --clean
 *   node scripts/generate-large-directory.mjs --clean-only
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const TARGET_DIRECTORY = resolve(
  SCRIPT_DIRECTORY,
  "..",
  "manual-test",
  "directory_with_many_files"
);
const DEFAULT_COUNT = 100_000;
const FILE_CONCURRENCY = 64;
const GENERATED_FILE_PATTERN = /^test_file_\d+\.txt$/;

function readOption(name) {
  const inlineValue = process.argv.find((argument) =>
    argument.startsWith(`${name}=`)
  );
  if (inlineValue) return inlineValue.slice(name.length + 1);

  const optionIndex = process.argv.indexOf(name);
  if (optionIndex >= 0) {
    const value = process.argv[optionIndex + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
    }
    return value;
  }

  return undefined;
}

function parseCount() {
  const value = readOption("--count");
  if (value === undefined) return DEFAULT_COUNT;

  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("--count must be a non-negative safe integer");
  }
  return count;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function assertKnownArguments() {
  const knownFlags = new Set(["--clean", "--clean-only", "--help"]);
  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (knownFlags.has(argument)) continue;
    if (argument === "--count") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--count=")) continue;
    throw new Error(`Unknown argument: ${argument}`);
  }
}

function printHelp() {
  console.log(`Generate disposable workspace-browser test files.

Target: ${TARGET_DIRECTORY}

Options:
  --count <n>  Number of files to create (default: ${DEFAULT_COUNT})
  --clean      Remove generated test_file_#.txt files before creating files
  --clean-only  Remove generated files without creating any new files
  --help       Show this help

Examples:
  npm run manual-test:large-directory
  npm run manual-test:large-directory -- --count 1000 --clean
  npm run manual-test:large-directory -- --count 10000 --clean
  npm run manual-test:large-directory -- --clean-only
`);
}

async function inBatches(items, action) {
  for (let offset = 0; offset < items.length; offset += FILE_CONCURRENCY) {
    const batch = items.slice(offset, offset + FILE_CONCURRENCY);
    await Promise.all(batch.map(action));
  }
}

async function removeGeneratedFiles() {
  let entries;
  try {
    entries = await readdir(TARGET_DIRECTORY, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }

  const generatedFiles = entries
    .filter(
      (entry) => entry.isFile() && GENERATED_FILE_PATTERN.test(entry.name)
    )
    .map((entry) => join(TARGET_DIRECTORY, entry.name));

  await inBatches(generatedFiles, (filePath) => rm(filePath, { force: true }));
  return generatedFiles.length;
}

async function createGeneratedFiles(count) {
  const indexes = Array.from({ length: count }, (_, index) => index + 1);
  await inBatches(indexes, (index) =>
    writeFile(
      join(TARGET_DIRECTORY, `test_file_${index}.txt`),
      `Test file ${index}\n`,
      "utf8"
    )
  );
}

async function main() {
  assertKnownArguments();
  if (hasFlag("--help")) {
    printHelp();
    return;
  }

  const count = parseCount();
  await mkdir(TARGET_DIRECTORY, { recursive: true });

  if (hasFlag("--clean")) {
    const removed = await removeGeneratedFiles();
    console.log(`Removed ${removed.toLocaleString()} generated files.`);
  }

  if (hasFlag("--clean-only")) {
    const removed = await removeGeneratedFiles();
    console.log(`Removed ${removed.toLocaleString()} generated files.`);
    return;
  }

  const startedAt = Date.now();
  await createGeneratedFiles(count);
  const elapsedSeconds = (Date.now() - startedAt) / 1000;
  console.log(
    `Created ${count.toLocaleString()} files in ${TARGET_DIRECTORY} (${elapsedSeconds.toFixed(1)}s).`
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
