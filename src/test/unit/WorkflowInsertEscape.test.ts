import * as assert from "assert";
import { suite, test } from "mocha";
import { getWorkflowInsertEscape } from "../../completions/WorkflowInsertEscape";
import { YAML_SCALAR_STYLES } from "../../completions/WorkflowLocationTypes";

const QUOTED_PATH = `"docs/it's notes.md"`;

suite("getWorkflowInsertEscape", () => {
  test("escapes for a JSON string and a YAML double-quoted scalar", () => {
    for (const location of [
      { jsonString: true },
      { scalarStyle: YAML_SCALAR_STYLES.DOUBLE_QUOTED },
    ]) {
      assert.strictEqual(
        getWorkflowInsertEscape(location)?.(QUOTED_PATH),
        `\\"docs/it's notes.md\\"`
      );
    }
  });

  test("doubles a single quote inside a YAML single-quoted scalar", () => {
    assert.strictEqual(
      getWorkflowInsertEscape({
        scalarStyle: YAML_SCALAR_STYLES.SINGLE_QUOTED,
      })?.(QUOTED_PATH),
      `"docs/it''s notes.md"`
    );
  });

  test("leaves plain and block scalars and markdown alone", () => {
    for (const location of [
      { scalarStyle: YAML_SCALAR_STYLES.PLAIN },
      { scalarStyle: YAML_SCALAR_STYLES.BLOCK },
      {},
    ]) {
      assert.strictEqual(getWorkflowInsertEscape(location), undefined);
    }
  });
});
