import * as assert from "assert";
import * as fs from "fs";
import { suite, test } from "mocha";
import { SkillDiscovery } from "../../utils/SkillDiscovery";
import { AgentDiscovery } from "../../utils/AgentDiscovery";
import {
  parseAllFileReferences,
  parseConditionOutputRefs,
  parseGitChangeReferences,
  parseInlinePriorContextRefs,
} from "../../utils/FileReferenceParser";
import { scanCtrlYokeSlashTokens } from "../../utils/CtrlYokeSlashTokens";
import { parseSecretReferences } from "../../utils/SecretReferenceParser";
import {
  DISCOVERY_SOURCES,
  REFERENCE_SYNTAX_SKILL_NAME,
} from "../../types/DashboardConstants";

/** Inline-code spans in the skill that the skill presents as non-references. */
const DOCUMENTED_NON_REFERENCES = new Set(["~3f9c2a1x"]);

/** Every whole token the runtime parsers recognize in `text`. */
function runtimeTokens(text: string): string[] {
  return [
    ...parseAllFileReferences(text).map((ref) =>
      text.slice(ref.startOffset ?? 0, ref.endOffset ?? text.length)
    ),
    ...parseGitChangeReferences(text).map((ref) => ref.raw),
    ...parseInlinePriorContextRefs(text).map((ref) => ref.token),
    ...parseConditionOutputRefs(text).map((ref) => ref.token),
    ...scanCtrlYokeSlashTokens(text).map((token) => token.raw),
    ...parseSecretReferences(text).map((ref) =>
      text.slice(ref.startOffset, ref.endOffset)
    ),
  ];
}

async function readSkill(): Promise<string> {
  const skill = (await SkillDiscovery.discoverBuiltInSkills()).find(
    (candidate) => candidate.name === REFERENCE_SYNTAX_SKILL_NAME
  );
  assert.ok(skill, "the bundled reference-syntax skill is discovered");
  assert.strictEqual(skill.source, DISCOVERY_SOURCES.BUILT_IN);
  assert.ok(skill.description, "the skill has a description");
  return fs.promises.readFile(skill.path, "utf8");
}

suite("ctrlyoke-syntax skill", () => {
  // The skill is the agents' only source for this syntax, so every example in
  // it must be something the runtime actually expands — otherwise a parser
  // change silently teaches agents a form that does nothing.
  test("every reference example is recognized whole by the runtime parsers", async () => {
    const content = await readSkill();
    const examples = [...content.matchAll(/`([@#~$/!][^`]*)`/g)]
      .map((match) => match[1])
      .filter((example) => !DOCUMENTED_NON_REFERENCES.has(example));

    assert.ok(examples.length >= 15, "the skill keeps its example table");
    for (const example of examples) {
      assert.ok(
        runtimeTokens(example).includes(example),
        `"${example}" is not a complete reference to the runtime parsers`
      );
    }
    for (const nonReference of DOCUMENTED_NON_REFERENCES) {
      assert.ok(content.includes(`\`${nonReference}\``));
      assert.ok(
        !runtimeTokens(nonReference).includes(nonReference),
        `"${nonReference}" is documented as not being a reference`
      );
    }
  });

  test("every bundled agent declares the skill", async () => {
    const agents = await AgentDiscovery.discoverBuiltInAgents();
    assert.ok(agents.length > 0);
    for (const agent of agents) {
      assert.ok(
        agent.skills?.includes(REFERENCE_SYNTAX_SKILL_NAME),
        `${agent.name} declares ${REFERENCE_SYNTAX_SKILL_NAME}`
      );
    }
  });
});
