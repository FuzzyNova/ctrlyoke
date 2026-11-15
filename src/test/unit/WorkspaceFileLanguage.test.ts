import * as assert from "assert";
import { suite, test } from "mocha";
import {
  languageFromPath,
  WORKSPACE_FILE_LANGUAGE_MAP,
} from "../../utils/WorkspaceFileLanguage";

suite("WorkspaceFileLanguage", () => {
  for (const [extension, language] of Object.entries(
    WORKSPACE_FILE_LANGUAGE_MAP
  )) {
    test(`maps .${extension} files`, () => {
      assert.strictEqual(languageFromPath(`file.${extension}`), language);
    });
  }

  test("maps the Dockerfile basename", () => {
    assert.strictEqual(languageFromPath("Dockerfile"), "dockerfile");
  });

  test("maps .env basenames and env extensions to properties", () => {
    assert.strictEqual(languageFromPath(".env"), "properties");
    assert.strictEqual(languageFromPath(".env.local"), "properties");
    assert.strictEqual(languageFromPath("foo.env"), "properties");
  });

  test("accepts Windows path separators", () => {
    assert.strictEqual(
      languageFromPath("C:\\workspace\\src\\file.ts"),
      "typescript"
    );
  });

  test("matches uppercase extensions case-insensitively", () => {
    assert.strictEqual(languageFromPath("src/file.TS"), "typescript");
  });

  test("returns undefined for paths without a supported extension", () => {
    assert.strictEqual(languageFromPath("README"), undefined);
  });

  test("does not interpret a dotfile name as an extension", () => {
    assert.strictEqual(languageFromPath(".ts"), undefined);
  });
});
