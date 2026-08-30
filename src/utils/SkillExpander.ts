import * as fs from "fs";
import * as path from "path";
import { SkillDiscovery, SkillInfo } from "./SkillDiscovery";
import { Log } from "./Log";
import { isPathWithinAnyDirectory } from "./PathSecurity";
import { TtlCache } from "./TtlCache";
import {
  DISCOVERY_SOURCES,
  MCP_SKILL_NAMES,
} from "../types/DashboardConstants";
import {
  McpToolSkillGenerator,
  MCP_TOOL_SKILL_TOOL_NAMES,
} from "./McpToolSkillGenerator";

/**
 * SkillExpander
 *
 * RESPONSIBILITY: Expand skill names to concise prompt blocks for injection.
 *
 * Progressive disclosure design:
 * - Only the name, path, and description are included in the prompt (~10-20 tokens per skill)
 * - For trusted skills, the full SKILL.md body is NOT included — the harness reads it when it decides to use the skill
 * - Unreadable skills are embedded; the built-in MCP skill adds its live tool reference to its static prose
 * - This keeps prompts concise while still making skills discoverable
 *
 * Output format (per skill, joined inside <skillInstructions>):
 *   ## Skill: pdf-processing
 *   Path: /workspace/.claude/skills/pdf-processing/SKILL.md
 *   Description: Extract text and tables from PDF files.
 */

export class SkillExpander {
  private static readonly skillCaches = new Map<string, TtlCache<SkillInfo>>();

  /**
   * Expand multiple skill names to formatted prompt blocks.
   * Returns null if no skills could be resolved (all unknown).
   * Logs a warning for each unresolvable skill and continues with the rest.
   *
   * @param skillNames Array of skill names to expand
   * @param workspaceRoot Optional workspace root for resolving workspace skills
   * @param executionCheckoutRoot Optional checkout root visible to the harness
   * @returns Formatted <skillInstructions> block, or null if no skills resolved
   */
  static async expandSkills(
    skillNames: string[],
    workspaceRoot?: string,
    executionCheckoutRoot = workspaceRoot
  ): Promise<string | null> {
    if (skillNames.length === 0) {
      return null;
    }

    const cacheKey = workspaceRoot ?? "";
    let cache = SkillExpander.skillCaches.get(cacheKey);
    if (!cache) {
      cache = new TtlCache<SkillInfo>(5000);
      SkillExpander.skillCaches.set(cacheKey, cache);
    }
    const allSkills = await cache.get(() =>
      SkillDiscovery.discoverSkills(workspaceRoot)
    );

    const resolvedBlocks: string[] = [];

    for (const skillName of skillNames) {
      const skill = SkillDiscovery.findSkillByName(allSkills, skillName);

      if (!skill) {
        Log.warn(
          `⚠️ Skill "${skillName}" not found among discovered skills — skipping`
        );
        continue;
      }

      const block = await this.buildSkillBlock(skill, [
        workspaceRoot,
        executionCheckoutRoot,
      ]);
      if (!block) {
        continue;
      }

      resolvedBlocks.push(block);
      Log.debug(`🎯 Skill "${skillName}" resolved from ${skill.path}`);
    }

    if (resolvedBlocks.length === 0) {
      return null;
    }

    const header =
      "The following skills are available. When you decide to use a skill, read its SKILL.md file directly using your built-in file read tool and follow the instructions inside. Do NOT attempt to invoke these skills using any native skills tool — these are not registered harness skills and that will fail. Simply read the file at the path listed and follow the instructions.";
    const body = resolvedBlocks.join("\n\n");

    return `<skillInstructions>\n${header}\n\n${body}\n</skillInstructions>`;
  }

  /**
   * Build a concise prompt block for a single skill.
   * Omits description line if the skill has no description.
   */
  private static async buildSkillBlock(
    skill: SkillInfo,
    trustedRoots: Array<string | undefined>
  ): Promise<string | null> {
    const resolvedSkillPath = path.resolve(skill.path);
    const resolvedTrustedRoots = trustedRoots
      .filter((root): root is string => root !== undefined)
      .map((root) => path.resolve(root));

    if (!isPathWithinAnyDirectory(resolvedSkillPath, resolvedTrustedRoots)) {
      try {
        if (
          skill.source === DISCOVERY_SOURCES.BUILT_IN &&
          skill.name === MCP_SKILL_NAMES.TOOLS
        ) {
          const staticContent = await fs.promises.readFile(
            resolvedSkillPath,
            "utf-8"
          );
          return `${staticContent.trimEnd()}\n\n${McpToolSkillGenerator.generateToolReference(
            [...MCP_TOOL_SKILL_TOOL_NAMES]
          )}`;
        }

        return await fs.promises.readFile(resolvedSkillPath, "utf-8");
      } catch (error) {
        Log.warn(
          `⚠️ Failed to read out-of-trust-root skill file "${skill.path}": ${error}`
        );
        return null;
      }
    }

    const lines = [`## Skill: ${skill.name}`, `Path: ${skill.path}`];
    if (skill.description) {
      lines.push(`Description: ${skill.description}`);
    }
    return lines.join("\n");
  }
}
