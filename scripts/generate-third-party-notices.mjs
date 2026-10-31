#!/usr/bin/env node

/**
 * Generate THIRD_PARTY_NOTICES.md from the production dependency tree.
 *
 * The inventory comes from `npm ls --omit=dev --all`, with each package's
 * declared license, copyright line and license text read from its installed
 * files. Components that ship inside a package but carry their own licenses
 * (pdf.js's fonts, CMaps and WASM decoders) are listed in BUNDLED_COMPONENTS.
 * The hand-written sections (commercial distribution notes, attribution,
 * special attention) live in this file too, so the whole notice is generated.
 *
 * Usage:
 *   npm run notices:generate
 *   npm run check:notices        (fails when the notices are out of date)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Loaded with Node's type stripping (`--experimental-strip-types`).
import { PDFJS_STATIC_DIRS } from "../src/ui/webview-react/build/pdfjsStaticAssets.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");
const OUTPUT_PATH = resolve(ROOT_DIR, "THIRD_PARTY_NOTICES.md");
const PDFJS_DIR = resolve(ROOT_DIR, "node_modules/pdfjs-dist");

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);
const NOT_STATED = "Not stated in package metadata or license file";
const AUDIT_DATE_PLACEHOLDER = "{{AUDIT_DATE}}";

/** Files in a package root that hold its license text. */
const LICENSE_FILE_PATTERN = /^(licen[cs]e|copying)([-._][a-z0-9]+)*$/i;
const LICENSE_FILE_EXTENSIONS = new Set(["", ".md", ".txt", ".markdown"]);

/**
 * Packages whose license files must be narrowed. dompurify is dual-licensed
 * `(MPL-2.0 OR Apache-2.0)` and this distribution relies on the Apache option.
 */
const LICENSE_FILE_OVERRIDES = {
  dompurify: ["LICENSE"],
};

/** Licenses a package's license file states but its package.json omits. */
const DECLARED_LICENSE_OVERRIDES = {
  khroma: "MIT",
};

/** Copyright holders the package files do not state. */
const COPYRIGHT_OVERRIDES = {
  "@resvg/resvg-wasm": "resvg-js contributors",
};

/**
 * Standard texts used when a package declares a license but ships no license
 * file. `{{COPYRIGHT}}` is replaced by the package's copyright line.
 */
const LICENSE_TEMPLATES = {
  MIT: `MIT License

{{COPYRIGHT}}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
  "BSD-3-Clause": `BSD 3-Clause License

{{COPYRIGHT}}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
};

/**
 * Components that ship inside an npm package under their own licenses. pdf.js
 * keeps these in data directories that the webview build copies to
 * `out/ui/webview-react/pdfjs/`, filtered by `PDFJS_STATIC_DIRS`. Every license
 * file the build ships must be claimed here, and every claimed file must ship,
 * so a pdf.js upgrade or a copy-filter change fails generation instead of
 * shipping an undisclosed license or disclosing one we don't ship.
 *
 * Liberation Sans (GPL-2.0 with a font exception) is deliberately not shipped;
 * see `pdfjsStaticAssets.ts`. If it ever ships again, claim
 * `standard_fonts/LICENSE_LIBERATION` here and add it to Special Attention.
 */
