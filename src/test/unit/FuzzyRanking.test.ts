import * as assert from "assert";
import { suite, test } from "mocha";
import {
  buildFuzzyIndex,
  fuzzyMatchRanges,
  rankByFuzzyQuery,
  rankIndexByFuzzyQuery,
} from "../../completions/FuzzyRanking";

suite("FuzzyRanking", () => {
  test("fuzzyMatchRanges merges adjacent matched characters into ranges", () => {
    assert.deepStrictEqual(
      fuzzyMatchRanges("useFinalStepContextMenu", "usecontext"),
      [0, 3, 12, 19]
    );
  });

  test("ranks equal scores in input order, with and without an index", () => {
    const items = Array.from({ length: 200 }, (_, index) => ({
      name: "SKILL.md",
      path: `${"deep/".repeat(index % 7)}${index}/SKILL.md`,
      index,
    }));
    const keys = [
      (item: (typeof items)[number]) => item.name,
      (item: (typeof items)[number]) => item.path,
    ];
    const expected = items.slice(0, 10).map((item) => item.index);
    assert.deepStrictEqual(
      rankByFuzzyQuery("skill", items, keys, 10).map((item) => item.index),
      expected
    );
    assert.deepStrictEqual(
      rankIndexByFuzzyQuery("skill", buildFuzzyIndex(items, keys), 10).map(
        (item) => item.index
      ),
      expected
    );
  });

  test("lets a better score outrank an earlier item", () => {
    const items = [{ name: "CodeMirrorTheme.ts" }, { name: "cme.ts" }];
    assert.deepStrictEqual(
      rankByFuzzyQuery("cme", items, [(item) => item.name]).map(
        (item) => item.name
      ),
      ["cme.ts", "CodeMirrorTheme.ts"]
    );
  });

  test("fuzzyMatchRanges returns no ranges for an empty or non-matching query", () => {
    assert.deepStrictEqual(fuzzyMatchRanges("CodeMirrorEditor.tsx", ""), []);
    assert.deepStrictEqual(fuzzyMatchRanges("CodeMirrorEditor.tsx", "zzz"), []);
  });
});
