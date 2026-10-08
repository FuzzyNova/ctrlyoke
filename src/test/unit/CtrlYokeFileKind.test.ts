import * as assert from "assert";
import { suite, test } from "mocha";
import {
  getCtrlYokeFileGlobs,
  getCtrlYokeFileKind,
} from "../../completions/CtrlYokeFileKind";
import { CTRLYOKE_FILE_KINDS } from "../../types/DashboardConstants";

suite("CtrlYokeFileKind", () => {
  test("classifies workflow and prompt files by basename suffix", () => {
    const cases: Array<[string, string | null]> = [
      ["flow.ctrlyoke.yaml", CTRLYOKE_FILE_KINDS.WORKFLOW_YAML],
      [
        ".ctrlyoke/workflows/flow.ctrlyoke.yml",
        CTRLYOKE_FILE_KINDS.WORKFLOW_YAML,
      ],
      ["flow.ctrlyoke.json", CTRLYOKE_FILE_KINDS.WORKFLOW_JSON],
      ["flow.prompt.json", CTRLYOKE_FILE_KINDS.WORKFLOW_JSON],
      ["docs/intro.prompt.md", CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN],
      ["FLOW.CTRLYOKE.YAML", CTRLYOKE_FILE_KINDS.WORKFLOW_YAML],
      ["dir\\sub\\flow.ctrlyoke.yaml", CTRLYOKE_FILE_KINDS.WORKFLOW_YAML],
    ];
    for (const [filePath, expected] of cases) {
      assert.strictEqual(getCtrlYokeFileKind(filePath), expected, filePath);
    }
  });

  test("leaves every other file alone", () => {
    for (const filePath of [
      "config.yaml",
      "package.json",
      "README.md",
      "notes.prompt.txt",
      "ctrlyoke.yaml",
      ".prompt.md",
      "dir.ctrlyoke.yaml/inner.yaml",
    ]) {
      assert.strictEqual(getCtrlYokeFileKind(filePath), null, filePath);
    }
  });

  test("globs cover exactly the suffixes the predicate accepts", () => {
    assert.deepStrictEqual(
      getCtrlYokeFileGlobs([CTRLYOKE_FILE_KINDS.WORKFLOW_YAML]),
      ["**/*.ctrlyoke.yaml", "**/*.ctrlyoke.yml"]
    );
    assert.deepStrictEqual(getCtrlYokeFileGlobs(), [
      "**/*.ctrlyoke.yaml",
      "**/*.ctrlyoke.yml",
      "**/*.ctrlyoke.json",
      "**/*.prompt.json",
      "**/*.prompt.md",
    ]);
  });
});
