#!/usr/bin/env node
/**
 * Rebuilds deleted run history (`.runs/<workflowKey>/…`) from a copy of the
 * project's history search index (`.search-index/v1`).
 *
 * The index is a lossy projection of each run's events.jsonl: it keeps only the
 * searchable text of CLI output (prompt, response, CLI command, structured
 * tool/text events) and status messages, each string capped at
 * MAX_INDEXED_TEXT_LENGTH characters. This script inverts that projection
 * (see HistoryCandidateExtractor / HistoryRunDocumentBuilder) back into
 * timeline events, a manifest, a working copy, and a lineage descriptor that
 * the dashboard and `ctrlyoke history show` can read. What the index never
 * stored cannot come back: step names, conditions, execution properties other
 * than harness/model/session ID, token usage, workspace snapshots and undo
 * records, and any text past the cap. Truncated strings are marked.
 *
 * Usage:
 *   node scripts/recover-runs-from-search-index.mjs --index <dir> [options]
 *
 *   --index <dir>        A copy of `.search-index` (or its `v1` child). Always
 *                        point this at a backup: ctrlyoke prunes the live index
 *                        of runs it can no longer find.
 *   --runs-root <dir>    Where to write lineages. Defaults to the `.runs`
 *                        directory the index was built from.
 *   --include-orphans    Also restore runs found only in shards the index
 *                        manifest no longer lists (usually runs deleted
 *                        deliberately before the index was last rebuilt).
 *   --only <text>        Only restore lineages whose key contains <text>.
 *   --apply              Write files. Without it the script only reports.
 *
 * Existing run directories and descriptors are never modified or replaced.
 *
 *   node scripts/recover-runs-from-search-index.mjs --repair-diffs --runs-root <dir> [--apply]
 *
 * Re-derives the file-edit patches of runs an earlier --apply restored (as
 * listed in its .recovery-report-*.json) so every hunk parses; runs restored
 * before patches were built this way can crash the dashboard's diff view.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as readline from "node:readline";

// Mirrors of src/ constants, which this plain-Node script cannot import.
const MAX_INDEXED_TEXT_LENGTH = 2000; // historySearchRebuildWorker.ts
const INDEX_VERSION_DIR = "v1";
const INDEX_MANIFEST_FILE = "manifest.json";
const DOCUMENTS_DIR = "documents";
const REBUILD_DIR_PREFIX = "rebuild-";
const DESCRIPTOR_FILE = "workflow.json";
const RUN_MANIFEST_FILE = "manifest.json";
const RUN_EVENTS_FILE = "events.jsonl";
const RUN_WORKING_FILE = "workflow.ctrlyoke.json";
const SCHEMA_VERSION = 1; // PersistedSchemaGuard CURRENT_SCHEMA_VERSIONS
const TRUNCATION_MARKER =
  "\n\n[… truncated: recovered from the history search index]";
const MISSING_PROMPT =
  "[This step's prompt could not be recovered from the history search index.]";

const HISTORY_EVENT_KINDS = {
  PROMPT: "prompt",
  RESPONSE: "response",
  THINKING: "thinking",
  BASH: "bash",
  FILE_READ: "fileRead",
  FILE_WRITE: "fileWrite",
  FILE_EDIT: "fileEdit",
  FILE_DELETE: "fileDelete",
  TOOL: "tool",
  MCP_TOOL: "mcpTool",
  WEB_SEARCH: "webSearch",
  COMPACTION: "compaction",
  CLI_COMMAND: "cliCommand",
  STATUS: "status",
  SCRIPT: "script",
  PRE_CONDITION: "preCondition",
  END_CONDITION: "endCondition",
};

const HISTORY_MATCH_FIELDS = {
  PATH: "path",
  CONTENT: "content",
  DIFF: "diff",
  COMMAND: "command",
  OUTPUT: "output",
  ERROR: "error",
};

const CLI_EVENT_TYPES = {
  TEXT: "text",
  THINKING: "thinking",
  BASH_COMMAND: "bashCommand",
  FILE_READ: "fileRead",
  FILE_WRITE: "fileWrite",
  FILE_EDIT: "fileEdit",
  FILE_DELETE: "fileDelete",
  MCP_TOOL_CALL: "mcpToolCall",
  WEB_SEARCH: "webSearch",
  TOOL_CALL: "toolCall",
  TOOL_RESULT: "toolResult",
  COMPACTION: "compaction",
};

const FILE_EVENT_TYPE_BY_KIND = {
  [HISTORY_EVENT_KINDS.FILE_READ]: CLI_EVENT_TYPES.FILE_READ,
  [HISTORY_EVENT_KINDS.FILE_WRITE]: CLI_EVENT_TYPES.FILE_WRITE,
  [HISTORY_EVENT_KINDS.FILE_EDIT]: CLI_EVENT_TYPES.FILE_EDIT,
  [HISTORY_EVENT_KINDS.FILE_DELETE]: CLI_EVENT_TYPES.FILE_DELETE,
};

const TIMELINE_EVENT_TYPES = {
  CLI_OUTPUT_RECORDED: "cliOutputRecorded",
  CLI_OUTPUT_EVENTS_APPENDED: "cliOutputEventsAppended",
  ATTEMPT_STARTED: "attemptStarted",
  ATTEMPT_TERMINATED: "attemptTerminated",
  RUN_TERMINATED: "runTerminated",
  STATUS_MESSAGE_RECORDED: "statusMessageRecorded",
};

const TARGET_KINDS = { QUEUE: "queue", FINAL_STEP: "finalStep" };
const STEP_TYPE_SCRIPT = "script";
const STATUS_SEVERITY_INFO = "info";

const EXECUTION_STATES = {
  RUNNING: "running",
  PAUSED: "paused",
  STOPPED: "stopped",
  CANCELLING: "cancelling",
  COMPLETED: "completed",
  ERROR: "error",
};
// A run that was live when its files were deleted can never resume; restore it
// as stopped rather than as a phantom active run.
const INTERRUPTED_STATES = new Set([
  EXECUTION_STATES.RUNNING,
  EXECUTION_STATES.PAUSED,
  EXECUTION_STATES.CANCELLING,
]);

const ATTEMPT_KINDS = { AI: "ai", SCRIPT: "script", CONDITION: "condition" };
const ATTEMPT_TERMINAL_STATES = {
  COMPLETED: "completed",
  FAILED: "failed",
  STOPPED: "stopped",
};
const STEP_TERMINAL_STATUSES = {
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

/** Script-family index kinds → CliOutput.source / event phase / attempt kind. */
const SCRIPT_KIND_INFO = {
  [HISTORY_EVENT_KINDS.SCRIPT]: {
    source: "script",
    phase: undefined,
    attemptKind: ATTEMPT_KINDS.SCRIPT,
  },
  [HISTORY_EVENT_KINDS.PRE_CONDITION]: {
    source: "preCondition",
    phase: "preCondition",
    attemptKind: ATTEMPT_KINDS.CONDITION,
  },
  [HISTORY_EVENT_KINDS.END_CONDITION]: {
    source: "endCondition",
    phase: "endCondition",
    attemptKind: ATTEMPT_KINDS.CONDITION,
  },
};

