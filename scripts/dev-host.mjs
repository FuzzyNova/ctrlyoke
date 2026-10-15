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
 *   node scripts/dev-host.mjs start [isolated|shared|onboarding]
 *   node scripts/dev-host.mjs stop
 *   node scripts/dev-host.mjs restart [isolated|shared|onboarding]
 *
 * The default `isolated` mode preserves the original behavior. `shared` omits
 * CTRLYOKE_HOME so ctrlyoke uses the normal user-scoped directory. `onboarding`
 * mirrors .vscode/launch.json's isolated onboarding config: it resets the temp
 * workspace, uses independent VS Code and ctrlyoke state, and disables all
 * extensions.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnShim, spawnShimSync } from "./spawn-windows-shim.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const USER_DATA_DIR = path.join(REPO_ROOT, ".vscode-dev-userdata");
const CTRLYOKE_HOME = path.join(REPO_ROOT, ".ctrlyoke-dev-home");
const WORKSPACE_FILE = path.join(REPO_ROOT, "ctrlyoke-test.code-workspace");
const ONBOARDING_TEMP_DIR = path.join(REPO_ROOT, ".vscode-dev-tempdir");
const ONBOARDING_WORKSPACE = path.join(ONBOARDING_TEMP_DIR, "workspace");
const ONBOARDING_USER_DATA_DIR = path.join(ONBOARDING_TEMP_DIR, "userdata");
const ONBOARDING_CTRLYOKE_HOME = path.join(
  ONBOARDING_TEMP_DIR,
  "ctrlyoke-home"
);
const DEV_SERVER_URL_RELATIVE_PATH = path.join(
  ".ctrlyoke",
  "dev",
  "server-url.txt"
);

const MODES = {
  isolated: {
    ctrlyokeHome: CTRLYOKE_HOME,
    disableExtensions: false,
    name: "isolated",
    resetTempDir: false,
    userDataDir: USER_DATA_DIR,
    workspace: WORKSPACE_FILE,
    workspaceRoot: REPO_ROOT,
  },
  shared: {
    ctrlyokeHome: undefined,
    disableExtensions: false,
    name: "shared",
    resetTempDir: false,
    userDataDir: USER_DATA_DIR,
    workspace: WORKSPACE_FILE,
    workspaceRoot: REPO_ROOT,
  },
  onboarding: {
    ctrlyokeHome: ONBOARDING_CTRLYOKE_HOME,
    disableExtensions: true,
    name: "onboarding",
    resetTempDir: true,
    userDataDir: ONBOARDING_USER_DATA_DIR,
    workspace: ONBOARDING_WORKSPACE,
    workspaceRoot: ONBOARDING_WORKSPACE,
  },
};

const MODE_ALIASES = {
  "debug-isolated": "onboarding",
  "fully-isolated": "onboarding",
};

const USER_DATA_MARKERS = [
  path.relative(REPO_ROOT, USER_DATA_DIR),
  path.relative(REPO_ROOT, ONBOARDING_USER_DATA_DIR),
];

const IS_WINDOWS = process.platform === "win32";
const CODE_BIN = IS_WINDOWS ? "code.cmd" : "code";
const NPM_BIN = IS_WINDOWS ? "npm.cmd" : "npm";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findInstancePidsWin() {
  const script = `(Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { ${USER_DATA_MARKERS.map(
    (marker) => `$_.CommandLine -match [regex]::Escape('${marker}')`
  ).join(" -or ")} }).ProcessId`;
  const out = execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" }
  ).trim();
  return out ? out.split(/\s+/).map(Number) : [];
}

function findTopLevelPidWin() {
  const markerExpression = USER_DATA_MARKERS.map(
    (marker) => `$_.CommandLine -match [regex]::Escape('${marker}')`
  ).join(" -or ");
  const script = `(Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { (${markerExpression}) -and $_.CommandLine -notmatch '--type=' }).ProcessId`;
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
    .filter((p) => USER_DATA_MARKERS.some((marker) => p.args.includes(marker)))
    .map((p) => p.pid);
}

function findTopLevelPidPosix() {
  const found = listProcessesPosix().find(
    (p) =>
      USER_DATA_MARKERS.some((marker) => p.args.includes(marker)) &&
      !p.args.includes("--type=")
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
  const result = spawnShimSync(NPM_BIN, ["run", "compile"], {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function getMode(rawMode) {
  const normalizedMode = rawMode?.replace(/^--mode=/, "").replace(/^--/, "");
  const modeName = normalizedMode
    ? (MODE_ALIASES[normalizedMode] ?? normalizedMode)
    : "isolated";
  if (Object.hasOwn(MODES, modeName)) return MODES[modeName];

  console.error(
    `unknown dev host mode '${rawMode}'. Choose isolated, shared, or onboarding.`
  );
  process.exit(1);
}

function resetOnboardingTempDir() {
  console.log("resetting onboarding temp directory...");
  execFileSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "reset-dev-tempdir.mjs")],
    { cwd: REPO_ROOT, stdio: "inherit" }
  );
}

function buildEnvironment(mode) {
  const environment = { ...process.env };
  if (mode.ctrlyokeHome) {
    environment.CTRLYOKE_HOME = mode.ctrlyokeHome;
  } else {
    delete environment.CTRLYOKE_HOME;
  }
  return environment;
}

async function start(mode) {
  if (findInstancePids().length > 0) {
    console.error(
      "dev host already running — run `node scripts/dev-host.mjs stop` first."
    );
    process.exitCode = 1;
    return;
  }

  if (mode.resetTempDir) resetOnboardingTempDir();

  compile();

  const serverUrlFile = path.join(
    mode.workspaceRoot,
    DEV_SERVER_URL_RELATIVE_PATH
  );
  const beforeMtime = existsSync(serverUrlFile)
    ? statSync(serverUrlFile).mtimeMs
    : 0;

  console.log(`launching dev host (${mode.name})...`);
  const args = [
    `--user-data-dir=${mode.userDataDir}`,
    `--extensionDevelopmentPath=${REPO_ROOT}`,
    "--disable-extension=fuzzynova.ctrlyoke",
    // Built-in GitHub auth session/token state is stored via the OS keychain
    // under a service name that is NOT scoped per --user-data-dir, so a
    // second instance sharing that keychain entry can race the daily
    // driver's session and sign both out. ctrlyoke never calls
    // vscode.authentication itself, so it's safe to disable outright here.
    "--disable-extension=vscode.github-authentication",
  ];
  if (mode.disableExtensions) args.unshift("--disable-extensions");
  args.push(mode.workspace);

  const child = spawnShim(CODE_BIN, args, {
    cwd: REPO_ROOT,
    env: buildEnvironment(mode),
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (
      existsSync(serverUrlFile) &&
      statSync(serverUrlFile).mtimeMs > beforeMtime
    ) {
      console.log(readFileSync(serverUrlFile, "utf8").trim());
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
  const mode = getMode(process.argv[3]);
  switch (command) {
    case "start":
      await start(mode);
      break;
    case "stop":
      await stop();
      break;
    case "restart":
      await stop();
      await start(mode);
      break;
    default:
      console.error(
        "usage: node scripts/dev-host.mjs <start|stop|restart> [isolated|shared|onboarding]"
      );
      process.exit(1);
  }
}

await main();
