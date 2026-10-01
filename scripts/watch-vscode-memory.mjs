#!/usr/bin/env node
/**
 * Watch the real memory of every VS Code (Code.exe) process from the OS side,
 * for diagnosing renderer / extension-host OOM crashes.
 *
 * In-process measurements cannot see this: the extension host's
 * MemoryWatchdog only measures its own heap, and a webview's
 * `performance.memory` is coarse. A window's renderer can run out of memory
 * while both look fine, so this samples each process's private bytes from
 * Windows instead and appends one line per large process per sample to
 * `.ctrlyoke/logs/vscode-process-memory-<timestamp>.log` (and stdout), with
 * the process role taken from its Chromium command line (renderer, extension
 * host, GPU, ...). Compare its timestamps with the ctrlyoke session log.
 *
 * Usage: node scripts/watch-vscode-memory.mjs [--interval-ms 5000] [--min-mb 150]
 * Windows only. Stop with Ctrl+C.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? Number(process.argv[index + 1]) : fallback;
}

const intervalMs = readArg("--interval-ms", 5_000);
const minMb = readArg("--min-mb", 150);

if (process.platform !== "win32") {
  console.error("watch-vscode-memory only supports Windows.");
  process.exit(1);
}

const logDir = path.join(REPO_ROOT, ".ctrlyoke", "logs");
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(
  logDir,
  `vscode-process-memory-${new Date().toISOString().replace(/[:.]/g, "-")}.log`
);

const QUERY =
  "Get-CimInstance Win32_Process -Filter \"Name='Code.exe'\" | " +
  "Select-Object ProcessId,ParentProcessId,PrivatePageCount,WorkingSetSize,CommandLine | " +
  "ConvertTo-Json -Compress";

/**
 * Role of one Code.exe process from its Chromium command line. The Node
 * utility processes (extension host, pty host, shared services) have identical
 * command lines, so the extension host is recognized by its children: the
 * language servers and other extension processes it spawns run Code.exe as
 * Node (no `--type`) on a script under an `extensions` directory.
 */
function describeRole(proc, byPid, childrenByParent) {
  const commandLine = proc.CommandLine ?? "";
  const type = /--type=([\w-]+)/.exec(commandLine)?.[1];
  if (!type) {
    if (!byPid.has(proc.ParentProcessId)) return "main";
    const script = /\s"?([^"\s]+\.(?:c|m)?js)"?/.exec(commandLine)?.[1];
    return `node-child:${script ? path.basename(script) : "?"}`;
  }
  if (type !== "utility") return type;
  const subType = /--utility-sub-type=([\w.]+)/.exec(commandLine)?.[1] ?? "";
  if (!subType.includes("NodeService")) {
    return `utility:${subType.split(".").pop() || "?"}`;
  }
  const spawnsExtensions = (childrenByParent.get(proc.ProcessId) ?? []).some(
    (child) => /[\\/]extensions[\\/]/i.test(child.CommandLine ?? "")
  );
  return spawnsExtensions ? "extension-host" : "node-service";
}

function profileTag(commandLine) {
  const userDataDir = /--user-data-dir=("[^"]+"|\S+)/.exec(commandLine)?.[1];
  return userDataDir
    ? path.basename(userDataDir.replace(/"/g, ""))
    : "default-profile";
}

function sample() {
  let processes;
  try {
    const json = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", QUERY],
      { encoding: "utf8", windowsHide: true }
    );
    processes = json.trim() ? JSON.parse(json) : [];
    if (!Array.isArray(processes)) processes = [processes];
  } catch (error) {
    console.error(`sample failed: ${error.message}`);
    return;
  }

  const at = new Date().toISOString();
  const byPid = new Map(processes.map((proc) => [proc.ProcessId, proc]));
  const childrenByParent = new Map();
  for (const proc of processes) {
    const siblings = childrenByParent.get(proc.ParentProcessId) ?? [];
    siblings.push(proc);
    childrenByParent.set(proc.ParentProcessId, siblings);
  }
  const lines = processes
    .map((proc) => ({
      pid: proc.ProcessId,
      parent: proc.ParentProcessId,
      privateMb: Math.round((Number(proc.PrivatePageCount) || 0) / 1048576),
      workingSetMb: Math.round((Number(proc.WorkingSetSize) || 0) / 1048576),
      role: describeRole(proc, byPid, childrenByParent),
      profile: profileTag(proc.CommandLine ?? ""),
    }))
    .filter((proc) => proc.privateMb >= minMb)
    .sort((a, b) => b.privateMb - a.privateMb)
    .map(
      (proc) =>
        `[${at}] pid=${proc.pid} parent=${proc.parent} role=${proc.role} profile=${proc.profile} privateMB=${proc.privateMb} workingSetMB=${proc.workingSetMb}`
    );
  if (lines.length === 0) return;
  const text = lines.join("\n") + "\n";
  process.stdout.write(text);
  fs.appendFileSync(logPath, text);
}

console.log(
  `Sampling Code.exe processes >= ${minMb} MB every ${intervalMs} ms -> ${logPath}`
);
sample();
setInterval(sample, intervalMs);
