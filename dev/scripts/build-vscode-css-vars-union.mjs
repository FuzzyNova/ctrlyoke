// One-off script: intersects the vars/vscode-css-vars-<theme>.json snapshots in
// dev/reference/ and writes dev/reference/vscode-css-vars-union.json containing
// only the CSS variable names defined in every snapshot, each mapped to its
// per-theme values. Used to find vars safe to depend on (with no fallback)
// across arbitrary VS Code themes when choosing chip colors.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const referenceDir = join(__dirname, "..", "reference");

const files = readdirSync(referenceDir).filter(
  (name) => /^vscode-css-vars-.*\.json$/.test(name) && name !== "vscode-css-vars-union.json"
);

if (files.length === 0) {
  throw new Error(`No vscode-css-vars-*.json snapshots found in ${referenceDir}`);
}

const themes = files.map((name) => {
  const theme = name.replace(/^vscode-css-vars-/, "").replace(/\.json$/, "");
  const data = JSON.parse(readFileSync(join(referenceDir, name), "utf8"));
  return { theme, vars: data.vars };
});

const [first, ...rest] = themes;
const sharedNames = Object.keys(first.vars).filter((name) =>
  rest.every((t) => Object.prototype.hasOwnProperty.call(t.vars, name))
);
sharedNames.sort();

const union = {};
for (const name of sharedNames) {
  union[name] = Object.fromEntries(themes.map((t) => [t.theme, t.vars[name]]));
}

const output = {
  generatedAt: new Date().toISOString(),
  sourceThemes: themes.map((t) => t.theme),
  count: sharedNames.length,
  vars: union,
};

const outPath = join(referenceDir, "vscode-css-vars-union.json");
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
console.log(`Wrote ${sharedNames.length} shared vars (of ${Object.keys(first.vars).length} in ${first.theme}) to ${outPath}`);
