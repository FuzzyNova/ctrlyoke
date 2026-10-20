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
  startTag?: string,
  changesFrom?: string
): void {
  if (!existsSync(path.join(DEMO_APP_DIR, ".git"))) {
    throw new Error("demo-app is not set up. Run `npm run media -- setup`.");
  }
  const pin = readPin();
  for (const tag of [startTag, changesFrom]) {
    if (tag && !(tag in pin.startTags)) {
      throw new Error(`'${tag}' is not a start tag in demo-app.json`);
    }
  }
  const start = startTag ?? pin.ref;
  // Undo what a previous capture did to make Source Control presentable:
  // parked tags, and hideSettingsFromGit(), which would block the checkout.
  restoreParkedTags();
  if (git(DEMO_APP_DIR, "ls-files", "--", SETTINGS_FILE)) {
    git(DEMO_APP_DIR, "update-index", "--no-assume-unchanged", SETTINGS_FILE);
  }
  if (changesFrom) {
    // Source Control shows this one: on a branch, as a project would be.
    git(DEMO_APP_DIR, "checkout", "--force", "--no-track", "-B", "main", start);
    // No upstream, or Pull counts origin's newer capture commits as incoming.
    for (const key of ["branch.main.remote", "branch.main.merge"]) {
      try {
        git(DEMO_APP_DIR, "config", "--unset-all", key);
      } catch {
        // Not set.
      }
    }
  } else {
    git(DEMO_APP_DIR, "checkout", "--force", "--detach", start);
  }
  git(DEMO_APP_DIR, "clean", "-fdx", "-e", "node_modules");
  if (startTag) {
    // Start tags predate the committed settings; the server needs them.
    git(DEMO_APP_DIR, "checkout", pin.ref, "--", SETTINGS_FILE);
  }
  if (changesFrom) {
    // The files `changesFrom` changed, as uncommitted edits: what an agent
    // leaves behind for review. Only those paths, so settings stay as above.
    const changed = git(
      DEMO_APP_DIR,
      "diff",
      "--name-only",
      start,
      changesFrom
    ).split("\n");
    git(DEMO_APP_DIR, "checkout", changesFrom, "--", ...changed);
    // `checkout <tree> -- <paths>` stages them; leave them as working-tree changes.
    git(DEMO_APP_DIR, "reset", "--quiet");
    parkTags();
  }
  serveOnLoopback();
  hideSettingsFromGit();
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

/** Where parkTags() keeps the tags; git log doesn't decorate with it. */
const PARKED_TAGS = "refs/media-parked-tags/";

/**
 * Moves every tag out of refs/tags/, so the commit graph doesn't show the
 * capture's start tags as if they were the project's releases.
 */
function parkTags(): void {
  for (const tag of git(DEMO_APP_DIR, "tag", "--list").split("\n")) {
    if (!tag) continue;
    git(DEMO_APP_DIR, "update-ref", `${PARKED_TAGS}${tag}`, `refs/tags/${tag}`);
    git(DEMO_APP_DIR, "update-ref", "-d", `refs/tags/${tag}`);
  }
}

function restoreParkedTags(): void {
  const parked = git(
    DEMO_APP_DIR,
    "for-each-ref",
    "--format=%(refname)",
    PARKED_TAGS
  );
  for (const ref of parked.split("\n")) {
    if (!ref) continue;
    git(
      DEMO_APP_DIR,
      "update-ref",
      `refs/tags/${ref.slice(PARKED_TAGS.length)}`,
      ref
    );
    git(DEMO_APP_DIR, "update-ref", "-d", ref);
  }
}

/**
 * The settings edits above are the capture's, not the project's, so Source
 * Control shots must not list them: a tracked settings file is marked
 * unchanged, an untracked one (at a start tag) excluded.
 */
function hideSettingsFromGit(): void {
  const tracked = git(DEMO_APP_DIR, "ls-files", "--", SETTINGS_FILE) !== "";
  if (tracked) {
    git(DEMO_APP_DIR, "update-index", "--assume-unchanged", SETTINGS_FILE);
    return;
  }
  const exclude = path.join(DEMO_APP_DIR, ".git", "info", "exclude");
  const lines = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  if (!lines.split(/\r?\n/).includes(`/${SETTINGS_FILE}`)) {
    writeFileSync(exclude, `${lines.trimEnd()}\n/${SETTINGS_FILE}\n`);
  }
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
