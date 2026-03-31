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

    // Inline prompts — should return false
    test("returns false for plain text prompt", () => {
      assert.strictEqual(
        looksLikeFilePath("Write unit tests for the parser"),
        false
      );
    });

    test("returns false for empty string", () => {
      assert.strictEqual(looksLikeFilePath(""), false);
    });

    test("returns false for whitespace only", () => {
      assert.strictEqual(looksLikeFilePath("   "), false);
    });

    test("returns false for FlightPath inline reference starting with #", () => {
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
