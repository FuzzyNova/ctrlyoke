import * as assert from "assert";
import { suite, test } from "mocha";
import {
  looksLikeFilePath,
  PROMPT_FILE_EXTENSIONS,
} from "../../utils/promptPathUtils";

suite("promptPathUtils", () => {
  suite("PROMPT_FILE_EXTENSIONS", () => {
    test("contains .prompt.md", () => {
      assert.ok(PROMPT_FILE_EXTENSIONS.includes(".prompt.md"));
    });

    test("contains .md", () => {
      assert.ok(PROMPT_FILE_EXTENSIONS.includes(".md"));
    });

    test("contains .txt", () => {
      assert.ok(PROMPT_FILE_EXTENSIONS.includes(".txt"));
    });
  });

  suite("looksLikeFilePath", () => {
    // Happy path — relative paths
    test("recognizes relative path with .prompt.md extension", () => {
      assert.strictEqual(looksLikeFilePath("./prompts/setup.prompt.md"), true);
    });

    test("recognizes folder-qualified paths only when multi-root syntax is enabled", () => {
      assert.strictEqual(
        looksLikeFilePath("root2/prompts/setup.prompt.md"),
        false
      );
      assert.strictEqual(
        looksLikeFilePath("root2/prompts/setup.prompt.md", {
          allowWorkspaceFolderPrefix: true,
        }),
        true
      );
    });

    test("does not treat a lone @-reference as a workspace-folder-prefixed path", () => {
      // "@src/index.ts" matches the folder-qualified prefix shape but is a
      // ctrlyoke context reference (@file), not a standalone prompt path.
      assert.strictEqual(
        looksLikeFilePath("@src/index.ts", {
          allowWorkspaceFolderPrefix: true,
        }),
        false
      );
    });

    test("recognizes relative path with .md extension", () => {
      assert.strictEqual(looksLikeFilePath("./README.md"), true);
    });

    test("recognizes relative path with .txt extension", () => {
      assert.strictEqual(looksLikeFilePath("./notes.txt"), true);
    });

    test("recognizes parent-relative path", () => {
      assert.strictEqual(looksLikeFilePath("../prompts/task.md"), true);
    });

    // Absolute paths
    test("recognizes Unix absolute path", () => {
      assert.strictEqual(looksLikeFilePath("/home/user/prompt.md"), true);
    });

    test("recognizes Windows drive letter path", () => {
      assert.strictEqual(looksLikeFilePath("C:\\Users\\prompt.txt"), true);
    });

    test("recognizes path with unknown extension", () => {
      assert.strictEqual(looksLikeFilePath("./config.yaml"), true);
    });

    test("recognizes paths with multiple words in file and folder names", () => {
      assert.strictEqual(
        looksLikeFilePath("./My Documents/Fix It Now.prompt.md"),
        true
      );
      assert.strictEqual(
        looksLikeFilePath("prompts/fix the bug.prompt.md", {
          allowWorkspaceFolderPrefix: true,
        }),
        true
      );
      assert.strictEqual(
        looksLikeFilePath("C:\\Users\\Jane Doe\\My Prompts\\a b c.md"),
        true
      );
    });

    // Inline prompts — should return false
    test("returns false for plain text prompt", () => {
      assert.strictEqual(
        looksLikeFilePath("Write unit tests for the parser"),
        false
      );
    });

    test("rejects prose that ends with a path-looking filename", () => {
      assert.strictEqual(
        looksLikeFilePath("/review Please look at src/app.ts"),
        false
      );
      assert.strictEqual(
        looksLikeFilePath("./fix the bug, then update README.md"),
        false
      );
      assert.strictEqual(
        looksLikeFilePath("Please fix this; then run tests.md"),
        false
      );
      assert.strictEqual(
        looksLikeFilePath("This is a sentence. Read README.md"),
        false
      );
    });

    test("rejects multiline prompt text that ends with a filename", () => {
      assert.strictEqual(
        looksLikeFilePath("/init\nThen summarise package.json"),
        false
      );
    });

    test("returns false for empty string", () => {
      assert.strictEqual(looksLikeFilePath(""), false);
    });

    test("returns false for whitespace only", () => {
      assert.strictEqual(looksLikeFilePath("   "), false);
    });

    test("returns false for ctrlyoke inline reference starting with #", () => {
      assert.strictEqual(
        looksLikeFilePath("#selection:src/index.ts:10-20"),
        false
      );
    });

    test("returns false for bare filename without path prefix", () => {
      assert.strictEqual(looksLikeFilePath("README.md"), false);
    });

    // Edge cases
    test("handles path with spaces when trimmed", () => {
      assert.strictEqual(looksLikeFilePath("  ./my prompt.md  "), true);
    });

    test("returns false for path without extension", () => {
      assert.strictEqual(looksLikeFilePath("./Makefile"), false);
    });
  });
});