const GROUP_KINDS = {
  RECORDED: "recorded",
  APPENDED: "appended",
  STATUS: "status",
};

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

function parseArguments(args) {
  const options = {
    index: undefined,
    runsRoot: undefined,
    includeOrphans: false,
    only: undefined,
    apply: false,
  };
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (argument === "--apply") options.apply = true;
    else if (argument === "--include-orphans") options.includeOrphans = true;
    else if (argument === "--repair-diffs") options.repairDiffs = true;
    else if (argument === "--index") options.index = args[++i];
    else if (argument === "--runs-root") options.runsRoot = args[++i];
    else if (argument === "--only") options.only = args[++i];
    else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

async function resolveIndexDir(indexArgument) {
  const candidates = [
    path.join(indexArgument, INDEX_VERSION_DIR),
    indexArgument,
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, INDEX_MANIFEST_FILE));
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  throw new Error(`No ${INDEX_MANIFEST_FILE} found under ${indexArgument}`);
}

// ---------------------------------------------------------------------------
// Shard discovery
// ---------------------------------------------------------------------------

/** Same derivation as getDocumentsShardFileName() in historySearchRebuildWorker.ts. */
function shardFileNameForManifest(manifestPath) {
  return `${createHash("sha256").update(path.resolve(manifestPath)).digest("hex")}.jsonl`;
}

async function listShardFiles(indexDir) {
  const directories = [path.join(indexDir, DOCUMENTS_DIR)];
  for (const entry of await fs.readdir(indexDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(REBUILD_DIR_PREFIX)) {
      directories.push(path.join(indexDir, entry.name, DOCUMENTS_DIR));
    }
  }
  const files = [];
  for (const directory of directories) {
    let names;
    try {
      names = await fs.readdir(directory);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = path.join(directory, name);
      const stats = await fs.stat(filePath);
      files.push({ filePath, name, mtimeMs: stats.mtimeMs, size: stats.size });
    }
  }
  return files;
}

async function readShard(filePath) {
  const documents = [];
  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      documents.push(JSON.parse(line));
    } catch {
      // A torn final line from an interrupted shard write; skip it.
    }
  }
  return documents;
}

async function readShardIdentity(filePath) {
  const lines = readline.createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const document = JSON.parse(line);
      return { workflowKey: document.workflowKey, runRef: document.runRef };
    }
  } finally {
    lines.close();
  }
  return undefined;
}

/**
 * Chooses one shard per run. The shard the index manifest lists wins; otherwise
 * (orphans, rebuild leftovers) the most recently written shard does.
 */
async function selectRunSources(indexDir, indexManifest, options) {
  const listedByShardName = new Map();
  for (const entry of Object.values(indexManifest.indexedRuns ?? {})) {
    listedByShardName.set(shardFileNameForManifest(entry.manifestPath), entry);
  }

  const runs = new Map();
  const upsert = (runKey, candidate) => {
    const existing = runs.get(runKey);
    if (
      !existing ||
      (candidate.listed && !existing.listed) ||
      (candidate.listed === existing.listed &&
        (candidate.shard?.mtimeMs ?? 0) > (existing.shard?.mtimeMs ?? 0))
    ) {
      runs.set(runKey, candidate);
    }
  };

  for (const shard of await listShardFiles(indexDir)) {
    const identity = await readShardIdentity(shard.filePath);
    const listedEntry = listedByShardName.get(shard.name);
    if (!identity) continue; // empty shard; a listed empty run is handled below
    upsert(`${identity.workflowKey}/${identity.runRef}`, {
      ...identity,
      shard,
      listed: Boolean(listedEntry),
      indexEntry: listedEntry,
    });
  }

  // Listed runs with no text documents still get a metadata-only restore.
  for (const entry of Object.values(indexManifest.indexedRuns ?? {})) {
    const runDirectory = path.dirname(entry.manifestPath);
    const runKey = `${path.basename(path.dirname(runDirectory))}/${path.basename(runDirectory)}`;
    const existing = runs.get(runKey);
    if (existing) {
      existing.indexEntry ??= entry;
      continue;
    }
    runs.set(runKey, {
      workflowKey: path.basename(path.dirname(runDirectory)),
      runRef: path.basename(runDirectory),
      shard: undefined,
      listed: true,
      indexEntry: entry,
    });
  }

  return [...runs.values()].filter(
    (run) =>
      (run.listed || options.includeOrphans) &&
      (!options.only || run.workflowKey.includes(options.only))
  );
}

// ---------------------------------------------------------------------------
// Document → event reconstruction
// ---------------------------------------------------------------------------

function markTruncated(text) {
  return typeof text === "string" && text.length >= MAX_INDEXED_TEXT_LENGTH
    ? `${text}${TRUNCATION_MARKER}`
    : text;
}

const PATCH_LINE_PREFIXES = new Set([" ", "+", "-", "\\"]);

