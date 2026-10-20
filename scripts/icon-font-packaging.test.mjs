import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

function vscodeignoreNegations() {
  return new Set(
    fs
      .readFileSync(path.join(ROOT_DIR, ".vscodeignore"), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("!"))
      .map((line) => line.slice(1))
  );
}

test("every contributed icon's font exists and ships in the VSIX", () => {
  const icons = Object.entries(
    JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"))
      .contributes.icons ?? {}
  );
  assert.ok(icons.length > 0, "package.json contributes no icons");

  const included = vscodeignoreNegations();
  for (const [id, { default: icon }] of icons) {
    assert.ok(
      fs.existsSync(path.join(ROOT_DIR, icon.fontPath)),
      `${id}: ${icon.fontPath} is missing; run npm run generate-icon-font`
    );
    assert.ok(
      included.has(icon.fontPath),
      `.vscodeignore must include !${icon.fontPath}`
    );
  }
});
