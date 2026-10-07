import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test } from "mocha";

function listFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
  });
}

suite("Hosted default themes", () => {
  test("include every VS Code variable referenced by the webview", () => {
    const repositoryRoot = path.resolve(__dirname, "../../..");
    const sourceRoot = path.join(repositoryRoot, "src", "ui", "webview-react");
    const themeRoot = path.join(repositoryRoot, "src", "server", "themes");
    const references = new Set<string>();
    for (const file of listFiles(sourceRoot)) {
      if (/\.(?:png|jpe?g|gif|ico|ttf|woff2?)$/i.test(file)) continue;
      const contents = fs.readFileSync(file, "utf8");
      for (const match of contents.matchAll(/var\(\s*(--vscode-[\w.-]+)/g)) {
        references.add(match[1]);
      }
    }

    for (const themeName of [
      "vscode-default-dark.css",
      "vscode-default-light.css",
    ]) {
      const css = fs.readFileSync(path.join(themeRoot, themeName), "utf8");
      const declarations = new Set(
        [...css.matchAll(/^\s*(--vscode-[\w.-]+)\s*:/gm)].map(
          (match) => match[1]
        )
      );
      const missing = [...references].filter((name) => !declarations.has(name));
      assert.deepStrictEqual(missing, [], `${themeName} is missing variables`);
    }
  });
});
