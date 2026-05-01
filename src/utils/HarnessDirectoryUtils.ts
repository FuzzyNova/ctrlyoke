import * as path from "path";
import * as os from "os";
import { HARNESS_IDS } from "../types/DashboardConstants";
import type { HarnessId } from "../types/DashboardConstants";
import { PATH_CONSTANTS } from "./ConfigurationUtils";

// ============================================================================
// Harness Directory Maps — Single Source of Truth
// ============================================================================

const HARNESS_WORKSPACE_AGENT_DIRS: Record<HarnessId, string[]> = {
  [HARNESS_IDS.CLAUDE_CLI]: [".claude/agents"],
  [HARNESS_IDS.COPILOT_CLI]: [".github/agents"],
  [HARNESS_IDS.CODEX_CLI]: [".agents"],
  [HARNESS_IDS.GEMINI_CLI]: [".gemini/agents"],
  [HARNESS_IDS.OPENCODE_CLI]: [".opencode/agents"],
  [HARNESS_IDS.QWEN_CLI]: [".qwen/agents"],
  [HARNESS_IDS.COPILOT_CHAT]: [".github/agents"],
};

const HARNESS_USER_AGENT_DIRS: Record<HarnessId, string[]> = {
  [HARNESS_IDS.CLAUDE_CLI]: ["~/.claude/agents"],
  [HARNESS_IDS.COPILOT_CLI]: ["~/.copilot/agents"],
  [HARNESS_IDS.CODEX_CLI]: ["~/.codex/agents", "~/.agents"],
  [HARNESS_IDS.GEMINI_CLI]: ["~/.gemini/agents"],
  [HARNESS_IDS.OPENCODE_CLI]: ["~/.config/opencode/agents"],
  [HARNESS_IDS.QWEN_CLI]: ["~/.qwen/agents"],
  [HARNESS_IDS.COPILOT_CHAT]: ["~/.copilot/agents"],
};

const HARNESS_WORKSPACE_SKILL_DIRS: Record<HarnessId, string[]> = {
  [HARNESS_IDS.CLAUDE_CLI]: [".claude/skills"],
  [HARNESS_IDS.COPILOT_CLI]: [".github/skills"],
  [HARNESS_IDS.CODEX_CLI]: [".agents/skills"],
  [HARNESS_IDS.GEMINI_CLI]: [".gemini/skills", ".agents/skills"],
  [HARNESS_IDS.OPENCODE_CLI]: [".opencode/skills"],
  [HARNESS_IDS.QWEN_CLI]: [".qwen/skills"],
  [HARNESS_IDS.COPILOT_CHAT]: [".github/skills"],
};

const HARNESS_USER_SKILL_DIRS: Record<HarnessId, string[]> = {
  [HARNESS_IDS.CLAUDE_CLI]: ["~/.claude/skills"],
  [HARNESS_IDS.COPILOT_CLI]: ["~/.copilot/skills"],
  [HARNESS_IDS.CODEX_CLI]: ["~/.codex/skills", "~/.agents/skills"],
  [HARNESS_IDS.GEMINI_CLI]: ["~/.gemini/skills", "~/.agents/skills"],
  [HARNESS_IDS.OPENCODE_CLI]: ["~/.config/opencode/skills"],
  [HARNESS_IDS.QWEN_CLI]: ["~/.qwen/skills"],
  [HARNESS_IDS.COPILOT_CHAT]: ["~/.copilot/skills"],
};

/**
 * File extension used when reading/writing agent files for each harness.
 * Claude CLI and Gemini use plain *.md (with YAML frontmatter agent headers);
 * all others use *.agent.md.
 */
export const HARNESS_AGENT_EXTENSION: Record<HarnessId, string> = {
  [HARNESS_IDS.CLAUDE_CLI]: ".md",
  [HARNESS_IDS.COPILOT_CLI]: ".agent.md",
  [HARNESS_IDS.CODEX_CLI]: ".agent.md",
  [HARNESS_IDS.GEMINI_CLI]: ".md",
  [HARNESS_IDS.OPENCODE_CLI]: ".agent.md",
  [HARNESS_IDS.QWEN_CLI]: ".agent.md",
  [HARNESS_IDS.COPILOT_CHAT]: ".agent.md",
};

// ============================================================================
// Path Expansion
// ============================================================================

function expandTilde(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function resolveRelativeToWorkspace(
  relativePath: string,
  workspaceRoot: string
): string {
  return path.join(workspaceRoot, relativePath);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Returns all workspace-level agent directories for a harness (absolute paths).
 */
export function getHarnessAgentDirs(
  harnessId: HarnessId,
  workspaceRoot: string
): string[] {
  return (HARNESS_WORKSPACE_AGENT_DIRS[harnessId] ?? []).map((rel) =>
    resolveRelativeToWorkspace(rel, workspaceRoot)
  );
}

/**
 * Returns all user-level agent directories for a harness (absolute paths).
 */
export function getHarnessUserAgentDirs(harnessId: HarnessId): string[] {
  return (HARNESS_USER_AGENT_DIRS[harnessId] ?? []).map(expandTilde);
}

/**
 * Returns all workspace-level skill directories for a harness (absolute paths).
 */
export function getHarnessSkillDirs(
  harnessId: HarnessId,
  workspaceRoot: string
): string[] {
  return (HARNESS_WORKSPACE_SKILL_DIRS[harnessId] ?? []).map((rel) =>
    resolveRelativeToWorkspace(rel, workspaceRoot)
  );
}

/**
 * Returns all user-level skill directories for a harness (absolute paths).
 */
export function getHarnessUserSkillDirs(harnessId: HarnessId): string[] {
  return (HARNESS_USER_SKILL_DIRS[harnessId] ?? []).map(expandTilde);
}

/**
 * Returns the FlightPath-exclusive agent directory (absolute path).
 */
export function getFlightPathAgentDir(workspaceRoot: string): string {
  return path.join(
    workspaceRoot,
    PATH_CONSTANTS.FLIGHTPATH_DIR,
    PATH_CONSTANTS.AGENTS_DIR
  );
}

/**
 * Returns the FlightPath-exclusive skill directory (absolute path).
 */
export function getFlightPathSkillDir(workspaceRoot: string): string {
  return path.join(
    workspaceRoot,
    PATH_CONSTANTS.FLIGHTPATH_DIR,
    PATH_CONSTANTS.SKILLS_DIR
  );
}

/**
 * Returns all known harness IDs that have workspace agent directories.
 */
export function getAllHarnessIds(): HarnessId[] {
  return Object.keys(HARNESS_WORKSPACE_AGENT_DIRS) as HarnessId[];
}
