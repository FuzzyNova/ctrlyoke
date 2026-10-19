import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { run } from "./exec.ts";
import {
  DEMO_APP_DIR,
  FIXTURES_DIR,
  HOME_DIR,
  REPO_ROOT,
  VSCODE_USER_DATA_DIR,
} from "./paths.ts";
import { DEFAULT_THEME, THEMES, type ThemeName } from "./themes.ts";

export interface HostOptions {
  /** Hide every harness CLI from the host's PATH (dev-host `--no-harnesses`). */
  noHarnesses?: boolean;
  /** Replay a recorded run instead of calling harnesses (src/dev/replay/). */
  replay?: ReplayOptions;
  /** Extra environment variables for the host, e.g. a dummy secret value. */
  env?: Record<string, string>;
}

export interface ReplayOptions {
  /** Absolute path of the run bundle. */
  bundleDir: string;
  /** Playback speed; 0 jumps each step to its end state. Defaults to 1. */
  speed?: number;
  /** Play any recorded idle gap longer than this many ms as this, before `speed`. */
  maxGapMs?: number;
  /** Pause playback indefinitely before this event sequence number. */
  pauseAt?: number;
}

/** Keep in sync with RUN_REPLAY_ENV in src/dev/replay/RunReplay.ts. */
function replayEnvironment(replay: ReplayOptions): Record<string, string> {
  const environment: Record<string, string> = {
    CTRLYOKE_DEV_REPLAY: path.resolve(replay.bundleDir),
  };
  if (replay.speed !== undefined) {
    environment.CTRLYOKE_DEV_REPLAY_SPEED = String(replay.speed);
  }
  if (replay.maxGapMs !== undefined) {
    environment.CTRLYOKE_DEV_REPLAY_MAX_GAP_MS = String(replay.maxGapMs);
  }
  if (replay.pauseAt !== undefined) {
    environment.CTRLYOKE_DEV_REPLAY_PAUSE_AT = String(replay.pauseAt);
  }
  return environment;
}

const DEV_HOST_SCRIPT = path.join(REPO_ROOT, "scripts", "dev-host.mjs");
const SERVER_URL_FILE = path.join(
  DEMO_APP_DIR,
  ".ctrlyoke",
  "dev",
  "server-url.txt"
);
const VSCODE_USER_SETTINGS_FILE = path.join(
  VSCODE_USER_DATA_DIR,
  "User",
  "settings.json"
);
const THEME_SWITCH_TIMEOUT_MS = 30_000;

/**
 * VS Code user settings for the capture host. Keeps first-run prompts,
 * restricted mode and the AI sign-in overlay out of the way of the extension.
 */
const VSCODE_USER_SETTINGS = {
  "chat.disableAIFeatures": true,
  "extensions.ignoreRecommendations": true,
  "security.workspace.trust.enabled": false,
  "telemetry.telemetryLevel": "off",
  "update.mode": "none",
  "window.restoreWindows": "none",
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
};

/** VS Code applies an edited user settings file live, theme included. */
function writeVsCodeUserSettings(theme: ThemeName): void {
  mkdirSync(path.dirname(VSCODE_USER_SETTINGS_FILE), { recursive: true });
  const settings = {
    ...VSCODE_USER_SETTINGS,
    "workbench.colorTheme": THEMES[theme].id,
  };
  writeFileSync(
    VSCODE_USER_SETTINGS_FILE,
    `${JSON.stringify(settings, null, 2)}\n`
  );
}

/**
 * Recreates the host's VS Code state and user home from scratch, so every
 * capture starts from product defaults with no run history, whoever runs it.
 * fixtures/home/ seeds the home (e.g. the user MCP server the MCP tab shows).
 */
function resetHostState(): void {
  rmSync(VSCODE_USER_DATA_DIR, { recursive: true, force: true });
  rmSync(HOME_DIR, { recursive: true, force: true });
  cpSync(path.join(FIXTURES_DIR, "home"), HOME_DIR, { recursive: true });
  writeVsCodeUserSettings(DEFAULT_THEME);
}

/**
 * Starts the `media` dev host on the prepared demo-app clone and returns the
 * hosted dashboard URL. Compiles first (dev-host does), so the capture always
 * shows the current source.
 */
export async function startHost(options: HostOptions = {}): Promise<string> {
  resetHostState();
  const args = [DEV_HOST_SCRIPT, "start", "media"];
  if (options.noHarnesses) args.push("--no-harnesses");
  run(process.execPath, args, REPO_ROOT, {
    ...options.env,
    ...(options.replay ? replayEnvironment(options.replay) : {}),
  });
  if (!existsSync(SERVER_URL_FILE)) {
    throw new Error(`dev host started but ${SERVER_URL_FILE} is missing`);
  }
  const url = readFileSync(SERVER_URL_FILE, "utf8").trim();
  await waitForTheme(url, DEFAULT_THEME);
  return url;
}

/**
 * Switches the host's VS Code theme and waits until the hosted dashboard
 * serves it. The ctrlyoke panel captures VS Code's theme colors and the server
 * renders them, with the theme kind as the <body> class, into every page.
 */
export async function setTheme(url: string, theme: ThemeName): Promise<void> {
  writeVsCodeUserSettings(theme);
  await waitForTheme(url, theme);
}

async function waitForTheme(url: string, theme: ThemeName): Promise<void> {
  const expected = `<body class="${THEMES[theme].bodyClass}"`;
  const deadline = Date.now() + THEME_SWITCH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const html = await (await fetch(url)).text();
    if (html.includes(expected)) return;
    await sleep(250);
  }
  throw new Error(
    `the hosted dashboard never switched to the ${THEMES[theme].id} theme`
  );
}

export function stopHost(): void {
  run(process.execPath, [DEV_HOST_SCRIPT, "stop"], REPO_ROOT);
}
