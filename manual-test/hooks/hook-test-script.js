"use strict";
/**
 * Manual hook recorder script for testing FlightPath hook delivery.
 *
 * Usage (in a workflow hooks array):
 *   command: node manual-test/hooks/hook-test-script.js <event>
 *
 * Example workflow snippet:
 *   hooks:
 *     - event: stop
 *       command: node manual-test/hooks/hook-test-script.js stop
 *     - event: sessionStart
 *       command: node manual-test/hooks/hook-test-script.js sessionStart
 *     - event: preToolUse
 *       command: node manual-test/hooks/hook-test-script.js preToolUse
 *     - event: postToolUse
 *       command: node manual-test/hooks/hook-test-script.js postToolUse
 *     - event: userPromptSubmit
 *       command: node manual-test/hooks/hook-test-script.js userPromptSubmit
 *
 * Output:
 *   Appends one JSON line per invocation to manual-test/hooks/output/hooks.jsonl
 *   Also writes a per-invocation file to manual-test/hooks/output/<event>-<timestamp>.json
 */

const fs = require("fs");
const path = require("path");

const event = process.argv[2] || "unknown";
const outputDir = path.join(__dirname, "output");

// Collect any stdin data (some hooks pipe context as JSON)
let stdinData = "";
if (!process.stdin.isTTY) {
  try {
    stdinData = fs.readFileSync("/dev/stdin", "utf8");
  } catch {
    // stdin not available or not readable — ignore
  }
}

const entry = {
  event,
  ts: Date.now(),
  time: new Date().toISOString(),
  pid: process.pid,
  ...(stdinData.trim() ? { stdin: tryParseJson(stdinData) } : {}),
};

// Ensure output directory exists
fs.mkdirSync(outputDir, { recursive: true });

// Append to the rolling JSONL log
const jsonlPath = path.join(outputDir, "hooks.jsonl");
fs.appendFileSync(jsonlPath, JSON.stringify(entry) + "\n");

// Write a per-invocation file for easy inspection
const perEventPath = path.join(outputDir, `${event}-${Date.now()}.json`);
fs.writeFileSync(perEventPath, JSON.stringify(entry, null, 2) + "\n");

// Print to stdout so the hook's output is visible in CLI output
process.stdout.write(`[hook] ${entry.time}  event=${event}\n`);

function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return str.trim();
  }
}
