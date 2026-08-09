import * as assert from "assert";
import { suite, test } from "mocha";
import { looksLikeFilePath } from "../../utils/promptPathUtils";
import {
  buildDirectoryReference,
  buildDirectoryReferenceValue,
  buildFileReference,
  buildFileReferenceValue,
  buildPromptFileReferenceValue,
  buildGitReference,
  buildSelectionReference,
  buildSelectionReferenceValue,
  buildSymbolReference,
  buildSymbolReferenceValue,
  quoteReferenceField,
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

  test("builds an unquoted canonical lone prompt-file reference", () => {
    const reference = buildPromptFileReferenceValue(
      ".ctrlyoke\\prompts\\fix-tests.prompt.md"
    );
    assert.strictEqual(reference, "./.ctrlyoke/prompts/fix-tests.prompt.md");
    assert.strictEqual(looksLikeFilePath(reference), true);
    assert.strictEqual(
      looksLikeFilePath(reference, { allowWorkspaceFolderPrefix: true }),
      true
    );
    assert.strictEqual(
      buildPromptFileReferenceValue("./.ctrlyoke/prompts/fix-tests.prompt.md"),
      "./.ctrlyoke/prompts/fix-tests.prompt.md"
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

  test("builds kinded symbol references without quoting the kind", () => {
    assert.strictEqual(
      buildSymbolReferenceValue(
        "src/my folder/app.ts",
        "get value",
        42,
        58,
        "type-parameter"
      ),
      'sym.type-parameter:"src/my folder/app.ts":"get value":42-58'
    );
    assert.strictEqual(
      buildSymbolReference("src/app.ts", "runWorkflow", 42, 58, "method"),
      "#sym.method:src/app.ts:runWorkflow:42-58"
    );
  });

  test("builds git references", () => {
    assert.strictEqual(buildGitReference("diff"), "~diff");
    assert.strictEqual(buildGitReference("stash:0"), "~stash:0");
  });

  suite("colon-delimited field quoting", () => {
    test("quoteReferenceField quotes on whitespace or colon, not otherwise", () => {
      assert.strictEqual(quoteReferenceField("Foo"), "Foo");
      assert.strictEqual(quoteReferenceField("Foo<T>"), "Foo<T>");
      assert.strictEqual(quoteReferenceField("doThing()"), "doThing()");
      assert.strictEqual(quoteReferenceField("get value"), '"get value"');
      assert.strictEqual(quoteReferenceField("C:/dev/a.ts"), '"C:/dev/a.ts"');
    });

    test("quotes a symbol name containing spaces", () => {
      assert.strictEqual(
        buildSymbolReference("src/app.ts", "get value", 42, 58),
        '#sym:src/app.ts:"get value":42-58'
      );
    });

    test("leaves symbol names that need no quoting bare", () => {
      assert.strictEqual(
        buildSymbolReference("src/app.ts", "Foo<T>", 1, 2),
        "#sym:src/app.ts:Foo<T>:1-2"
      );
    });

    // quoteReferencePath (used by @refs) only quotes on spaces, which left an
    // absolute path's drive colon bare and made the token unparseable.
    test("quotes an absolute path in #sym: and #selection:", () => {
      assert.strictEqual(
        buildSymbolReference("C:/dev/repo/a.ts", "foo", 1, 1),
        '#sym:"C:/dev/repo/a.ts":foo:1-1'
      );
      assert.strictEqual(
        buildSelectionReference("C:/dev/repo/a.ts", 10, 20),
        '#selection:"C:/dev/repo/a.ts":10-20'
      );
    });

    test("normalizes separators before quoting", () => {
      assert.strictEqual(
        buildSymbolReference("C:\\dev\\my repo\\a.ts", "foo", 1, 1),
        '#sym:"C:/dev/my repo/a.ts":foo:1-1'
      );
    });
  });
});
