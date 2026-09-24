import * as assert from "assert";
import { suite, test } from "mocha";
import { fuzzyMatchRanges } from "../../completions/FuzzyRanking";

suite("FuzzyRanking", () => {
  test("fuzzyMatchRanges merges adjacent matched characters into ranges", () => {
    assert.deepStrictEqual(
      fuzzyMatchRanges("useFinalStepContextMenu", "usecontext"),
      [0, 3, 12, 19]
    );
  });

  test("fuzzyMatchRanges returns no ranges for an empty or non-matching query", () => {
    assert.deepStrictEqual(fuzzyMatchRanges("CodeMirrorEditor.tsx", ""), []);
    assert.deepStrictEqual(fuzzyMatchRanges("CodeMirrorEditor.tsx", "zzz"), []);
  });
});