const BUNDLED_COMPONENTS = [
  {
    name: "Adobe CMaps",
    shippedAs: "`pdfjs/cmaps/*.bcmap`",
    license: "BSD-3-Clause",
    copyright: "Copyright 1990-2009 Adobe Systems Incorporated",
    source: "https://github.com/adobe-type-tools/cmap-resources",
    licenseFiles: ["cmaps/LICENSE"],
  },
  {
    name: "Foxit Symbol and Dingbats fonts",
    shippedAs:
      "`pdfjs/standard_fonts/FoxitSymbol.pfb`, `pdfjs/standard_fonts/FoxitDingbats.pfb`",
    license: "BSD-3-Clause",
    copyright: "Copyright 2014 PDFium Authors",
    source: "https://pdfium.googlesource.com/pdfium/",
    licenseFiles: ["standard_fonts/LICENSE_FOXIT"],
  },
  {
    name: "CGATS001Compat ICC profile",
    shippedAs: "`pdfjs/iccs/CGATS001Compat-v2-micro.icc`",
    license: "CC0-1.0",
    copyright: "Dedicated to the public domain",
    source: "https://github.com/saucecontrol/Compact-ICC-Profiles",
    licenseFiles: ["iccs/LICENSE"],
  },
  {
    name: "OpenJPEG decoder",
    shippedAs:
      "`pdfjs/wasm/openjpeg.wasm`, `pdfjs/wasm/openjpeg_nowasm_fallback.js`",
    license: "BSD-2-Clause",
    copyright:
      "Copyright (c) 2002-2014, Universite catholique de Louvain (UCL), Belgium, and contributors; Copyright (c) 2024, Mozilla Foundation",
    source: "https://github.com/uclouvain/openjpeg",
    licenseFiles: ["wasm/LICENSE_OPENJPEG", "wasm/LICENSE_PDFJS_OPENJPEG"],
  },
  {
    name: "PDFium JBIG2 decoder",
    shippedAs: "`pdfjs/wasm/jbig2.wasm`, `pdfjs/wasm/jbig2_nowasm_fallback.js`",
    license: "BSD-3-Clause AND Apache-2.0",
    copyright:
      "Copyright 2014 The PDFium Authors; Copyright 2026 Mozilla Foundation",
    source: "https://pdfium.googlesource.com/pdfium/",
    licenseFiles: ["wasm/LICENSE_JBIG2", "wasm/LICENSE_PDFJS_JBIG2"],
  },
  {
    name: "qcms color management",
    shippedAs: "`pdfjs/wasm/qcms_bg.wasm`",
    license: "MIT",
    copyright:
      "Copyright (C) 2009-2024 Mozilla Corporation; Copyright (C) 1998-2007 Marti Maria",
    source: "https://github.com/FirefoxGraphics/qcms",
    licenseFiles: ["wasm/LICENSE_QCMS", "wasm/LICENSE_PDFJS_QCMS"],
  },
];

/** Hand-written top sections. `{{version:<name>}}` resolves from the inventory. */
const COMMERCIAL_DISTRIBUTION = `## Commercial Distribution

Commercial distribution is subject to the terms of each component license. The package inventory below includes production dependencies from \`package.json\` and transitive dependencies, including packages incorporated into the extension and webview bundles.

- \`elkjs\` is licensed under EPL-2.0 and is included in the Mermaid ELK layout chunk in the webview bundle. See [Special Attention](#special-attention).
- \`@resvg/resvg-wasm\` is licensed under MPL-2.0; source: <https://github.com/yisibl/resvg-js/tree/main/packages/resvg-wasm>. It is shipped in \`out/runtime-deps/\` as an isolated runtime package.
- \`dompurify\` is dual-licensed \`(MPL-2.0 OR Apache-2.0)\`; this distribution relies on the Apache-2.0 option.
- \`pdfjs-dist\` (pdf.js) is licensed under Apache-2.0 and renders PDFs in the hosted workspace viewer. pdf.js does not ship a \`NOTICE\` file. Its worker keeps its license header, and the full Apache-2.0 text is reproduced in [License Texts](#license-texts). Its fonts, CMaps, ICC profile and image decoders are separately licensed; see [Bundled Components](#bundled-components). The GPL-2.0 Liberation Sans fonts in the \`pdfjs-dist\` package are not shipped.`;

const ATTRIBUTION = `## Attribution

### @vscode/codicons

- Version: \`{{version:@vscode/codicons}}\`
- License: \`CC-BY-4.0\`
- Copyright: Microsoft Corporation
- Source: <https://github.com/microsoft/vscode-codicons>
- License text: <https://creativecommons.org/licenses/by/4.0/>

### @resvg/resvg-wasm

- License: \`MPL-2.0\`
- Copyright: resvg-js contributors
- Source: <https://github.com/yisibl/resvg-js/tree/main/packages/resvg-wasm>
- License text: <https://www.mozilla.org/en-US/MPL/2.0/>

### pdfjs-dist (pdf.js)

- Version: \`{{version:pdfjs-dist}}\`
- License: \`Apache-2.0\`
- Copyright: Mozilla Foundation
- Source: <https://github.com/mozilla/pdf.js>
- License text: <https://www.apache.org/licenses/LICENSE-2.0>`;

