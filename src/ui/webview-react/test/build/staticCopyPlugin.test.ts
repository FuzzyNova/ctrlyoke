import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveStaticCopyFiles } from "../../build/staticCopyPlugin";

describe("resolveStaticCopyFiles", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cy-static-copy-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeFile(relativePath: string): string {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, relativePath);
    return filePath;
  }

  it("copies a single file into dest under its own name", () => {
    const sourcePath = writeFile("vendor/pkg/typo.js");

    expect(
      resolveStaticCopyFiles([{ src: "vendor/pkg/typo.js", dest: "." }], root)
    ).toEqual([{ sourcePath, outputPath: "typo.js" }]);
    expect(
      resolveStaticCopyFiles(
        [{ src: "vendor/pkg/typo.js", dest: "codicons" }],
        root
      )
    ).toEqual([{ sourcePath, outputPath: "codicons/typo.js" }]);
  });

  it("copies a directory's contents recursively, keeping subfolders", () => {
    const aff = writeFile("static/dictionaries/en_US/en_US.aff");
    const dic = writeFile("static/dictionaries/en_US/en_US.dic");

    const files = resolveStaticCopyFiles(
      [{ src: "static/dictionaries", dest: "dictionaries" }],
      root
    );

    expect(
      [...files].sort((a, b) => a.outputPath.localeCompare(b.outputPath))
    ).toEqual([
      { sourcePath: aff, outputPath: "dictionaries/en_US/en_US.aff" },
      { sourcePath: dic, outputPath: "dictionaries/en_US/en_US.dic" },
    ]);
  });

  it("throws when a source is missing instead of silently skipping it", () => {
    expect(() =>
      resolveStaticCopyFiles([{ src: "missing.svg", dest: "." }], root)
    ).toThrow(/ENOENT/);
  });
});