/**
 * Rebuilds a single-hunk structured patch from the index's flattened diff text
 * (hunk lines joined with "\n"). jsdiff's parsePatch rejects any hunk line that
 * does not start with a patch prefix, so anything else (a line cut by the
 * index's length cap, a stray blank) is dropped, and the counts are derived
 * from the kept lines so the hunk header matches its body exactly.
 */
function buildRecoveredPatch(diffText) {
  const lines = diffText
    .split("\n")
    .filter((line) => line.length > 0 && PATCH_LINE_PREFIXES.has(line[0]));
  if (lines.length === 0) return undefined;
  const count = (prefixes) =>
    lines.filter((line) => prefixes.includes(line[0])).length;
  return [
    {
      oldStart: 1,
      oldLines: count([" ", "-"]),
      newStart: 1,
      newLines: count([" ", "+"]),
      lines,
    },
  ];
}

/** Flattens structured patch hunks back to the text the index stored. */
function flattenPatchLines(structuredPatch) {
  return (structuredPatch ?? [])
    .flatMap((hunk) => (Array.isArray(hunk?.lines) ? hunk.lines : []))
    .join("\n");
}

/** Re-derives every fileEdit patch in one timeline event; returns whether anything changed. */
function repairEventPatches(event) {
  const cliEvents = [
    ...(event.payload?.events ?? []),
    ...(event.payload?.cliOutput?.structured?.events ?? []),
  ];
  let changed = false;
  for (const cliEvent of cliEvents) {
    if (cliEvent?.type !== CLI_EVENT_TYPES.FILE_EDIT) continue;
    if (cliEvent.data?.structuredPatch === undefined) continue;
    const before = JSON.stringify(cliEvent.data.structuredPatch);
    const rebuilt = buildRecoveredPatch(
      flattenPatchLines(cliEvent.data.structuredPatch)
    );
    if (rebuilt === undefined) delete cliEvent.data.structuredPatch;
    else cliEvent.data.structuredPatch = rebuilt;
    if (JSON.stringify(cliEvent.data.structuredPatch) !== before)
      changed = true;
  }
  return changed;
}

/**
 * Repairs file-edit patches in runs an earlier --apply restored (listed in its
 * .recovery-report-*.json), rewriting only events.jsonl files that change.
 */
async function repairRecoveredDiffs(runsRoot, apply) {
  const reports = (await fs.readdir(runsRoot)).filter((name) =>
    name.startsWith(".recovery-report-")
  );
  const runKeys = new Set();
  for (const name of reports) {
    const report = JSON.parse(
      await fs.readFile(path.join(runsRoot, name), "utf8")
    );
    for (const entry of report.restored ?? []) runKeys.add(entry.run);
  }
  let repairedRuns = 0;
  let repairedEvents = 0;
  for (const runKey of runKeys) {
    const eventsPath = path.join(
      runsRoot,
      ...runKey.split("/"),
      RUN_EVENTS_FILE
    );
    let content;
    try {
      content = await fs.readFile(eventsPath, "utf8");
    } catch {
      continue; // deleted since it was restored
    }
    let runChanged = 0;
    const lines = content.split("\n").map((line) => {
      if (!line.trim()) return line;
      const event = JSON.parse(line);
      if (!repairEventPatches(event)) return line;
      runChanged += 1;
      return JSON.stringify(event);
    });
    if (runChanged === 0) continue;
    repairedRuns += 1;
    repairedEvents += runChanged;
    if (apply) {
      const temporaryPath = `${eventsPath}.repair-${process.pid}.tmp`;
      await fs.writeFile(temporaryPath, lines.join("\n"), "utf8");
      await fs.rename(temporaryPath, eventsPath);
    }
  }
  process.stdout.write(
    `Restored runs checked: ${runKeys.size}\n` +
      `Runs ${apply ? "repaired" : "to repair"}: ${repairedRuns} (${repairedEvents} events)\n`
  );
}

function candidateIndexOf(document) {
  const index = Number(document.id.slice(document.id.lastIndexOf(":") + 1));
  return Number.isFinite(index) ? index : 0;
}

function targetKey(target) {
  return target.kind === TARGET_KINDS.QUEUE
    ? `queue:${target.stepIndex}`
    : `final:${target.loopIndex}`;
}

