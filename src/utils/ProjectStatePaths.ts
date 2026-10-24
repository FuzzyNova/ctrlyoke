import * as os from "node:os";
import * as path from "node:path";
import { hashPathForCompare, pathsEqual } from "./PathCasing";
import type { RunHistoryLocation } from "../types/CtrlYokeSettings";

const CTRLYOKE_DIR = ".ctrlyoke";
const PROJECTS_DIR = "projects";
const NO_WORKSPACE_DIR = "no-workspace";
const PROJECT_SLUG_MAX_LENGTH = 48;
const HASH_LENGTH = 12;
const USER_LOCATION: RunHistoryLocation = "user";
const WORKSPACE_LOCATION: RunHistoryLocation = "workspace";

/**
 * Resolve the state home used by the user-scoped project state introduced by
 * the run-history storage plan. The override is intentionally separate from
 * the existing settings/agent home resolution.
 */
export function ctrlyokeStateHome(): string {
  const override = process.env.CTRLYOKE_HOME;
  return override
    ? path.resolve(override)
    : path.join(os.homedir(), CTRLYOKE_DIR);
}

/**
 * `projectKey` is pure in its resolved input, and every run-history path
 * (`runsRoot`, `lineageDir`, `runDir`, …) recomputes it, so listing history
 * hashed the same root once per entry. A process sees a handful of roots, so
 * the cap only guards against unbounded growth.
 */
const PROJECT_KEY_CACHE_LIMIT = 64;
const projectKeyCache = new Map<string, string>();

/**
 * Build the stable, readable directory key for a resolved ctrlyoke state root.
 * The hash is based on PathCasing's platform-aware comparison form so Windows
 * drive-letter and path casing differences do not create separate projects.
 */
export function projectKey(stateRoot: string): string {
  const resolvedStateRoot = path.resolve(stateRoot);
  const cached = projectKeyCache.get(resolvedStateRoot);
  if (cached !== undefined) {
    return cached;
  }

  const slug = sanitizeProjectSlug(path.basename(resolvedStateRoot));
  const hash = hashPathForCompare(resolvedStateRoot).slice(0, HASH_LENGTH);
  const key = `${slug}-${hash}`;
  if (projectKeyCache.size >= PROJECT_KEY_CACHE_LIMIT) {
    projectKeyCache.clear();
  }
  projectKeyCache.set(resolvedStateRoot, key);
  return key;
}

/** Resolve the root directory for a project's selected run-history location. */
export function projectStateRoot(
  stateRoot: string,
  location: RunHistoryLocation
): string {
  if (location === WORKSPACE_LOCATION) {
    return path.join(stateRoot, CTRLYOKE_DIR);
  }

  if (location === USER_LOCATION) {
    return path.join(ctrlyokeStateHome(), PROJECTS_DIR, projectKey(stateRoot));
  }

  throw new Error(`Unsupported run history location: ${String(location)}`);
}

/**
 * Inert root for a workflow instance whose host has no workspace (a VS Code
 * window with no folder open). Such an instance refuses to run or create a
 * working file, but its in-memory collaborators still need a path. Any write
 * that slips past those guards lands in the user's state home rather than the
 * process cwd, which for VS Code is the editor's install directory.
 */
export function noWorkspacePlaceholderRoot(): string {
  return path.join(ctrlyokeStateHome(), NO_WORKSPACE_DIR);
}

/** Resolve the user-scoped project registry root without consulting frozen policy. */
export function userProjectsRoot(): string {
  return path.join(ctrlyokeStateHome(), PROJECTS_DIR);
}

/**
 * The user-scoped project directory for an already-selected project state
 * root, whichever location that root uses: a user-mode root is returned as
 * is, and a workspace-mode `<stateRoot>/.ctrlyoke` maps to the user-mode
 * directory the same project would have. Lets state that must stay out of
 * every harness's writable workspace live in the user home in both modes.
 * Returns `undefined` for a directory of neither shape.
 */
export function userProjectDirForProjectStateRoot(
  projectStateDir: string
): string | undefined {
  const resolved = path.resolve(projectStateDir);
  const projectsRoot = path.resolve(userProjectsRoot());
  if (pathsEqual(path.dirname(resolved), projectsRoot)) {
    return resolved;
  }
  if (path.basename(resolved) === CTRLYOKE_DIR) {
    return path.join(projectsRoot, projectKey(path.dirname(resolved)));
  }
  return undefined;
}

function sanitizeProjectSlug(basename: string): string {
  const ascii = basename
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x00-\x7F]/g, "");
  const sanitized = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PROJECT_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");

  return sanitized || "project";
}
