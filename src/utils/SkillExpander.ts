import { SkillDiscovery, SkillInfo } from "./SkillDiscovery";
import { Log } from "./Log";
import { TtlCache } from "./TtlCache";

/**
 * SkillExpander
 *
 * RESPONSIBILITY: Expand skill names to concise prompt blocks for injection.
 *
 * Progressive disclosure design:
 * - Only the name, path, and description are included in the prompt (~10-20 tokens per skill)
 * - The full SKILL.md body is NOT included — the harness reads it when it decides to use the skill
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
   * @returns Formatted <skillInstructions> block, or null if no skills resolved
   */
  static async expandSkills(
    skillNames: string[],
    workspaceRoot?: string
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

      resolvedBlocks.push(this.buildSkillBlock(skill));
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
  private static buildSkillBlock(skill: SkillInfo): string {
    const lines = [`## Skill: ${skill.name}`, `Path: ${skill.path}`];
    if (skill.description) {
      lines.push(`Description: ${skill.description}`);
    }
    return lines.join("\n");
  }
}
