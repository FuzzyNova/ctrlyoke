import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEMO_APP_DIR, FIXTURES_DIR, HOME_DIR } from "./paths.ts";

/**
 * A run history the capture host starts with, so the workflow list and history
 * search show months of real runs rather than an empty dashboard. It is a copy
 * of demo-app's user-scoped history (`~/.ctrlyoke/projects/demo-app-*\/.runs`)
 * with the workspace root and the user's home turned into tokens, put back
 * under the capture host's home for the clone in .work/demo-app.
 *
 * Several lineages exist only for these shots: the favorited script-only
 * workflows were run many times, at no token cost, so their rows carry run
 * counts.
 */
export const HISTORY_DIR = path.join(FIXTURES_DIR, "history", "demo-app");
const RUNS_DIR = ".runs";

/** Not `${workspaceFolder}`, which workflows may contain themselves. */
const WORKSPACE_TOKEN = "@@MEDIA_WORKSPACE@@";
const HOME_TOKEN = "@@MEDIA_HOME@@";
/** Replaces the user name wherever it survives outside a path (a mangled temp path, say). */
const USER_PLACEHOLDER = "user";

/**
 * A path as it appears in run files: any drive-letter case, and each separator
 * as `/` or one to four backslashes (raw, JSON-escaped, or escaped twice).
 */
function pathPattern(absolute: string): RegExp {
  const segments = path
    .resolve(absolute)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(segments.join("(?:\\\\{1,4}|/)"), "gi");
}

/** Every text file under `dir`, recursively. Run history holds only JSON and JSONL. */
function textFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => path.join(dir, entry))
    .filter(
      (file) => statSync(file).isFile() && /\.jsonl?$/.test(path.basename(file))
    );
}

function rewrite(dir: string, transform: (text: string) => string): void {
  for (const file of textFiles(dir)) {
    const text = readFileSync(file, "utf8");
    const next = transform(text);
    if (next !== text) writeFileSync(file, next);
  }
}

/** demo-app's project folder in the user-scoped state home, by the path it was opened at. */
function findSourceProject(source?: string): string {
  if (source) return path.resolve(source);
  const projects = path.join(os.homedir(), ".ctrlyoke", "projects");
  const candidates = readdirSync(projects).filter((name) =>
    /^demo-app-[0-9a-f]{12}$/.test(name)
  );
  if (candidates.length !== 1) {
    throw new Error(
      `found ${candidates.length} demo-app projects in ${projects}; pass the one to copy`
    );
  }
  return path.join(projects, candidates[0]);
}

/**
 * Replaces fixtures/history/ with demo-app's current run history from this
 * machine, tokenized. Review the diff before committing it: it is the full
 * transcript of every run.
 */
export function snapshotHistory(source?: string): void {
  const project = findSourceProject(source);
  const { statePath } = JSON.parse(
    readFileSync(path.join(project, "project.json"), "utf8")
  ) as { statePath: string };
  const target = path.join(HISTORY_DIR, RUNS_DIR);
  rmSync(HISTORY_DIR, { recursive: true, force: true });
  cpSync(path.join(project, RUNS_DIR), target, { recursive: true });

  const workspace = pathPattern(statePath);
  const home = pathPattern(os.homedir());
  const userName = os.userInfo().username;
  let userNames = 0;
  rewrite(target, (text) =>
    text
      .replace(workspace, WORKSPACE_TOKEN)
      .replace(home, HOME_TOKEN)
      .replaceAll(userName, () => {
        userNames++;
        return USER_PLACEHOLDER;
      })
  );
  console.log(
    `copied ${path.join(project, RUNS_DIR)} to ${target}; ` +
      `${userNames} stray user names replaced`
  );
}

/** Mirrors `projectKey` in src/utils/ProjectStatePaths.ts (slug plus path hash). */
function projectKey(stateRoot: string): string {
  const resolved = path.resolve(stateRoot);
  const slug =
    path
      .basename(resolved)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\x00-\x7F]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/g, "") || "project";
  const folded =
    process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const hash = createHash("sha256").update(folded).digest("hex");
  return `${slug}-${hash.slice(0, 12)}`;
}

export interface HistoryOptions {
  /**
   * Leaves out workflows whose name matches, e.g. the docs-* workflows made
   * for documentation captures, whose names read as internal on the landing
   * page.
   */
  exclude?: RegExp;
}

/** The workflow name a lineage folder records in its workflow.json. */
function lineageName(lineage: string): string {
  const descriptor = path.join(lineage, "workflow.json");
  return existsSync(descriptor)
    ? (JSON.parse(readFileSync(descriptor, "utf8")).workflowName ?? "")
    : "";
}

/**
 * Installs the history fixture as the capture home's history for the
 * demo-app clone. Runs after the home is reset and before the host starts.
 */
export function seedHistory({ exclude }: HistoryOptions = {}): void {
  if (!existsSync(path.join(HISTORY_DIR, RUNS_DIR))) {
    throw new Error(
      `no history fixture at ${HISTORY_DIR}. Run \`npm run media -- snapshot-history\`.`
    );
  }
  const project = path.join(
    HOME_DIR,
    ".ctrlyoke",
    "projects",
    projectKey(DEMO_APP_DIR)
  );
  mkdirSync(project, { recursive: true });
  const source = path.join(HISTORY_DIR, RUNS_DIR);
  for (const lineage of readdirSync(source)) {
    const from = path.join(source, lineage);
    if (exclude?.test(lineageName(from))) continue;
    cpSync(from, path.join(project, RUNS_DIR, lineage), { recursive: true });
  }
  // Forward slashes need no escaping in JSON and work on every platform.
  const workspace = DEMO_APP_DIR.replaceAll("\\", "/");
  const home = HOME_DIR.replaceAll("\\", "/");
  rewrite(path.join(project, RUNS_DIR), (text) =>
    text.replaceAll(WORKSPACE_TOKEN, workspace).replaceAll(HOME_TOKEN, home)
  );
  const now = new Date().toISOString();
  writeFileSync(
    path.join(project, "project.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        statePath: DEMO_APP_DIR,
        gitToplevel: DEMO_APP_DIR,
        createdAt: now,
        lastOpenedAt: now,
      },
      null,
      2
    )}\n`
  );
}
