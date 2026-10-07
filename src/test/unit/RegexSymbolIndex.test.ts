import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import { RegexSymbolIndex } from "../../completions/RegexSymbolIndex";
import { LspSymbolKind } from "../../completions/SymbolIndex";

suite("RegexSymbolIndex", () => {
  test("uses Python indentation for exact declaration ranges", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "regex-symbol-python-")
    );
    try {
      await fs.writeFile(
        path.join(root, "example.py"),
        "class Example:\n    def run(self):\n        return True\n\nvalue = 1\n"
      );
      const index = new RegexSymbolIndex(root, async () => ["example.py"]);
      assert.deepStrictEqual(await index.documentSymbols("example.py"), [
        {
          name: "Example",
          kind: LspSymbolKind.Class,
          viewerPath: "example.py",
          startLine: 1,
          endLine: 3,
        },
        {
          name: "run",
          kind: LspSymbolKind.Function,
          viewerPath: "example.py",
          startLine: 2,
          endLine: 3,
        },
        {
          name: "value",
          kind: LspSymbolKind.Variable,
          viewerPath: "example.py",
          startLine: 5,
          endLine: 5,
        },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to the declaration line when a brace range is incomplete", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "regex-symbol-open-"));
    try {
      await fs.writeFile(
        path.join(root, "broken.ts"),
        "export function broken() {\n"
      );
      const index = new RegexSymbolIndex(root, async () => ["broken.ts"]);
      assert.deepStrictEqual(await index.documentSymbols("broken.ts"), [
        {
          name: "broken",
          kind: LspSymbolKind.Function,
          viewerPath: "broken.ts",
          startLine: 1,
          endLine: 1,
        },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("refreshes a cached file after its mtime changes", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "regex-symbol-cache-")
    );
    const filename = path.join(root, "symbols.ts");
    try {
      await fs.writeFile(filename, "export class Before {}\n");
      const index = new RegexSymbolIndex(root, async () => ["symbols.ts"]);
      assert.deepStrictEqual(
        (await index.workspaceSymbols("", 10)).map((symbol) => symbol.name),
        ["Before"]
      );
      await fs.writeFile(filename, "export class After {}\n");
      const changed = new Date(Date.now() + 2000);
      await fs.utimes(filename, changed, changed);
      assert.deepStrictEqual(
        (await index.workspaceSymbols("", 10)).map((symbol) => symbol.name),
        ["After"]
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
