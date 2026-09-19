#!/usr/bin/env node

/**
 * Benchmark resident versus streamed history-search index scans.
 *
 * Usage:
 *   node scripts/bench-history-search-index.mjs <.search-index> <query> --mode resident
 *   node scripts/bench-history-search-index.mjs <.search-index> <query> --mode stream --compare-buffer
 *   node scripts/bench-history-search-index.mjs <.search-index> <query> --mode stream-key
 *   node scripts/bench-history-search-index.mjs <.search-index> <query> --mode shipped
 */

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import Module from "node:module";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const DOCUMENTS_DIRECTORY_NAME = "documents";
const DOCUMENT_SHARD_PATTERN = /\.jsonl$/;
const SAMPLE_INTERVAL = 8192;
const MEGABYTE = 1024 * 1024;
const CARRIAGE_RETURN = "\r";
const LINE_BREAK_PATTERN = /\r\n?|\n/;

function parseArguments() {
  const positional = [];
  let mode;
  let compareBuffer = false;

  for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === "--mode") {
      mode = process.argv[++index];
      continue;
    }
    if (argument.startsWith("--mode=")) {
      mode = argument.slice("--mode=".length);
      continue;
    }
    if (argument === "--compare-buffer") {
      compareBuffer = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printHelp();
      process.exit(0);
    }
    if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    positional.push(argument);
  }

  if (positional.length !== 2) {
    throw new Error("expected an index directory and a query");
  }
  if (
    mode !== "resident" &&
    mode !== "stream" &&
    mode !== "stream-key" &&
    mode !== "shipped"
  ) {
    throw new Error(
      '--mode must be "resident", "stream", "stream-key", or "shipped"'
    );
  }
  if (compareBuffer && mode !== "stream") {
    throw new Error("--compare-buffer requires --mode stream");
  }

  return {
    indexDirectory: resolve(positional[0]),
    query: positional[1],
    mode,
    compareBuffer,
  };
}

function printHelp() {
  console.log(`Benchmark resident versus streamed history-search index scans.

Usage:
  node scripts/bench-history-search-index.mjs <.search-index> <query> --mode resident
  node scripts/bench-history-search-index.mjs <.search-index> <query> --mode stream --compare-buffer
  node scripts/bench-history-search-index.mjs <.search-index> <query> --mode stream-key
  node scripts/bench-history-search-index.mjs <.search-index> <query> --mode shipped

The index directory is read only. --compare-buffer adds a rough raw Buffer
scan to a streamed run to compare it with UTF-8 string line decoding.
--mode stream-key expects shards with a serialized, lowercased textLower field
and measures a case-sensitive raw-line includes() against that field.
--mode shipped loads the compiled HistorySearchShardScanner from out/ and
measures several real queries without retaining their results.`);
}

async function getShardPaths(indexDirectory) {
  const documentsDirectory = join(indexDirectory, DOCUMENTS_DIRECTORY_NAME);
  const entries = await readdir(documentsDirectory, { withFileTypes: true });
  return entries
    .filter(
      (entry) => entry.isFile() && DOCUMENT_SHARD_PATTERN.test(entry.name)
    )
    .map((entry) => join(documentsDirectory, entry.name))
    .sort();
}

function readMemory() {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    rss: usage.rss,
  };
}

function createMemoryTracker() {
  const baseline = readMemory();
  let peak = baseline;

  return {
    sample() {
      const current = readMemory();
      if (current.heapUsed > peak.heapUsed) {
        peak = current;
      }
    },
    report() {
      const final = readMemory();
      return {
        baselineHeapUsedMb: toMegabytes(baseline.heapUsed),
        baselineRssMb: toMegabytes(baseline.rss),
        finalHeapUsedMb: toMegabytes(final.heapUsed),
        finalRssMb: toMegabytes(final.rss),
        heapUsedDeltaMb: toMegabytes(final.heapUsed - baseline.heapUsed),
        rssDeltaMb: toMegabytes(final.rss - baseline.rss),
        peakHeapUsedMb: toMegabytes(peak.heapUsed),
        peakHeapDeltaMb: toMegabytes(peak.heapUsed - baseline.heapUsed),
      };
    },
  };
}

function toMegabytes(bytes) {
  return Number((bytes / MEGABYTE).toFixed(1));
}

function asciiLower(value) {
  let lowered = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    lowered +=
      code >= 0x41 && code <= 0x5a
        ? String.fromCharCode(code + 0x20)
        : character;
  }
  return lowered;
}

function getPrefilterNeedle(query) {
  // JSON.stringify gives the exact representation used inside a JSON string;
  // omit its surrounding quotes because the raw line contains the value.
  const escaped = JSON.stringify(query).slice(1, -1);
  for (const character of escaped) {
    if (character.charCodeAt(0) > 0x7f) {
      return undefined;
    }
  }
  const text = asciiLower(escaped);
  return { text, failure: buildKmpFailureTable(Buffer.from(text, "ascii")) };
}

