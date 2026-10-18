import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type {
  DiscoveredFileLocationInfo,
  ShadowedDiscoveryCopy,
} from "../types/WebviewMessageTypes";

/**
 * DiscoveryUtils
 *
 * Shared helpers for agent and skill discovery.
 * Used by AgentDiscovery, SkillDiscovery, AgentExpander, and SkillExpander.
 */

/**
 * Format a directory or filename for display in UI.
 * Converts kebab-case or snake_case to Title Case.
 *
 * @example formatDisplayName("pdf-processing") → "Pdf Processing"
 * @example formatDisplayName("my_skill")       → "My Skill"
 */
export function formatDisplayName(name: string): string {
  const withSpaces = name.replace(/[-_]/g, " ");
  return withSpaces
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Shorten an absolute discovery path for UI: workspace-relative when inside
 * the workspace, `~/`-prefixed when under the home directory, else absolute.
 * Separators are always `/`.
 */
export function formatDiscoveryPath(
  filePath: string,
  workspaceRoot?: string
): string {
  const isInside = (root: string) => {
    const relative = path.relative(root, filePath);
    return (
      relative !== "" &&
      !relative.startsWith("..") &&
      !path.isAbsolute(relative)
    );
  };
  const toSlashes = (value: string) => value.split(path.sep).join("/");

  if (workspaceRoot && isInside(workspaceRoot)) {
    return toSlashes(path.relative(workspaceRoot, filePath));
  }
  const home = os.homedir();
  if (isInside(home)) {
    return `~/${toSlashes(path.relative(home, filePath))}`;
  }
  return toSlashes(filePath);
}

async function readFileText(filePath: string): Promise<string | undefined> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Collapse discovered agents or skills to one entry per name. Workflows
 * reference both by bare name and resolution takes the first match, so the
 * first entry in discovery order is the copy that runs; every later
 * same-named entry becomes a `shadowedCopies` record, flagged `identical`
 * when its file text matches the winner exactly. Every surviving entry also
 * gets a `displayPath`.
 */
export async function collapseDiscoveredByName<
  T extends { name: string; path: string } & DiscoveredFileLocationInfo,
>(items: readonly T[], workspaceRoot?: string): Promise<T[]> {
  const winners = new Map<string, T>();
  const shadowed = new Map<string, ShadowedDiscoveryCopy[]>();
  const textCache = new Map<string, Promise<string | undefined>>();
  const readCached = (filePath: string) => {
    let text = textCache.get(filePath);
    if (!text) {
      text = readFileText(filePath);
      textCache.set(filePath, text);
    }
    return text;
  };

  for (const item of items) {
    const winner = winners.get(item.name);
    if (!winner) {
      winners.set(item.name, item);
      continue;
    }
    const [winnerText, itemText] = await Promise.all([
      readCached(winner.path),
      readCached(item.path),
    ]);
    const copies = shadowed.get(item.name) ?? [];
    copies.push({
      displayPath: formatDiscoveryPath(item.path, workspaceRoot),
      identical: winnerText !== undefined && winnerText === itemText,
    });
    shadowed.set(item.name, copies);
  }

  return Array.from(winners.values(), (winner) => {
    const copies = shadowed.get(winner.name);
    return {
      ...winner,
      displayPath: formatDiscoveryPath(winner.path, workspaceRoot),
      ...(copies ? { shadowedCopies: copies } : {}),
    };
  });
}

/**
 * Returns true if `directoryPath` exists and is a directory.
 * Returns false for any other case (missing, file, permission error).
 */
export async function isAccessibleDirectory(
  directoryPath: string
): Promise<boolean> {
  if (!fs.existsSync(directoryPath)) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}
