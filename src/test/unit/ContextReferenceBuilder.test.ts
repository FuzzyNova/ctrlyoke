import * as assert from "assert";
import { suite, test } from "mocha";
import {
  buildDirectoryReference,
  buildDirectoryReferenceValue,
  buildFileReference,
  buildFileReferenceValue,
  buildGitReference,
  buildSelectionReference,
  buildSelectionReferenceValue,
  buildSymbolReference,
  buildSymbolReferenceValue,
  quoteReferencePath,
} from "../../completions/ContextReferenceBuilder";

suite("ContextReferenceBuilder", () => {
  test("quotes paths with spaces", () => {
    assert.strictEqual(
      quoteReferencePath("src/my folder/file.ts"),
      '"src/my folder/file.ts"'
    );
  });

  test("builds file references", () => {
    assert.strictEqual(buildFileReferenceValue("src/app.ts"), "src/app.ts");
    assert.strictEqual(buildFileReference("src/app.ts"), "@src/app.ts");
  });

  test("builds quoted file references", () => {
    assert.strictEqual(
      buildFileReferenceValue("src/my folder/file.ts"),
      '"src/my folder/file.ts"'
    );
    assert.strictEqual(
      buildFileReference("src/my folder/file.ts"),
      '@"src/my folder/file.ts"'
    );
  });

  test("builds directory references with a trailing slash", () => {
    assert.strictEqual(
      buildDirectoryReferenceValue("src/components"),
      "src/components/"
    );
    assert.strictEqual(
      buildDirectoryReference("src/components"),
      "@src/components/"
    );
  });

  test("builds selection references", () => {
    assert.strictEqual(
      buildSelectionReferenceValue("src/app.ts", 10, 20),
      "selection:src/app.ts:10-20"
    );
    assert.strictEqual(
      buildSelectionReference("src/app.ts", 10, 20),
      "#selection:src/app.ts:10-20"
    );
  });

  test("builds symbol references", () => {
    assert.strictEqual(
      buildSymbolReferenceValue("src/app.ts", "runWorkflow", 42, 58),
      "sym:src/app.ts:runWorkflow:42-58"
    );
    assert.strictEqual(
      buildSymbolReference("src/app.ts", "runWorkflow", 42, 58),
      "#sym:src/app.ts:runWorkflow:42-58"
    );
  });

  test("builds git references", () => {
    assert.strictEqual(buildGitReference("diff"), "~diff");
    assert.strictEqual(buildGitReference("stash:0"), "~stash:0");
  });
});
