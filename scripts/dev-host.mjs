#!/usr/bin/env node
/**
 * Launch/close a CLI-driven Extension Development Host for headless dev loops.
 *
 * Mirrors .vscode/launch.json's "Run Extension (Debug)" config, but adds an
 * isolated --user-data-dir so the host is a fully independent, closable
 * process tree instead of just another window inside a running VS Code
 * instance (which shares that instance's process and can't be safely killed
 * on its own). See dev/reference/DEVELOPING_CTRLYOKE_WITH_CTRLYOKE.md for the
 * full writeup and why this exists.
 *
 * Cross-platform (win32/darwin/linux). The graceful-close mechanism differs
 * per OS: taskkill (no /F) on Windows, SIGTERM elsewhere — see the doc above
 * for which of those is empirically confirmed vs. the standard-idiom default.
 *
 * Usage:
 *   node scripts/dev-host.mjs start
 *   node scripts/dev-host.mjs stop
 *   node scripts/dev-host.mjs restart   (stop, npm run compile, start)
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const USER_DATA_DIR = path.join(REPO_ROOT, ".vscode-dev-userdata");
const CTRLYOKE_HOME = path.join(REPO_ROOT, ".ctrlyoke-dev-home");
const WORKSPACE = path.join(REPO_ROOT, "ctrlyoke-test.code-workspace");
const SERVER_URL_FILE = path.join(
  REPO_ROOT,
  ".ctrlyoke",
  "dev",
  "server-url.txt"
);
const USER_DATA_MARKER = ".vscode-dev-userdata";

const IS_WINDOWS = process.platform === "win32";
const CODE_BIN = IS_WINDOWS ? "code.cmd" : "code";
const NPM_BIN = IS_WINDOWS ? "npm.cmd" : "npm";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findInstancePidsWin() {
  const script = `(Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape('${USER_DATA_MARKER}') }).ProcessId`;
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" }
  ).trim();
  return out ? out.split(/\s+/).map(Number) : [];
}

function findTopLevelPidWin() {
  const script = `(Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -match [regex]::Escape('${USER_DATA_MARKER}') -and $_.CommandLine -notmatch '--type=' }).ProcessId`;
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" }
  ).trim();
  return out ? Number(out.split(/\s+/)[0]) : null;
}

function listProcessesPosix() {
  // -ww disables the line-width truncation both BSD (macOS) and GNU (Linux)
  // ps otherwise apply to `args`, which would silently cut off our marker.
  const out = execFileSync("ps", ["-eo", "pid,ppid,args", "-ww"], {
    encoding: "utf8",
  });
  return out
    .split("\n")
    .slice(1)
    .map((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!match) return null;
      return { pid: Number(match[1]), args: match[3] };
    })
    .filter(Boolean);
}

function findInstancePidsPosix() {
  return listProcessesPosix()
    .filter((p) => p.args.includes(USER_DATA_MARKER))
    .map((p) => p.pid);
}

function findTopLevelPidPosix() {
  const found = listProcessesPosix().find(
    (p) => p.args.includes(USER_DATA_MARKER) && !p.args.includes("--type=")
  );
  return found ? found.pid : null;
}

function findInstancePids() {
  return IS_WINDOWS ? findInstancePidsWin() : findInstancePidsPosix();
}

function findTopLevelPid() {
  return IS_WINDOWS ? findTopLevelPidWin() : findTopLevelPidPosix();
}

function requestGracefulClose(pid) {
  if (IS_WINDOWS) {
    // No /F: this is the WM_CLOSE-equivalent graceful close, same as
    // clicking the window's X — empirically confirmed (session log shows a
    // normal "Extension deactivating..." line, not a crash).
    execFileSync("taskkill", ["/PID", String(pid)]);
    return;
  }
  // SIGTERM is the standard-idiom graceful-quit request on macOS/Linux;
  // Electron apps generally hook it to run their normal quit sequence, but
  // unlike the Windows path above this hasn't been empirically verified in
  // this repo — confirm once on your machine that the session log shows a
  // clean "Extension deactivating..." line rather than an abrupt exit.
  process.kill(pid, "SIGTERM");
}

async function stop() {
  const topPid = findTopLevelPid();
  if (!topPid) {
    console.log("dev host not running.");
    return;
  }

  console.log(`closing dev host (PID ${topPid})...`);
  try {
    requestGracefulClose(topPid);
  } catch (err) {
    console.warn(`graceful close request failed (continuing): ${err.message}`);
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (findInstancePids().length === 0) {
      console.log("dev host closed.");
      return;
    }
    await sleep(1000);
  }

  const killCmd = IS_WINDOWS
    ? `taskkill /PID ${topPid} /F`
    : `kill -9 ${topPid}`;
  console.error(
    `dev host did not close within 30s; check for a stuck dialog in the window, or '${killCmd}' as a last resort.`
  );
  process.exitCode = 1;
}

function compile() {
  console.log("npm run compile...");
  execFileSync(NPM_BIN, ["run", "compile"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    shell: IS_WINDOWS,
  });
}

async function start() {
  if (findInstancePids().length > 0) {
    console.error(
      "dev host already running — run `node scripts/dev-host.mjs stop` first."
    );
    process.exitCode = 1;
    return;
  }

  const beforeMtime = existsSync(SERVER_URL_FILE)
    ? statSync(SERVER_URL_FILE).mtimeMs
    : 0;

  console.log("launching dev host...");
  const child = spawn(
    CODE_BIN,
    [
      `--user-data-dir=${USER_DATA_DIR}`,
      `--extensionDevelopmentPath=${REPO_ROOT}`,
      "--disable-extension=fuzzynova.ctrlyoke",
      WORKSPACE,
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, CTRLYOKE_HOME },
      detached: true,
      stdio: "ignore",
      shell: IS_WINDOWS,
    }
  );
  child.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      existsSync(SERVER_URL_FILE) &&
      statSync(SERVER_URL_FILE).mtimeMs > beforeMtime
    ) {
      console.log(readFileSync(SERVER_URL_FILE, "utf8").trim());
      return;
    }
    await sleep(500);
  }

  console.error(
    "timed out waiting for the dev host's hosted server URL — check .ctrlyoke/logs/ for the newest session log."
  );
  process.exitCode = 1;
}

async function main() {
  const command = process.argv[2];
  switch (command) {
    case "start":
      await start();
      break;
    case "stop":
      await stop();
      break;
    case "restart":
      await stop();
      compile();
      await start();
      break;
    default:
      console.error("usage: node scripts/dev-host.mjs <start|stop|restart>");
      process.exit(1);
  }
}

await main();