function lineMatchesPrefilter(line, needle) {
  if (needle === undefined) return true;
  let matchedLength = 0;
  for (const character of line) {
    const code = character.charCodeAt(0);
    const foldedCode = code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
    while (
      matchedLength > 0 &&
      foldedCode !== needle.text.charCodeAt(matchedLength)
    ) {
      matchedLength = needle.failure[matchedLength - 1];
    }
    if (foldedCode === needle.text.charCodeAt(matchedLength)) {
      matchedLength += 1;
      if (matchedLength === needle.text.length) return true;
    }
  }
  return false;
}

async function* streamFileLines(filePath) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  let buffered = "";

  try {
    for await (const chunk of stream) {
      buffered += chunk;
      const endsWithCarriageReturn = buffered.endsWith(CARRIAGE_RETURN);
      const searchable = endsWithCarriageReturn
        ? buffered.slice(0, -1)
        : buffered;
      const parts = searchable.split(LINE_BREAK_PATTERN);
      buffered =
        (parts.pop() ?? "") + (endsWithCarriageReturn ? CARRIAGE_RETURN : "");
      for (const line of parts) {
        yield line;
      }
    }

    if (buffered.length > 0) {
      const parts = buffered.split(LINE_BREAK_PATTERN);
      if (parts[parts.length - 1] === "") {
        parts.pop();
      }
      for (const line of parts) {
        yield line;
      }
    }
  } finally {
    stream.destroy();
  }
}

async function runResident(shardPaths, query) {
  const memory = createMemoryTracker();
  const loweredQuery = query.toLowerCase();
  const documents = [];
  let documentCount = 0;
  const loadStart = performance.now();

  for (const shardPath of shardPaths) {
    for await (const line of streamFileLines(shardPath)) {
      documents.push(JSON.parse(line));
      documentCount += 1;
      if (documentCount % SAMPLE_INTERVAL === 0) {
        memory.sample();
      }
    }
  }
  memory.sample();
  const loadMs = performance.now() - loadStart;

  const matchStart = performance.now();
  let matchCount = 0;
  for (const document of documents) {
    if (document.text.toLowerCase().includes(loweredQuery)) {
      matchCount += 1;
    }
  }
  const matchMs = performance.now() - matchStart;
  memory.sample();

  return {
    mode: "resident",
    shards: shardPaths.length,
    documents: documentCount,
    matches: matchCount,
    loadMs: roundMs(loadMs),
    matchMs: roundMs(matchMs),
    totalMs: roundMs(performance.now() - loadStart),
    ...memory.report(),
  };
}

async function runStream(
  shardPaths,
  query,
  compareBuffer,
  useSerializedTextLower
) {
  const memory = createMemoryTracker();
  const loweredQuery = query.toLowerCase();
  const prefilterNeedle = getPrefilterNeedle(
    useSerializedTextLower ? loweredQuery : query
  );
  let lineCount = 0;
  let candidateCount = 0;
  let matchCount = 0;
  let falsePositiveCount = 0;
  let verificationMs = 0;
  const totalStart = performance.now();

  for (const shardPath of shardPaths) {
    for await (const line of streamFileLines(shardPath)) {
      lineCount += 1;
      const passesPrefilter =
        prefilterNeedle === undefined ||
        (useSerializedTextLower
          ? line.includes(prefilterNeedle.text)
          : lineMatchesPrefilter(line, prefilterNeedle));
      if (!passesPrefilter) {
        if (lineCount % SAMPLE_INTERVAL === 0) memory.sample();
        continue;
      }

      candidateCount += 1;
      const verificationStart = performance.now();
      const document = JSON.parse(line);
      const matches = document.text.toLowerCase().includes(loweredQuery);
      verificationMs += performance.now() - verificationStart;
      if (matches) {
        matchCount += 1;
      } else {
        falsePositiveCount += 1;
      }
      if (lineCount % SAMPLE_INTERVAL === 0) memory.sample();
    }
  }
  memory.sample();

  const result = {
    mode: useSerializedTextLower ? "stream-key" : "stream",
    shards: shardPaths.length,
    lines: lineCount,
    matches: matchCount,
    candidateCount,
    falsePositiveCount,
    prefilter: useSerializedTextLower
      ? "serialized-text-lower"
      : prefilterNeedle === undefined
        ? "skipped-non-ascii"
        : "ascii-case-insensitive",
    totalMs: roundMs(performance.now() - totalStart),
    verificationMs: roundMs(verificationMs),
    scanAndPrefilterMs: roundMs(
      performance.now() - totalStart - verificationMs
    ),
    ...memory.report(),
  };

  if (compareBuffer) {
    const bufferStart = performance.now();
    const bufferHits =
      prefilterNeedle === undefined
        ? 0
        : await scanWithBuffer(shardPaths, prefilterNeedle.text);
    result.bufferScanMs = roundMs(performance.now() - bufferStart);
    result.bufferHits = bufferHits;
  }

  return result;
}