function parseJsonValue(text) {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function looksLikeUrl(text) {
  return /^https?:\/\/\S+$/.test(text.trim());
}

/**
 * Regroups the ordered per-field documents of one timeline event back into
 * CliEvent objects, inverting HistoryCandidateExtractor's flattening.
 */
function documentsToCliEvents(documents, timestamp) {
  const events = [];
  const current = () => events[events.length - 1];
  const push = (type, data) => {
    events.push({ type, timestamp, data });
    return events[events.length - 1];
  };

  for (const document of documents) {
    const text = markTruncated(document.text);
    const { eventKind, matchField } = document;
    switch (eventKind) {
      case HISTORY_EVENT_KINDS.RESPONSE:
        push(CLI_EVENT_TYPES.TEXT, { text });
        break;
      case HISTORY_EVENT_KINDS.THINKING:
        push(CLI_EVENT_TYPES.THINKING, { text });
        break;
      case HISTORY_EVENT_KINDS.COMPACTION:
        push(CLI_EVENT_TYPES.COMPACTION, { summary: text });
        break;
      case HISTORY_EVENT_KINDS.BASH: {
        const last = current();
        const canExtend =
          last?.type === CLI_EVENT_TYPES.BASH_COMMAND &&
          matchField !== HISTORY_MATCH_FIELDS.COMMAND &&
          last.data[matchField] === undefined &&
          !(
            matchField === HISTORY_MATCH_FIELDS.OUTPUT &&
            last.data.error !== undefined
          );
        if (canExtend) last.data[matchField] = text;
        else push(CLI_EVENT_TYPES.BASH_COMMAND, { [matchField]: text });
        break;
      }
      case HISTORY_EVENT_KINDS.FILE_READ:
      case HISTORY_EVENT_KINDS.FILE_WRITE:
      case HISTORY_EVENT_KINDS.FILE_EDIT:
      case HISTORY_EVENT_KINDS.FILE_DELETE: {
        const type = FILE_EVENT_TYPE_BY_KIND[eventKind];
        const last = current();
        const filePath =
          document.filePath ??
          (matchField === HISTORY_MATCH_FIELDS.PATH ? text : undefined);
        const extendsLast =
          matchField !== HISTORY_MATCH_FIELDS.PATH &&
          last?.type === type &&
          last.data.path === filePath;
        const target = extendsLast ? last : push(type, { path: filePath });
        if (matchField === HISTORY_MATCH_FIELDS.CONTENT)
          target.data.content = text;
        if (matchField === HISTORY_MATCH_FIELDS.DIFF) {
          // Built from the raw index text: a truncation marker is not a valid patch line.
          target.data.structuredPatch = buildRecoveredPatch(document.text);
        }
        break;
      }
      case HISTORY_EVENT_KINDS.TOOL: {
        const last = current();
        if (matchField === HISTORY_MATCH_FIELDS.CONTENT) {
          const parameters = parseJsonValue(document.text);
          if (
            parameters !== undefined &&
            last?.type === CLI_EVENT_TYPES.TOOL_CALL &&
            last.data.parameters === undefined
          ) {
            last.data.parameters = parameters;
          } else if (parameters !== undefined) {
            push(CLI_EVENT_TYPES.TOOL_CALL, { name: "tool", parameters });
          } else {
            push(CLI_EVENT_TYPES.TOOL_CALL, { name: text });
          }
        } else {
          // Tool output/error only reach the index through TOOL_RESULT events;
          // fold them back into the call they answer when there is one.
          const field =
            matchField === HISTORY_MATCH_FIELDS.ERROR ? "error" : "output";
          if (
            last?.type === CLI_EVENT_TYPES.TOOL_CALL &&
            last.data.result?.[field] === undefined
          ) {
            last.data.result ??= { success: true };
            last.data.result[field] = text;
            if (field === "error") last.data.result.success = false;
          } else {
            push(CLI_EVENT_TYPES.TOOL_RESULT, {
              result: { success: field !== "error", [field]: text },
            });
          }
        }
        break;
      }
      case HISTORY_EVENT_KINDS.MCP_TOOL: {
        const last = current();
        const parameters = parseJsonValue(document.text);
        if (parameters !== undefined) {
          if (
            last?.type === CLI_EVENT_TYPES.MCP_TOOL_CALL &&
            last.data.parameters === undefined
          ) {
            last.data.parameters = parameters;
          } else {
            push(CLI_EVENT_TYPES.MCP_TOOL_CALL, {
              server: "unknown",
              tool: "unknown",
              parameters,
            });
          }
        } else if (
          last?.type === CLI_EVENT_TYPES.MCP_TOOL_CALL &&
          last.data.tool === undefined &&
          last.data.parameters === undefined
        ) {
          last.data.tool = text;
        } else {
          push(CLI_EVENT_TYPES.MCP_TOOL_CALL, { server: text });
        }
        break;
      }
      case HISTORY_EVENT_KINDS.WEB_SEARCH: {
        const last = current();
        if (
          matchField === HISTORY_MATCH_FIELDS.COMMAND ||
          last?.type !== CLI_EVENT_TYPES.WEB_SEARCH
        ) {
          push(CLI_EVENT_TYPES.WEB_SEARCH, {
            query: matchField === HISTORY_MATCH_FIELDS.COMMAND ? text : "",
            results: [],
          });
          if (matchField === HISTORY_MATCH_FIELDS.COMMAND) break;
        }
        const results = current().data.results;
        const result = results[results.length - 1];
        if (looksLikeUrl(text)) {
          if (result && result.url === undefined) result.url = text;
          else results.push({ url: text });
        } else if (
          result &&
          result.url === undefined &&
          result.snippet === undefined &&
          result.title !== undefined
        ) {
          result.snippet = text;
        } else {
          results.push({ title: text });
        }
        break;
      }
      default:
        break;
    }
  }

  // An MCP call whose server name was never indexed shows its only name as the tool.
  for (const event of events) {
    if (
      event.type === CLI_EVENT_TYPES.MCP_TOOL_CALL &&
      event.data.tool === undefined
    ) {
      event.data.tool = event.data.server;
      event.data.server = "unknown";
    }
  }
  return events;
}

function classifyGroup(documents) {
  if (
    documents.every(
      (document) => document.eventKind === HISTORY_EVENT_KINDS.STATUS
    )
  ) {
    return GROUP_KINDS.STATUS;
  }
  const isRecorded = documents.some(
    (document) =>
      document.eventKind === HISTORY_EVENT_KINDS.PROMPT ||
      document.eventKind === HISTORY_EVENT_KINDS.CLI_COMMAND ||
      SCRIPT_KIND_INFO[document.eventKind] !== undefined
  );
  return isRecorded ? GROUP_KINDS.RECORDED : GROUP_KINDS.APPENDED;
}

/** Splits a CLI_OUTPUT_RECORDED group into its CliOutput fields (candidate order: prompt, response, command, structured…). */
function parseRecordedGroup(documents) {
  const metadataSource = documents.find(
    (document) => document.harness || document.model || document.sessionId
  );
  const metadata = metadataSource
    ? {
        harness: metadataSource.harness,
        model: metadataSource.model,
        sessionId: metadataSource.sessionId,
      }
    : undefined;

  const scriptKind = documents.find(
    (document) => SCRIPT_KIND_INFO[document.eventKind]
  )?.eventKind;
  if (scriptKind) {
    const byField = (field) =>
      documents.find(
        (document) =>
          document.eventKind === scriptKind && document.matchField === field
      )?.text;
    return {
      scriptKind,
      prompt: byField(HISTORY_MATCH_FIELDS.CONTENT),
      response: byField(HISTORY_MATCH_FIELDS.OUTPUT),
      cliCommand: byField(HISTORY_MATCH_FIELDS.COMMAND),
      structuredDocuments: [],
      metadata,
    };
  }

  let index = 0;
  let prompt;
  let response;
  let cliCommand;
  const hasCliCommand = documents.some(
    (document) => document.eventKind === HISTORY_EVENT_KINDS.CLI_COMMAND
  );
  if (documents[index]?.eventKind === HISTORY_EVENT_KINDS.PROMPT) {
    prompt = documents[index].text;
    index += 1;
  }
  if (
    documents[index]?.eventKind === HISTORY_EVENT_KINDS.RESPONSE &&
    (documents[index + 1]?.eventKind === HISTORY_EVENT_KINDS.CLI_COMMAND ||
      !hasCliCommand)
  ) {
    response = documents[index].text;
    index += 1;
  }
  if (documents[index]?.eventKind === HISTORY_EVENT_KINDS.CLI_COMMAND) {
    cliCommand = documents[index].text;
    index += 1;
  }
  return {
    scriptKind: undefined,
    prompt,
    response,
    cliCommand,
    structuredDocuments: documents.slice(index),
    metadata,
  };
}

/**
 * Rebuilds one run's timeline events and step definitions from its index
 * documents. Original timestamps are kept and sequences are renumbered in
 * original order, so OutputHistoryTimelineAdapter folds streamed deltas and
 * sealing snapshots exactly as it did for the real events.
 */
function reconstructRun(documents, runInfo) {
  const groupsBySequence = new Map();
  for (const document of documents) {
    const group = groupsBySequence.get(document.sequence) ?? [];
    group.push(document);
    groupsBySequence.set(document.sequence, group);
  }
  const groups = [...groupsBySequence.entries()]
    .sort(([left], [right]) => left - right)
    .map(([sequence, groupDocuments]) => {
      groupDocuments.sort(
        (left, right) => candidateIndexOf(left) - candidateIndexOf(right)
      );
      const first = groupDocuments[0];
      return {
        sequence,
        documents: groupDocuments,
        kind: classifyGroup(groupDocuments),
        target: first.target,
        attemptIndex: first.attemptIndex ?? 0,
        timestampMs: first.timestampMs,
      };
    });

  // Resolve per-group attempt identity (phase + runIndex) and CliOutput parts.
  const runIndexByKey = new Map();
  const sealedByKey = new Map();
  for (const group of groups) {
    if (group.kind === GROUP_KINDS.STATUS) continue;
    if (group.kind === GROUP_KINDS.RECORDED) {
      group.parsed = parseRecordedGroup(group.documents);
      group.phase = group.parsed.scriptKind
        ? SCRIPT_KIND_INFO[group.parsed.scriptKind].phase
        : undefined;
    } else {
      group.phase = undefined;
    }
    const baseKey = `${targetKey(group.target)}:${group.attemptIndex}:${group.phase ?? ""}`;
    const isPlaceholder =
      group.kind === GROUP_KINDS.RECORDED &&
      !group.parsed.response &&
      !group.parsed.cliCommand &&
      group.parsed.structuredDocuments.length === 0;
    // A fresh streaming placeholder after a sealed snapshot opens a new run of the step.
    if (isPlaceholder && sealedByKey.get(baseKey)) {
      runIndexByKey.set(baseKey, (runIndexByKey.get(baseKey) ?? 0) + 1);
      sealedByKey.set(baseKey, false);
    }
    group.runIndex = runIndexByKey.get(baseKey) ?? 0;
    group.attemptKey = `${baseKey}:${group.runIndex}`;
    group.isPlaceholder = isPlaceholder;
    if (group.kind === GROUP_KINDS.RECORDED && !isPlaceholder)
      sealedByKey.set(baseKey, true);
  }

  // Attempt bookkeeping for attemptStarted/attemptTerminated and step metadata.
  const attempts = new Map();
  for (const group of groups) {
    if (group.kind === GROUP_KINDS.STATUS) continue;
    const attempt = attempts.get(group.attemptKey) ?? {
      target: group.target,
      runIndex: group.runIndex,
      attemptIndex: group.attemptIndex,
      phase: group.phase,
      groups: [],
    };
    attempt.groups.push(group);
    attempts.set(group.attemptKey, attempt);
  }
  for (const attempt of attempts.values()) {
    const recorded = attempt.groups.filter(
      (group) => group.kind === GROUP_KINDS.RECORDED
    );
    attempt.firstRecorded = recorded[0];
    attempt.lastRecorded = recorded[recorded.length - 1];
    attempt.prompt =
      recorded.map((group) => group.parsed.prompt).find(Boolean) ??
      (attempt.lastRecorded?.parsed.scriptKind
        ? attempt.lastRecorded.parsed.cliCommand
        : undefined);
    attempt.scriptKind = attempt.lastRecorded?.parsed.scriptKind;
    attempt.metadata = [...recorded]
      .reverse()
      .map((group) => group.parsed.metadata)
      .find(Boolean);
    attempt.startedAt = Math.min(
      ...attempt.groups.map((group) => group.timestampMs)
    );
    attempt.endedAt = Math.max(
      ...attempt.groups.map((group) => group.timestampMs)
    );
    attempt.firstSequence = attempt.groups[0].sequence;
    attempt.lastSequence = attempt.groups[attempt.groups.length - 1].sequence;
  }

  const executionState = INTERRUPTED_STATES.has(runInfo.executionState)
    ? EXECUTION_STATES.STOPPED
    : runInfo.executionState;
  const isTerminal = [
    EXECUTION_STATES.COMPLETED,
    EXECUTION_STATES.ERROR,
    EXECUTION_STATES.STOPPED,
  ].includes(executionState);
  const lastAttempt = [...attempts.values()].sort(
    (left, right) => right.lastSequence - left.lastSequence
  )[0];
  const attemptTerminalState = (attempt) => {
    const retried = [...attempts.values()].some(
      (other) =>
        other !== attempt &&
        targetKey(other.target) === targetKey(attempt.target) &&
        other.phase === attempt.phase &&
        other.runIndex === attempt.runIndex &&
        other.attemptIndex > attempt.attemptIndex
    );
    if (retried) return ATTEMPT_TERMINAL_STATES.FAILED;
    if (attempt !== lastAttempt) return ATTEMPT_TERMINAL_STATES.COMPLETED;
    if (executionState === EXECUTION_STATES.ERROR)
      return ATTEMPT_TERMINAL_STATES.FAILED;
    if (executionState === EXECUTION_STATES.STOPPED)
      return ATTEMPT_TERMINAL_STATES.STOPPED;
    return ATTEMPT_TERMINAL_STATES.COMPLETED;
  };
  for (const attempt of attempts.values())
    attempt.terminalState = attemptTerminalState(attempt);

  // Emit events. `order` is a fractional key between original sequences.
  const drafts = [];
  const common = (group) => ({
    target: group.target,
    runIndex: group.runIndex,
    attemptIndex: group.attemptIndex,
    ...(group.phase ? { phase: group.phase } : {}),
  });

  for (const attempt of attempts.values()) {
    const identity = {
      target: attempt.target,
      runIndex: attempt.runIndex,
      attemptIndex: attempt.attemptIndex,
      ...(attempt.phase ? { phase: attempt.phase } : {}),
      definitionRevision: 1,
    };
    drafts.push({
      order: attempt.firstSequence - 0.5,
      event: {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_STARTED,
        timestampMs: attempt.startedAt,
        ...identity,
        payload: {
          kind: attempt.scriptKind
            ? SCRIPT_KIND_INFO[attempt.scriptKind].attemptKind
            : ATTEMPT_KINDS.AI,
          startReason: attempt.attemptIndex > 0 ? "retry" : "initial",
          prompt: markTruncated(attempt.prompt ?? ""),
        },
      },
    });
    drafts.push({
      order: attempt.lastSequence + 0.5,
      event: {
        eventType: TIMELINE_EVENT_TYPES.ATTEMPT_TERMINATED,
        timestampMs: attempt.endedAt,
        ...identity,
        payload: { terminalState: attempt.terminalState },
      },
    });
  }

  for (const group of groups) {
    if (group.kind === GROUP_KINDS.STATUS) {
      for (const document of group.documents) {
        drafts.push({
          order: group.sequence,
          event: {
            eventType: TIMELINE_EVENT_TYPES.STATUS_MESSAGE_RECORDED,
            timestampMs: group.timestampMs,
            target: group.target,
            payload: {
              statusMessage: {
                message: markTruncated(document.text),
                severity: STATUS_SEVERITY_INFO,
                timestamp: group.timestampMs,
              },
            },
          },
        });
      }
      continue;
    }

    if (group.kind === GROUP_KINDS.APPENDED) {
      drafts.push({
        order: group.sequence,
        event: {
          eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_EVENTS_APPENDED,
          timestampMs: group.timestampMs,
          ...common(group),
          payload: {
            events: documentsToCliEvents(group.documents, group.timestampMs),
          },
        },
      });
      continue;
    }

    const { parsed } = group;
    const attempt = attempts.get(group.attemptKey);
    const hasLaterGroup = attempt.groups.some(
      (other) => other.sequence > group.sequence
    );
    // Scripts and conditions record a command-only placeholder before their result.
    const isStreaming =
      hasLaterGroup &&
      !parsed.response &&
      parsed.structuredDocuments.length === 0;
    const structuredEvents = documentsToCliEvents(
      parsed.structuredDocuments,
      group.timestampMs
    );
    const scriptInfo = parsed.scriptKind
      ? SCRIPT_KIND_INFO[parsed.scriptKind]
      : undefined;
    const cliOutput = {
      prompt: markTruncated(parsed.prompt ?? ""),
      response: markTruncated(parsed.response ?? ""),
      ...(structuredEvents.length > 0 || parsed.metadata
        ? {
            structured: {
              events: structuredEvents,
              ...(parsed.metadata ? { metadata: parsed.metadata } : {}),
            },
          }
        : {}),
      isStreaming,
      ...(parsed.cliCommand
        ? { cliCommand: markTruncated(parsed.cliCommand) }
        : {}),
      ...(scriptInfo ? { source: scriptInfo.source } : {}),
      timestampMs: group.timestampMs,
      runIndex: group.runIndex,
      attemptIndex: group.attemptIndex,
    };
    drafts.push({
      order: group.sequence,
      event: {
        eventType: TIMELINE_EVENT_TYPES.CLI_OUTPUT_RECORDED,
        timestampMs: group.timestampMs,
        ...common(group),
        definitionRevision: 1,
        responseKind: scriptInfo ? scriptInfo.attemptKind : ATTEMPT_KINDS.AI,
        payload: { cliOutput },
      },
    });
  }

  // Step definitions: the earliest prompt-phase attempt of each target.
  const stepAttempts = new Map();
  for (const attempt of attempts.values()) {
    if (attempt.phase) continue;
    const key = targetKey(attempt.target);
    const existing = stepAttempts.get(key);
    if (
      !existing ||
      attempt.runIndex < existing.runIndex ||
      (attempt.runIndex === existing.runIndex &&
        attempt.attemptIndex < existing.attemptIndex)
    ) {
      stepAttempts.set(key, attempt);
    }
  }
  const stepTiming = new Map();
  for (const attempt of attempts.values()) {
    const key = targetKey(attempt.target);
    const timing = stepTiming.get(key) ?? {
      startedAt: Infinity,
      completedAt: 0,
      lastAttempt: attempt,
    };
    timing.startedAt = Math.min(timing.startedAt, attempt.startedAt);
    timing.completedAt = Math.max(timing.completedAt, attempt.endedAt);
    if (attempt.lastSequence >= timing.lastAttempt.lastSequence)
      timing.lastAttempt = attempt;
    stepTiming.set(key, timing);
  }

  const buildStep = (key) => {
    const attempt = stepAttempts.get(key);
    const timing = stepTiming.get(key);
    const step =
      attempt?.scriptKind === HISTORY_EVENT_KINDS.SCRIPT
        ? {
            type: STEP_TYPE_SCRIPT,
            script: markTruncated(attempt.prompt ?? MISSING_PROMPT),
          }
        : { prompt: markTruncated(attempt?.prompt ?? MISSING_PROMPT) };
    if (timing) {
      const terminal = timing.lastAttempt.terminalState;
      step._runtime = {
        stepId: randomUUID(),
        startedAt: timing.startedAt,
        completedAt: timing.completedAt,
        terminalStatus:
          terminal === ATTEMPT_TERMINAL_STATES.FAILED
            ? STEP_TERMINAL_STATUSES.FAILED
            : terminal === ATTEMPT_TERMINAL_STATES.STOPPED
              ? STEP_TERMINAL_STATUSES.CANCELLED
              : STEP_TERMINAL_STATUSES.COMPLETED,
        ...(attempt?.metadata?.harness
          ? { harness: attempt.metadata.harness }
          : {}),
        ...(timing.lastAttempt.metadata?.model
          ? { model: timing.lastAttempt.metadata.model }
          : {}),
        ...(timing.lastAttempt.metadata?.sessionId
          ? { sessionId: timing.lastAttempt.metadata.sessionId }
          : {}),
      };
      if (timing.lastAttempt.attemptIndex > 0)
        step._runtime.retryCount = timing.lastAttempt.attemptIndex;
    }
    return step;
  };

  const queueIndexes = [...attempts.values()]
    .filter((attempt) => attempt.target.kind === TARGET_KINDS.QUEUE)
    .map((attempt) => attempt.target.stepIndex);
  const stepCount = queueIndexes.length > 0 ? Math.max(...queueIndexes) + 1 : 0;
  const steps = Array.from({ length: stepCount }, (_, index) =>
    buildStep(`queue:${index}`)
  );
  const hasFinalStep = [...attempts.values()].some(
    (attempt) => attempt.target.kind === TARGET_KINDS.FINAL_STEP
  );
  const finalStep = hasFinalStep ? buildStep("final:0") : undefined;

  const lastTimestamp = Math.max(
    runInfo.startedAt,
    runInfo.lastUpdatedAt ?? 0,
    ...drafts.map((draft) => draft.event.timestampMs)
  );
  if (isTerminal) {
    drafts.push({
      order: Number.MAX_SAFE_INTEGER,
      event: {
        eventType: TIMELINE_EVENT_TYPES.RUN_TERMINATED,
        timestampMs: lastTimestamp,
        payload: { executionState, stepCount },
      },
    });
  }

  drafts.sort((left, right) => left.order - right.order);
  const events = drafts.map((draft, index) => ({
    ...draft.event,
    workflowId: runInfo.workflowKey,
    runId: runInfo.runId,
    sequence: index + 1,
  }));

  return {
    events,
    steps,
    finalStep,
    executionState,
    isTerminal,
    lastTimestamp,
    primaryHarness: [...attempts.values()]
      .map((attempt) => attempt.metadata?.harness)
      .find(Boolean),
    documentCount: documents.length,
    attemptCount: attempts.size,
  };
}

// ---------------------------------------------------------------------------
// File assembly
// ---------------------------------------------------------------------------

function deriveWorkflowNameFromKey(workflowKey) {
  // Mirrors deriveWorkflowNameFromKey(): strip the lineage timestamp suffix.
  return workflowKey.replace(
    /-\d{4}-\d{2}-\d{2}t\d{2}-\d{2}-\d{2}(-\d{3})?$/i,
    ""
  );
}

function buildRunFiles(run, reconstruction) {
  const { workflowName, workflowKey, runId, startedAt } = run;
  const definition = {
    workflowName,
    steps: reconstruction.steps.map(({ _runtime, ...step }) => step),
    ...(reconstruction.finalStep
      ? {
          finalStep: (({ _runtime, ...step }) => step)(
            reconstruction.finalStep
          ),
        }
      : {}),
  };
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    storageKind: "timeline",
    workflowId: workflowKey,
    runId,
    startedAt,
    executionState: reconstruction.executionState,
    definitionRevision: 1,
    initialDefinition: definition,
    stepCount: reconstruction.steps.length,
    eventCount: reconstruction.events.length,
    nextSequence: reconstruction.events.length + 1,
    lastUpdatedAt: reconstruction.lastTimestamp,
    ...(reconstruction.isTerminal
      ? { completedAt: reconstruction.lastTimestamp }
      : {}),
  };
  const workingCopy = {
    schemaVersion: SCHEMA_VERSION,
    startedAt,
    definitionRevision: 1,
    ...(reconstruction.primaryHarness
      ? { harness: reconstruction.primaryHarness }
      : {}),
    steps: reconstruction.steps,
    ...(reconstruction.finalStep
      ? { finalStep: reconstruction.finalStep }
      : {}),
    parallelGroups: [],
    _runtime: {
      schemaVersion: SCHEMA_VERSION,
      currentIndex: reconstruction.steps.length,
      executionState: reconstruction.executionState,
      startTime: startedAt,
      ...(reconstruction.isTerminal
        ? { executionEndTime: reconstruction.lastTimestamp }
        : {}),
    },
  };
  return {
    manifest,
    workingCopy,
    eventsText:
      reconstruction.events.map((event) => JSON.stringify(event)).join("\n") +
      "\n",
  };
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Writes a run into a hidden staging dir, then publishes it with one rename. */
async function writeRun(runsRoot, run, files) {
  const lineageDir = path.join(runsRoot, run.workflowKey);
  const runDir = path.join(lineageDir, run.runRef);
  await fs.mkdir(lineageDir, { recursive: true });
  const stagingDir = path.join(
    lineageDir,
    `.recovering-${run.runRef}-${process.pid}`
  );
  await fs.rm(stagingDir, { recursive: true, force: true });
  await fs.mkdir(stagingDir);
  await writeJson(path.join(stagingDir, RUN_MANIFEST_FILE), files.manifest);
  await fs.writeFile(
    path.join(stagingDir, RUN_EVENTS_FILE),
    files.eventsText,
    "utf8"
  );
  await writeJson(path.join(stagingDir, RUN_WORKING_FILE), files.workingCopy);
  await fs.rename(stagingDir, runDir);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.repairDiffs && options.runsRoot) {
    await repairRecoveredDiffs(path.resolve(options.runsRoot), options.apply);
    return;
  }
  if (options.help || !options.index) {
    process.stdout.write(
      "Usage: node scripts/recover-runs-from-search-index.mjs --index <search-index-copy> [--runs-root <dir>] [--include-orphans] [--only <text>] [--apply]\n" +
        "       node scripts/recover-runs-from-search-index.mjs --repair-diffs --runs-root <dir> [--apply]\n"
    );
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const indexDir = await resolveIndexDir(path.resolve(options.index));
  const indexManifest = JSON.parse(
    await fs.readFile(path.join(indexDir, INDEX_MANIFEST_FILE), "utf8")
  );
  const firstListed = Object.values(indexManifest.indexedRuns ?? {})[0];
  const runsRoot = path.resolve(
    options.runsRoot ??
      (firstListed
        ? path.dirname(path.dirname(path.dirname(firstListed.manifestPath)))
        : "")
  );
  if (!options.runsRoot && !firstListed) {
    throw new Error("The index lists no runs; pass --runs-root explicitly.");
  }

  process.stdout.write(
    `Index:     ${indexDir}\nRuns root: ${runsRoot}\nMode:      ${options.apply ? "APPLY" : "dry run (pass --apply to write)"}\n\n`
  );

  const sources = await selectRunSources(indexDir, indexManifest, options);
  const lineages = new Map();
  const report = { restored: [], skippedExisting: [], failed: [] };
  let truncatedRuns = 0;

  for (const source of sources.sort((left, right) =>
    `${left.workflowKey}/${left.runRef}`.localeCompare(
      `${right.workflowKey}/${right.runRef}`
    )
  )) {
    const runKey = `${source.workflowKey}/${source.runRef}`;
    try {
      const documents = source.shard
        ? await readShard(source.shard.filePath)
        : [];
      const sample = documents[0];
      const run = {
        workflowKey: source.workflowKey,
        runRef: source.runRef,
        runId: sample?.runId ?? source.indexEntry?.runId ?? 1,
        startedAt:
          sample?.startedAt ?? source.indexEntry?.startedAt ?? Date.now(),
        executionState: sample?.executionState ?? EXECUTION_STATES.COMPLETED,
        lastUpdatedAt: source.indexEntry?.lastUpdatedAt,
        workflowName:
          sample?.workflowName || deriveWorkflowNameFromKey(source.workflowKey),
      };
      const reconstruction = reconstructRun(documents, run);
      if (
        documents.some(
          (document) => document.text?.length >= MAX_INDEXED_TEXT_LENGTH
        )
      ) {
        truncatedRuns += 1;
      }
      const lineage = lineages.get(run.workflowKey) ?? {
        workflowKey: run.workflowKey,
        workflowName: run.workflowName,
        runs: [],
      };
      lineage.runs.push({
        ...run,
        lastTimestamp: reconstruction.lastTimestamp,
      });
      lineages.set(run.workflowKey, lineage);

      const runDir = path.join(runsRoot, run.workflowKey, run.runRef);
      if (await pathExists(runDir)) {
        report.skippedExisting.push(runKey);
        continue;
      }
      if (options.apply) {
        await writeRun(runsRoot, run, buildRunFiles(run, reconstruction));
      }
      report.restored.push({
        run: runKey,
        steps: reconstruction.steps.length,
        attempts: reconstruction.attemptCount,
        events: reconstruction.events.length,
        documents: reconstruction.documentCount,
        state: reconstruction.executionState,
        orphan: !source.listed,
      });
    } catch (error) {
      report.failed.push({
        run: runKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // One descriptor per lineage, only where none exists yet.
  let descriptorsWritten = 0;
  for (const lineage of lineages.values()) {
    const descriptorPath = path.join(
      runsRoot,
      lineage.workflowKey,
      DESCRIPTOR_FILE
    );
    if (await pathExists(descriptorPath)) continue;
    const runs = lineage.runs.sort(
      (left, right) => left.startedAt - right.startedAt
    );
    const latest = runs[runs.length - 1];
    const descriptor = {
      schemaVersion: SCHEMA_VERSION,
      workflowKey: lineage.workflowKey,
      workflowName: latest.workflowName,
      isFavorite: false,
      createdAt: runs[0].startedAt,
      lastModifiedAt: Math.max(...runs.map((run) => run.lastTimestamp)),
      nextRunId: Math.max(...runs.map((run) => run.runId)) + 1,
      revision: 1,
      latestRunRef: latest.runRef,
    };
    if (options.apply) {
      await fs.mkdir(path.dirname(descriptorPath), { recursive: true });
      await writeJson(descriptorPath, descriptor);
    }
    descriptorsWritten += 1;
  }

  const reportPath = path.join(
    runsRoot,
    `.recovery-report-${new Date().toISOString().replace(/[:.]/g, "-")}.json`
  );
  if (options.apply) {
    await writeJson(reportPath, {
      indexDir,
      runsRoot,
      createdAt: Date.now(),
      ...report,
    });
  }

  const orphanCount = report.restored.filter((entry) => entry.orphan).length;
  process.stdout.write(
    [
      `Runs ${options.apply ? "restored" : "to restore"}: ${report.restored.length}` +
        (orphanCount ? ` (${orphanCount} from orphan shards)` : ""),
      `Lineage descriptors ${options.apply ? "written" : "to write"}: ${descriptorsWritten}`,
      `Runs skipped (run directory already exists): ${report.skippedExisting.length}`,
      `Runs with at least one text truncated at ${MAX_INDEXED_TEXT_LENGTH} chars: ${truncatedRuns}`,
      `Failures: ${report.failed.length}`,
      ...report.failed
        .slice(0, 20)
        .map((failure) => `  ${failure.run}: ${failure.error}`),
      options.apply ? `Report: ${reportPath}` : "",
      "",
    ].join("\n")
  );
}

main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exitCode = 1;
});