const SPECIAL_ATTENTION = `## Special Attention

| Package | Version | License | Copyright | Source |
| --- | --- | --- | --- | --- |
| \`elkjs\` | \`{{version:elkjs}}\` | \`EPL-2.0\` | Ulf Rüegg | <https://github.com/kieler/elkjs> |

EPL-2.0 license: <https://www.eclipse.org/legal/epl-2.0/>`;

const NOTES = `## Notes

- This file is a dependency audit and notice record, not legal advice.
- This file is generated by \`npm run notices:generate\`. Regenerate and review it before every release when production dependencies or shipped bundles change; \`npm run check:notices\` fails when it is out of date.`;

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/** @returns {{ name: string, version: string, dir: string }[]} */
function collectProductionPackages(rootDir) {
  const raw = execFileSync(
    "npm",
    ["ls", "--omit=dev", "--all", "--json", "--long"],
    {
      cwd: rootDir,
      shell: process.platform === "win32",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }
  ).toString();
  const tree = JSON.parse(raw);
  const packages = new Map();
  const walk = (node) => {
    for (const [name, dep] of Object.entries(node.dependencies ?? {})) {
      if (!dep.path || dep.missing || !existsSync(dep.path)) continue;
      const key = `${name}@${dep.version}`;
      if (packages.has(key)) continue;
      packages.set(key, { name, version: dep.version, dir: dep.path });
      walk(dep);
    }
  };
  walk(tree);
  return [...packages.values()];
}

function readPackageJson(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/**
 * Platform-specific native binaries (packages declaring `os` or `cpu`) are
 * optional, never shipped, and installed only on matching machines; listing
 * them would make the notices differ per platform.
 */
function isPlatformSpecific(packageJson) {
  return Boolean(packageJson.os || packageJson.cpu);
}

export function declaredLicense(packageJson) {
  const value = packageJson.license ?? packageJson.licenses;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const types = value.map((entry) => entry.type ?? entry).filter(Boolean);
    return types.length > 1
      ? `(${types.join(" OR ")})`
      : (types[0] ?? "UNKNOWN");
  }
  if (value && typeof value === "object" && value.type) return value.type;
  return "UNKNOWN";
}

export function licenseFileNames(name, fileNames) {
  if (LICENSE_FILE_OVERRIDES[name]) return LICENSE_FILE_OVERRIDES[name];
  return fileNames
    .filter((file) => {
      const dot = file.lastIndexOf(".");
      const ext = dot > 0 ? file.slice(dot).toLowerCase() : "";
      const base = LICENSE_FILE_EXTENSIONS.has(ext)
        ? file.slice(0, file.length - ext.length)
        : file;
      return (
        LICENSE_FILE_EXTENSIONS.has(ext) && LICENSE_FILE_PATTERN.test(base)
      );
    })
    .sort(
      (a, b) => licenseFileRank(a) - licenseFileRank(b) || compareText(a, b)
    );
}

/** The plain `LICENSE` file leads, so a package's main license is shown first. */
function licenseFileRank(file) {
  return /^licen[cs]e(\.(md|txt|markdown))?$/i.test(file) ? 0 : 1;
}

