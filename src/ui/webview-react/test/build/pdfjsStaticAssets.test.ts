import { describe, expect, it } from "vitest";
import { PDFJS_STATIC_DIRS } from "../../build/pdfjsStaticAssets";

function shipsFrom(dir: string): (relativePath: string) => boolean {
  const entry = PDFJS_STATIC_DIRS.find((candidate) => candidate.dir === dir);
  if (!entry) throw new Error(`no PDFJS_STATIC_DIRS entry for ${dir}`);
  return entry.ships ?? (() => true);
}

describe("PDFJS_STATIC_DIRS", () => {
  it("leaves the QuickJS engine and its licenses out of the wasm directory", () => {
    const ships = shipsFrom("wasm");
    for (const file of [
      "quickjs-eval.js",
      "quickjs-eval.wasm",
      "LICENSE_QUICKJS",
      "LICENSE_PDFJS_QUICKJS",
    ]) {
      expect(ships(file), file).toBe(false);
    }
  });

  it("ships the image decoders and their licenses", () => {
    const ships = shipsFrom("wasm");
    for (const file of [
      "openjpeg.wasm",
      "jbig2.wasm",
      "qcms_bg.wasm",
      "LICENSE_OPENJPEG",
      "LICENSE_PDFJS_JBIG2",
      "LICENSE_QCMS",
    ]) {
      expect(ships(file), file).toBe(true);
    }
  });
});
