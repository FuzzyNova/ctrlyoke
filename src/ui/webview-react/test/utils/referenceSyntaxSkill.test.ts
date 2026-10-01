import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { findAtomicReferences } from "@utils/atomicReferences";

// The skill's "Citing things in your reply" section promises that each of its
// examples renders as a link in the output pane. Pin that promise to the
// parser the output pane actually uses.
const skill = readFileSync(
  resolve(__dirname, "../../../../templates/skills/ctrlyoke-syntax/SKILL.md"),
  "utf8"
);
const citingSection = skill.slice(
  skill.indexOf("## Citing things in your reply"),
  skill.indexOf("## Writing prompts ctrlyoke will run")
);
const tableExamples = [
  ...citingSection.matchAll(/^\|[^|\n]*\|\s*(.*?)\s*\|$/gm),
].flatMap((row) => [...row[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]));

describe("ctrlyoke-syntax skill citing examples", () => {
  it("keeps its citing table", () => {
    expect(tableExamples.length).toBeGreaterThanOrEqual(8);
  });

  it.each(tableExamples)("links %s as one whole reference", (example) => {
    const refs = findAtomicReferences(example);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ from: 0, to: example.length });
  });

  it("links every reference in the example sentence", () => {
    const sentence = citingSection.match(/For example: "([^"]+)"/)?.[1] ?? "";
    expect(
      findAtomicReferences(sentence).map((ref) =>
        sentence.slice(ref.from, ref.to)
      )
    ).toEqual([
      "#sym:src/auth/login.ts:validateToken:42-57",
      "~3f9c2a1",
      "@src/auth/login.test.ts",
    ]);
  });
});
