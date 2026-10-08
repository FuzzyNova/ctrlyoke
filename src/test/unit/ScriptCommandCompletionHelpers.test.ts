import * as assert from "assert";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { suite, setup, teardown, test } from "mocha";
import {
  clearScriptCommandCompletionCache,
  getScriptCommandCompletions,
  parseScriptCompletionContext,
} from "../../completions/ScriptCommandCompletionHelpers";
import type {
  Disposable,
  FileWatcher,
  FileWatcherFactory,
  NamedRoot,
} from "../../core/HostPorts";

class TestFileWatcher implements FileWatcher {
  readonly changed: ((filePath: string) => void)[] = [];
  readonly created: ((filePath: string) => void)[] = [];
  readonly deleted: ((filePath: string) => void)[] = [];
  onDidCreate(listener: (filePath: string) => void): Disposable {
    this.created.push(listener);
    return { dispose: () => undefined };
  }
  onDidChange(listener: (filePath: string) => void): Disposable {
    this.changed.push(listener);
    return { dispose: () => undefined };
  }
  onDidDelete(listener: (filePath: string) => void): Disposable {
    this.deleted.push(listener);
    return { dispose: () => undefined };
  }
  dispose(): void {}
}

class TestFileWatcherFactory implements FileWatcherFactory {
  readonly created: {
    basePath: string;
    glob: string;
    watcher: TestFileWatcher;
  }[] = [];
  create(basePath: string, glob: string): FileWatcher {
    const watcher = new TestFileWatcher();
    this.created.push({ basePath, glob, watcher });
    return watcher;
  }
}

suite("ScriptCommandCompletionHelpers", () => {
  const roots: string[] = [];

  setup(() => {
    clearScriptCommandCompletionCache();
  });

  teardown(async () => {
    clearScriptCommandCompletionCache();
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true }))
    );
  });

  async function createWorkspace(packageJson?: string): Promise<string> {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "ctrlyoke-script-completions-")
    );
    roots.push(root);
    if (packageJson !== undefined) {
      await fs.writeFile(path.join(root, "package.json"), packageJson, "utf8");
    }
    return root;
  }

  function getCompletions(
    root: string | undefined,
    text: string,
    position: number,
    fileWatcherFactory?: FileWatcherFactory
  ) {
    const roots: readonly NamedRoot[] = root
      ? [{ name: path.basename(root), fsPath: root }]
      : [];
    return getScriptCommandCompletions(
      roots,
      text,
      position,
      fileWatcherFactory
    );
  }

  test("finds the replacement range for every documented segment shape", () => {
    const cases = [
      { text: "npm run te", expected: 8 },
      { text: "npm run ", expected: 8 },
      { text: "pnpm run ", expected: 9 },
      { text: "yarn run ", expected: 9 },
      { text: "npm run b", expected: 8 },
      { text: "npm te", expected: 0 },
      { text: "git st", expected: 0 },
      { text: "echo ok && npm r", expected: 11 },
    ];

    for (const { text, expected } of cases) {
      const context = parseScriptCompletionContext(text, text.length);
      assert.strictEqual(context.replacementStart, expected, text);
      assert.strictEqual(
        text.slice(context.replacementStart),
        context.beforeCursor.slice(
          context.replacementStart - context.commandStart
        ),
        text
      );
    }
  });

  test("completes npm, pnpm, and yarn forms from package scripts", async () => {
    const root = await createWorkspace(
      JSON.stringify({
        scripts: {
          test: "vitest run",
          "test:ui": "vitest run src/ui",
          build: "tsc -p .",
        },
      })
    );

    const npmRun = await getCompletions(root, "npm run te", 10);
    assert.deepStrictEqual(npmRun.map((item) => item.insertText).sort(), [
      "test",
      "test:ui",
    ]);
    assert.ok(
      npmRun.every((item) => item.detail?.startsWith("package.json script:"))
    );

    for (const [command, position] of [
      ["npm run ", 8],
      ["pnpm run ", 9],
      ["yarn run ", 9],
    ] as const) {
      const context = parseScriptCompletionContext(command, position);
      const suggestions = await getCompletions(root, command, position);
      assert.strictEqual(context.replacementStart, position, command);
      assert.ok(
        suggestions.some((item) => item.insertText === "build"),
        `${command} should offer package script names`
      );
    }

    const npm = await getCompletions(root, "npm ", 4);
    assert.ok(npm.some((item) => item.insertText === "npm test"));
    assert.ok(npm.some((item) => item.insertText === "npm run build"));

    const pnpm = await getCompletions(root, "pnpm ", 5);
    assert.ok(pnpm.some((item) => item.insertText === "pnpm build"));
    const yarn = await getCompletions(root, "yarn ", 5);
    assert.ok(yarn.some((item) => item.insertText === "yarn test"));
  });

  test("falls back to static commands without a workspace folder", async () => {
    const items = await getCompletions(undefined, "", 0);
    assert.ok(items.some((item) => item.insertText === "git status"));
    assert.ok(items.some((item) => item.insertText === "Test-Path "));
  });

  test("falls back to static commands when package.json is missing", async () => {
    const root = await createWorkspace();
    const items = await getCompletions(root, "", 0);
    assert.ok(items.some((item) => item.insertText === "npm install"));
    assert.ok(items.some((item) => item.insertText === "git status"));
  });

  test("ignores malformed package.json", async () => {
    const root = await createWorkspace("{ not valid json");
    const items = await getCompletions(root, "", 0);
    assert.ok(items.some((item) => item.insertText === "ls"));
    assert.ok(!items.some((item) => item.insertText === "npm run test"));
  });

  test("keeps package-manager base commands for an empty scripts object", async () => {
    const root = await createWorkspace(JSON.stringify({ scripts: {} }));
    const items = await getCompletions(root, "npm ", 4);
    assert.ok(items.some((item) => item.insertText === "npm install"));
    assert.ok(items.some((item) => item.insertText === "npm run "));
  });

  test("watches package.json under injected roots and invalidates cached scripts", async () => {
    const root = await createWorkspace(
      JSON.stringify({ scripts: { old: "old" } })
    );
    const factory = new TestFileWatcherFactory();
    await getCompletions(root, "npm run ", 8, factory);
    assert.strictEqual(factory.created.length, 1);
    assert.strictEqual(factory.created[0].basePath, path.resolve(root));
    assert.strictEqual(factory.created[0].glob, "**/package.json");

    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { fresh: "fresh" } }),
      "utf8"
    );
    factory.created[0].watcher.changed[0](path.join(root, "package.json"));
    const refreshed = await getCompletions(root, "npm run ", 8, factory);
    assert.ok(refreshed.some((item) => item.insertText === "fresh"));
  });

  test("deprioritizes destructive commands", async () => {
    const items = await getCompletions(undefined, "", 0);
    const safe = items.find((item) => item.insertText === "git status");
    const destructive = items.find((item) => item.insertText === "git clean ");
    assert.ok(safe?.sortText);
    assert.ok(destructive?.sortText);
    assert.ok(destructive.sortText > safe.sortText);
  });
});
