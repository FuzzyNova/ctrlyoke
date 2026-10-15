import * as os from "node:os";
import * as path from "node:path";
import { hashPathForCompare } from "./PathCasing";
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
 * Build the stable, readable directory key for a resolved ctrlyoke state root.
 * The hash is based on PathCasing's platform-aware comparison form so Windows
 * drive-letter and path casing differences do not create separate projects.
 */
export function projectKey(stateRoot: string): string {
  const resolvedStateRoot = path.resolve(stateRoot);
  const slug = sanitizeProjectSlug(path.basename(resolvedStateRoot));
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