export function normalizeLicenseText(text) {
  return text
    .replace(new RegExp(`^${BYTE_ORDER_MARK}`), "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

const COPYRIGHT_LINE =
  /^[\s#/*%;-]*(copyright\s+(?:\(c\)|©|\d{4}|by\s)[^\n]*)$/im;
const TEMPLATE_PLACEHOLDER = /\[yyyy\]|\{yyyy\}|<year>|\[year\]/i;

/** The first real copyright line of a license text, without comment markers. */
export function extractCopyright(text) {
  for (const line of text.split("\n")) {
    const match = COPYRIGHT_LINE.exec(line);
    if (match && !TEMPLATE_PLACEHOLDER.test(match[1])) {
      return match[1].replace(/\s*\*\/\s*$/, "").trim();
    }
  }
  return undefined;
}

export function authorName(author) {
  if (!author) return undefined;
  if (typeof author === "string") return author.trim() || undefined;
  return author.name?.trim() || undefined;
}

/** The package's author, or else its contributors' names. */
export function packageAuthors(packageJson) {
  const author = authorName(packageJson.author);
  if (author) return author;
  const contributors = (packageJson.contributors ?? [])
    .map(authorName)
    .filter(Boolean);
  return contributors.length ? contributors.join(", ") : undefined;
}

function describePackage({ name, version, dir }) {
  const packageJson = readPackageJson(dir);
  if (isPlatformSpecific(packageJson)) return undefined;
  const license =
    DECLARED_LICENSE_OVERRIDES[name] ?? declaredLicense(packageJson);
  const files = licenseFileNames(name, readdirSync(dir));
  const texts = files.map((file) =>
    normalizeLicenseText(readFileSync(join(dir, file), "utf8"))
  );
  const copyright =
    COPYRIGHT_OVERRIDES[name] ??
    texts.map(extractCopyright).find(Boolean) ??
    packageAuthors(packageJson) ??
    NOT_STATED;
  let licenseText = texts.join("\n\n");
  let note;
  if (!licenseText) {
    const template = LICENSE_TEMPLATES[license];
    if (template) {
      const line = /^copyright\b/i.test(copyright)
        ? copyright
        : `Copyright (c) ${copyright}`;
      licenseText = template.replace("{{COPYRIGHT}}", line);
    } else {
      note = `No license text file was present in the package. Declared license: \`${license}\`.`;
    }
  }
  return {
    label: `${name}@${version}`,
    name,
    version,
    license,
    copyright,
    licenseText,
    note,
  };
}

/** The `<dir>/<file>` license files the webview build copies out of pdfjs-dist. */
export function shippedPdfjsLicenseFiles(pdfjsDir, staticDirs) {
  return staticDirs.flatMap(({ dir, ships }) =>
    licenseFileNames("", readdirSync(join(pdfjsDir, dir)))
      .filter((file) => ships?.(file) ?? true)
      .map((file) => `${dir}/${file}`)
  );
}

/** Mismatches between the license files the build ships and those claimed. */
export function bundledLicenseMismatches(shipped, claimed) {
  const shippedSet = new Set(shipped);
  const claimedSet = new Set(claimed);
  return [
    ...shipped
      .filter((file) => !claimedSet.has(file))
      .map(
        (file) =>
          `pdfjs-dist/${file} ships but no BUNDLED_COMPONENTS entry claims it`
      ),
    ...claimed
      .filter((file) => !shippedSet.has(file))
      .map(
        (file) =>
          `pdfjs-dist/${file} is claimed in BUNDLED_COMPONENTS but does not ship`
      ),
  ];
}

function describeBundledComponents(pdfjsDir) {
  const mismatches = bundledLicenseMismatches(
    shippedPdfjsLicenseFiles(pdfjsDir, PDFJS_STATIC_DIRS),
    BUNDLED_COMPONENTS.flatMap((c) => c.licenseFiles)
  );
  if (mismatches.length) {
    throw new Error(
      `${mismatches.join("\n")}\nUpdate BUNDLED_COMPONENTS in scripts/generate-third-party-notices.mjs.`
    );
  }
  return BUNDLED_COMPONENTS.map((component) => ({
    ...component,
    label: `pdfjs-dist: ${component.name}`,
    licenseText: component.licenseFiles
      .map((file) =>
        normalizeLicenseText(readFileSync(join(pdfjsDir, file), "utf8"))
      )
      .join("\n\n"),
  }));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function escapeCell(value) {
  return String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ");
}

function fence(text) {
  const longest = Math.max(
    2,
    ...(text.match(/`+/g) ?? []).map((run) => run.length)
  );
  return "`".repeat(longest + 1);
}

/**
 * Groups entries whose license text is identical, in first-appearance order.
 * Entries without text keep a group of their own with their note.
 */
export function groupLicenseTexts(entries) {
  const groups = [];
  const byText = new Map();
  for (const entry of entries) {
    if (!entry.licenseText) {
      groups.push({
        license: entry.license,
        labels: [entry.label],
        note: entry.note,
      });
      continue;
    }
    let group = byText.get(entry.licenseText);
    if (!group) {
      group = { license: entry.license, labels: [], text: entry.licenseText };
      byText.set(entry.licenseText, group);
      groups.push(group);
    }
    group.labels.push(entry.label);
  }
  return groups;
}

function resolveVersions(template, versions) {
  return template.replace(/\{\{version:([^}]+)\}\}/g, (_, name) => {
    const version = versions.get(name);
    if (!version) throw new Error(`No production package named ${name}`);
    return version;
  });
}

export function renderNotices(packages, components) {
  const versions = new Map(packages.map((p) => [p.name, p.version]));
  const lines = [
    "# Third-Party Notices",
    "",
    `This product includes third-party software and assets. This inventory was audited on **${AUDIT_DATE_PLACEHOLDER}** from the production dependency tree and the extension and webview bundles shipped in the VSIX.`,
    "",
    resolveVersions(COMMERCIAL_DISTRIBUTION, versions),
    "",
    resolveVersions(ATTRIBUTION, versions),
    "",
    resolveVersions(SPECIAL_ATTENTION, versions),
    "",
    "## Production Dependency Inventory",
    "",
    `The production dependency tree contains **${packages.length} packages**. Each package is listed with its installed version, declared license, and copyright line. Full license texts are grouped below only when the package files contain identical text.`,
    "",
    "| Package | Version | License | Copyright |",
    "| --- | --- | --- | --- |",
    ...packages.map(
      (p) =>
        `| \`${p.name}\` | \`${p.version}\` | \`${escapeCell(p.license)}\` | ${escapeCell(p.copyright)} |`
    ),
    "",
    "## Bundled Components",
    "",
    `\`pdfjs-dist\` ships these components under their own licenses. The webview build copies them, with their license files, to \`out/ui/webview-react/pdfjs/\`.`,
    "",
    "| Component | Shipped as | License | Copyright | Source |",
    "| --- | --- | --- | --- | --- |",
    ...components.map(
      (c) =>
        `| ${escapeCell(c.name)} | ${escapeCell(c.shippedAs)} | \`${escapeCell(c.license)}\` | ${escapeCell(c.copyright)} | <${c.source}> |`
    ),
    "",
    "## License Texts",
    "",
    "The following texts are reproduced from the production package contents. Packages sharing byte-identical license text are grouped together.",
    "",
  ];
  groupLicenseTexts([...packages, ...components]).forEach((group, index) => {
    lines.push(`### License text ${index + 1}: ${group.license}`, "");
    lines.push(`Packages: ${group.labels.join(", ")}`, "");
    if (group.note) {
      lines.push(group.note, "");
    } else {
      const marker = fence(group.text);
      lines.push(`${marker}text`, group.text, marker, "");
    }
  });
  lines.push(NOTES, "");
  return lines.join("\n");
}

async function formatMarkdown(markdown) {
  const prettier = await import("prettier");
  const options = (await prettier.resolveConfig(OUTPUT_PATH)) ?? {};
  return prettier.format(markdown, { ...options, filepath: OUTPUT_PATH });
}

const AUDIT_DATE_PATTERN = /audited on \*\*(\d{4}-\d{2}-\d{2})\*\*/;

/** Keeps the existing audit date when nothing else changed. */
function applyAuditDate(rendered, existing) {
  const previousDate = existing?.match(AUDIT_DATE_PATTERN)?.[1];
  if (
    previousDate &&
    rendered.replace(AUDIT_DATE_PLACEHOLDER, previousDate) === existing
  ) {
    return existing;
  }
  return rendered.replace(
    AUDIT_DATE_PLACEHOLDER,
    new Date().toISOString().slice(0, 10)
  );
}

async function main() {
  const checkMode = process.argv.includes("--check");
  const packages = collectProductionPackages(ROOT_DIR)
    .map(describePackage)
    .filter(Boolean)
    .sort(
      (a, b) => compareText(a.name, b.name) || compareText(a.version, b.version)
    );
  const components = describeBundledComponents(PDFJS_DIR);
  const rendered = await formatMarkdown(renderNotices(packages, components));
  const existing = existsSync(OUTPUT_PATH)
    ? readFileSync(OUTPUT_PATH, "utf8").replace(/\r\n/g, "\n")
    : undefined;
  const output = applyAuditDate(rendered, existing);

  if (checkMode) {
    if (output !== existing) {
      console.error(
        "THIRD_PARTY_NOTICES.md is out of date with the production dependency tree. Run `npm run notices:generate` and review the result."
      );
      process.exit(1);
    }
    console.log("THIRD_PARTY_NOTICES.md is up to date.");
    return;
  }
  writeFileSync(OUTPUT_PATH, output);
  console.log(
    `Wrote THIRD_PARTY_NOTICES.md (${packages.length} packages, ${components.length} bundled components).`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
