import * as assert from "assert";
import { suite, test } from "mocha";
import { extractExtensionsFromGlobs } from "../../utils/fileFilterUtils";

suite("fileFilterUtils", () => {
  suite("extractExtensionsFromGlobs", () => {
    test("extracts a simple extension", () => {
      assert.deepStrictEqual(extractExtensionsFromGlobs(["**/*.md"]), ["md"]);
    });

    test("preserves compound extensions", () => {
      assert.deepStrictEqual(
        extractExtensionsFromGlobs(["**/*.prompt.md", "**/*.ctrlyoke.yaml"]),
        ["prompt.md", "ctrlyoke.yaml"]
      );
    });

    test("expands one brace group into extensions", () => {
      assert.deepStrictEqual(
        extractExtensionsFromGlobs(["**/*.{md,txt}", "**/*.{prompt.md,yaml}"]),
        ["md", "txt", "prompt.md", "yaml"]
      );
    });

    test("drops patterns that still contain glob metacharacters", () => {
      assert.deepStrictEqual(
        extractExtensionsFromGlobs([
          "**/*.md",
          "**/*.foo*",
          "**/*.bar?",
          "**/*.[ch]",
          "**/*.{md,txt",
        ]),
        ["md"]
      );
    });
  });
});
