import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getErrnoCode } from "./ErrorUtils";
import { hashPathForCompare, pathsEqual } from "./PathCasing";
import type { RunHistoryLocation } from "../types/CtrlYokeSettings";
import { NODE_ERROR_CODES } from "../types/DashboardConstants";

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
 * The one spelling of a state root that project identity is derived from: the
 * real path, with symlinks, junctions and substituted drives resolved, so a
 * repository reached through `/tmp` and `/private/tmp` (or through a symlinked
 * `~/dev`) is one project. A path that does not exist (a renamed repository
 * named in `history relink`) resolves its nearest existing ancestor and keeps
 * the missing tail as typed. Any other failure falls back to `path.resolve`.
 */
export function canonicalStatePath(stateRoot: string): string {
  const resolved = path.resolve(stateRoot);
  const missingTail: string[] = [];
  let existing = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(existing), ...missingTail);
    } catch (error) {
      const code = getErrnoCode(error);
      const parent = path.dirname(existing);
      if (
        (code !== NODE_ERROR_CODES.ENOENT &&
          code !== NODE_ERROR_CODES.ENOTDIR) ||
        parent === existing
      ) {
        return resolved;
      }
      missingTail.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

/**
 * Build the stable, readable directory key for a ctrlyoke state root. The key
 * is derived from {@link canonicalStatePath}, and the hash from PathCasing's
 * platform-aware comparison form, so neither symlinked spellings nor Windows
 * drive-letter and path casing create separate projects.
 */
export function projectKey(stateRoot: string): string {
  const resolvedStateRoot = path.resolve(stateRoot);
  const cached = projectKeyCache.get(resolvedStateRoot);
  if (cached !== undefined) {
    return cached;
  }

  const key = projectKeyForSpelling(canonicalStatePath(resolvedStateRoot));
  if (projectKeyCache.size >= PROJECT_KEY_CACHE_LIMIT) {
    projectKeyCache.clear();
  }
  projectKeyCache.set(resolvedStateRoot, key);
  return key;
}

/**
 * The key older releases derived from the path exactly as spelled, before
 * keys were canonicalized. Only the registry's migration of split history and
 * `history relink`'s source lookup may use it; everything else uses
 * {@link projectKey}.
 */
export function legacyProjectKey(stateRoot: string): string {
  return projectKeyForSpelling(path.resolve(stateRoot));
}

/** The readable slug a project key starts with, for finding a project's keys. */
export function projectKeySlug(stateRoot: string): string {
  return sanitizeProjectSlug(path.basename(path.resolve(stateRoot)));
}

function projectKeyForSpelling(resolvedStateRoot: string): string {
  const slug = projectKeySlug(resolvedStateRoot);
  const hash = hashPathForCompare(resolvedStateRoot).slice(0, HASH_LENGTH);
  return `${slug}-${hash}`;
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
