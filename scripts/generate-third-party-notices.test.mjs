import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { PDFJS_STATIC_DIRS } from "../src/ui/webview-react/build/pdfjsStaticAssets.ts";
import {
  bundledLicenseMismatches,
  declaredLicense,
  extractCopyright,
  groupLicenseTexts,
  licenseFileNames,
  normalizeLicenseText,
  packageAuthors,
  shippedPdfjsLicenseFiles,
} from "./generate-third-party-notices.mjs";

const ROOT_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const PDFJS_DIR = path.join(ROOT_DIR, "node_modules/pdfjs-dist");

test("the build never ships the GPL-2.0 Liberation fonts or unused Foxit fonts", () => {
  const fonts = PDFJS_STATIC_DIRS.find((d) => d.dir === "standard_fonts");
  const shipped = fs
    .readdirSync(path.join(PDFJS_DIR, "standard_fonts"))
    .filter((file) => fonts.ships(file))
    .sort();
  assert.deepEqual(shipped, [
    "FoxitDingbats.pfb",
    "FoxitSymbol.pfb",
    "LICENSE_FOXIT",
  ]);
  assert.ok(
    !shippedPdfjsLicenseFiles(PDFJS_DIR, PDFJS_STATIC_DIRS).includes(
      "standard_fonts/LICENSE_LIBERATION"
    )
  );
});

test("bundledLicenseMismatches reports unclaimed and unshipped licenses", () => {
  assert.deepEqual(bundledLicenseMismatches(["a/LICENSE"], ["a/LICENSE"]), []);
  const mismatches = bundledLicenseMismatches(["a/LICENSE"], ["b/LICENSE"]);
  assert.equal(mismatches.length, 2);
  assert.match(mismatches[0], /a\/LICENSE ships but no/);
  assert.match(mismatches[1], /b\/LICENSE is claimed .* but does not ship/);
});

test("extractCopyright takes the first real copyright line", () => {
  assert.equal(
    extractCopyright(
      "MIT License\n\nCopyright (c) 2021 Anthony Fu\n\ncopyright notice"
    ),
    "Copyright (c) 2021 Anthony Fu"
  );
  assert.equal(
    extractCopyright("// Copyright 2014 PDFium Authors"),
    "Copyright 2014 PDFium Authors"
  );
  assert.equal(
    extractCopyright(" * Copyright © 2019 Someone */"),
    "Copyright © 2019 Someone"
  );
});

test("extractCopyright skips template placeholders and license prose", () => {
  assert.equal(
    extractCopyright("   Copyright [yyyy] [name of copyright owner]"),
    undefined
  );
  assert.equal(
    extractCopyright("Copyright and Similar Rights means"),
    undefined
  );
  assert.equal(extractCopyright("2. Grant of Copyright License."), undefined);
});

test("licenseFileNames picks text license files, LICENSE first", () => {
  assert.deepEqual(
    licenseFileNames("x", [
      "README.md",
      "LICENSE-CODE",
      "LICENSE",
      "license-update.mjs",
      "index.js",
    ]),
    ["LICENSE", "LICENSE-CODE"]
  );
  assert.deepEqual(
    licenseFileNames("x", ["LICENSE_FOXIT", "Foxit.pfb", "COPYING.txt"]),
    ["COPYING.txt", "LICENSE_FOXIT"]
  );
  assert.deepEqual(licenseFileNames("dompurify", ["LICENSE", "LICENSE-MPL"]), [
    "LICENSE",
  ]);
});

test("declaredLicense reads string, legacy array and object forms", () => {
  assert.equal(declaredLicense({ license: "MIT" }), "MIT");
  assert.equal(
    declaredLicense({ licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }),
    "(MIT OR Apache-2.0)"
  );
  assert.equal(declaredLicense({ license: { type: "ISC" } }), "ISC");
  assert.equal(declaredLicense({}), "UNKNOWN");
});

test("packageAuthors falls back to contributors", () => {
  assert.equal(packageAuthors({ author: { name: "Ulf" } }), "Ulf");
  assert.equal(
    packageAuthors({ contributors: [{ name: "A" }, "B <b@x>"] }),
    "A, B <b@x>"
  );
  assert.equal(packageAuthors({}), undefined);
});

test("groupLicenseTexts groups identical normalized texts", () => {
  const text = normalizeLicenseText(
    String.fromCharCode(0xfeff) + "MIT  \r\nbody\r\n\r\n"
  );
  assert.equal(text, "MIT\nbody");
  const groups = groupLicenseTexts([
    { label: "a@1", license: "MIT", licenseText: text },
    { label: "b@1", license: "MPL-2.0", note: "No license text file" },
    { label: "c@1", license: "MIT", licenseText: text },
  ]);
  assert.deepEqual(
    groups.map((g) => g.labels),
    [["a@1", "c@1"], ["b@1"]]
  );
});

test(".vscodeignore ships the pdf.js worker and data the notices cite", () => {
  const lines = fs
    .readFileSync(path.join(ROOT_DIR, ".vscodeignore"), "utf8")
    .replace(/\r\n/g, "\n")
    .split("\n");
  for (const required of [
    "!out/ui/webview-react/assets/*.mjs",
    "!out/ui/webview-react/pdfjs/**",
  ]) {
    assert.ok(
      lines.includes(required),
      `.vscodeignore must include ${required}`
    );
  }
});