async function runShippedScanner(indexDirectory, query) {
  const scannerPath = resolve(
    "out/core/orchestration/HistorySearchShardScanner.js"
  );
  const originalLoad = Module._load;
  Module._load = function loadWithoutVSCode(request, parent, isMain) {
    if (request === "vscode") {
      return {};
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  let streamHistorySearchDocuments;
  try {
    ({ streamHistorySearchDocuments } = await import(
      pathToFileURL(scannerPath).href
    ));
  } finally {
    Module._load = originalLoad;
  }
  const documentsDirectory = join(indexDirectory, DOCUMENTS_DIRECTORY_NAME);
  const memory = createMemoryTracker();
  const normalizedQuery = query.trim();
  // The scanner picks its prefilter from whether the shards carry the
  // serialized lowercase key, so sniff the real shards rather than assume it.
  const scanOptions = {
    hasPersistedLowercaseKey:
      await hasPersistedLowercaseKey(documentsDirectory),
  };
  console.log(
    `shards carry the lowercase key: ${scanOptions.hasPersistedLowercaseKey}`
  );

  async function collect(queryToRun) {
    let matchCount = 0;
    for await (const document of streamHistorySearchDocuments(
      documentsDirectory,
      queryToRun,
      scanOptions
    )) {
      if (document.text.toLowerCase().includes(queryToRun.toLowerCase())) {
        matchCount += 1;
      }
    }
    memory.sample();
    return matchCount;
  }

  const firstStart = performance.now();
  const firstMatches = await collect(normalizedQuery);
  const firstSearchMs = performance.now() - firstStart;

  const warmStart = performance.now();
  const warmMatches = await collect(normalizedQuery);
  const warmRepeatMs = performance.now() - warmStart;

  const comparisonQueries = ["the", "zzzzzzzzzz"];
  const comparisonMatches = {};
  for (const comparisonQuery of comparisonQueries) {
    comparisonMatches[comparisonQuery] = await collect(comparisonQuery);
  }

  return {
    mode: "shipped-scanner",
    implementation: scannerPath,
    query: normalizedQuery,
    firstMatches,
    firstSearchMs: roundMs(firstSearchMs),
    warmMatches,
    warmRepeatMs: roundMs(warmRepeatMs),
    comparisonMatches,
    searches: 2 + comparisonQueries.length,
    ...memory.report(),
  };
}

async function scanWithBuffer(shardPaths, needle) {
  const pattern = Buffer.from(needle, "ascii");
  if (pattern.length === 0) return 0;
  const failure = buildKmpFailureTable(pattern);

  let hits = 0;
  for (const shardPath of shardPaths) {
    let matchedLength = 0;
    for await (const chunk of createReadStream(shardPath)) {
      for (const byte of chunk) {
        const foldedByte = byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
        while (matchedLength > 0 && foldedByte !== pattern[matchedLength]) {
          matchedLength = failure[matchedLength - 1];
        }
        if (foldedByte === pattern[matchedLength]) {
          matchedLength += 1;
          if (matchedLength === pattern.length) {
            hits += 1;
            matchedLength = failure[matchedLength - 1];
          }
        }
      }
    }
  }
  return hits;
}

function buildKmpFailureTable(pattern) {
  const failure = new Uint32Array(pattern.length);
  let prefixLength = 0;
  for (let index = 1; index < pattern.length; index += 1) {
    while (prefixLength > 0 && pattern[index] !== pattern[prefixLength]) {
      prefixLength = failure[prefixLength - 1];
    }
    if (pattern[index] === pattern[prefixLength]) {
      prefixLength += 1;
    }
    failure[index] = prefixLength;
  }
  return failure;
}

function roundMs(milliseconds) {
  return Number(milliseconds.toFixed(1));
}

async function main() {
  const options = parseArguments();
  const shardPaths = await getShardPaths(options.indexDirectory);
  if (shardPaths.length === 0) {
    throw new Error(`no JSONL shards found under ${options.indexDirectory}`);
  }

  const result =
    options.mode === "resident"
      ? await runResident(shardPaths, options.query)
      : options.mode === "stream"
        ? await runStream(
            shardPaths,
            options.query,
            options.compareBuffer,
            false
          )
        : options.mode === "stream-key"
          ? await runStream(shardPaths, options.query, false, true)
          : await runShippedScanner(options.indexDirectory, options.query);
  console.log(
    JSON.stringify({
      indexDirectory: options.indexDirectory,
      query: options.query,
      ...result,
    })
  );
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

async function hasPersistedLowercaseKey(documentsDirectory) {
  const shardNames = (await readdir(documentsDirectory)).filter((name) =>
    DOCUMENT_SHARD_PATTERN.test(name)
  );
  for (const shardName of shardNames) {
    for await (const line of streamFileLines(
      join(documentsDirectory, shardName)
    )) {
      if (line.trim().length === 0) {
        continue;
      }
      return typeof JSON.parse(line).textLower === "string";
    }
  }
  return false;
}
