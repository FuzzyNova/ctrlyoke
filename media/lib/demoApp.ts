import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { git } from "./exec.ts";
import { DEMO_APP_DIR, FIXTURES_DIR, MEDIA_DIR } from "./paths.ts";

interface DemoAppPin {
  repo: string;
  ref: string;
  startTags: Record<string, string>;
}

const WORKFLOW_FIXTURES_DIR = path.join(FIXTURES_DIR, "workflows");
const SETTINGS_FILE = ".ctrlyoke/settings.json";

function readPin(): DemoAppPin {
  return JSON.parse(
    readFileSync(path.join(MEDIA_DIR, "demo-app.json"), "utf8")
  ) as DemoAppPin;
}

/** Clones demo-app into the work folder, or fetches it, and checks the pinned tags exist. */
export function setupDemoApp(): void {
  const pin = readPin();
  if (existsSync(path.join(DEMO_APP_DIR, ".git"))) {
    console.log(`fetching ${pin.repo}...`);
    git(DEMO_APP_DIR, "fetch", "--tags", "--force", "origin");
  } else {
    console.log(`cloning ${pin.repo}...`);
    git(MEDIA_DIR, "clone", pin.repo, DEMO_APP_DIR);
  }
  git(DEMO_APP_DIR, "cat-file", "-e", `${pin.ref}^{commit}`);
  for (const tag of Object.keys(pin.startTags)) {
    git(DEMO_APP_DIR, "rev-parse", "--verify", `refs/tags/${tag}`);
  }
  console.log(`demo-app ready at ${DEMO_APP_DIR}`);
}

/**
 * Resets the demo-app clone to the pinned ref, or to `startTag` for a replay,
 * and installs this capture's workflow fixtures. The clone is a disposable copy
 * owned by the media scripts, so it is reset hard, including ignored runtime
 * state under `.ctrlyoke/`.
 */
export function prepareDemoApp(
  workflowFixtures: readonly string[],
  startTag?: string
): void {
  if (!existsSync(path.join(DEMO_APP_DIR, ".git"))) {
    throw new Error("demo-app is not set up. Run `npm run media -- setup`.");
  }
  const pin = readPin();
  if (startTag && !(startTag in pin.startTags)) {
    throw new Error(`'${startTag}' is not a start tag in demo-app.json`);
  }
  git(DEMO_APP_DIR, "checkout", "--force", "--detach", startTag ?? pin.ref);
  git(DEMO_APP_DIR, "clean", "-fdx", "-e", "node_modules");
  if (startTag) {
    // Start tags predate the committed settings; the server needs them.
    git(DEMO_APP_DIR, "checkout", pin.ref, "--", SETTINGS_FILE);
  }
  serveOnLoopback();
  for (const fixture of workflowFixtures) installWorkflowFixture(fixture);
}

/**
 * Copies a fixtures/workflows/ file into demo-app's .ctrlyoke/workflows/,
 * named `as` there (its own name by default). Works while the host runs: a
 * workflow file is read when it is loaded or opened.
 */
export function installWorkflowFixture(fixture: string, as = fixture): void {
  cpSync(
    path.join(WORKFLOW_FIXTURES_DIR, fixture),
    path.join(DEMO_APP_DIR, ".ctrlyoke", "workflows", as)
  );
}

/**
 * demo-app's committed settings serve HTTPS on every interface for the phone
 * shots. Captures only need plain HTTP on loopback, started with the host.
 */
function serveOnLoopback(): void {
  const settingsPath = path.join(DEMO_APP_DIR, SETTINGS_FILE);
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  settings.server = {
    ...settings.server,
    autoStart: true,
    bindAddress: "127.0.0.1",
    tls: { ...settings.server?.tls, enabled: false },
  };
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}
