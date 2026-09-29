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

    const npmRun = await getScriptCommandCompletions(root, "npm run te", 10);
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
      const suggestions = await getScriptCommandCompletions(
        root,
        command,
        position
      );
      assert.strictEqual(context.replacementStart, position, command);
      assert.ok(
        suggestions.some((item) => item.insertText === "build"),
        `${command} should offer package script names`
      );
    }

    const npm = await getScriptCommandCompletions(root, "npm ", 4);
    assert.ok(npm.some((item) => item.insertText === "npm test"));
    assert.ok(npm.some((item) => item.insertText === "npm run build"));

    const pnpm = await getScriptCommandCompletions(root, "pnpm ", 5);
    assert.ok(pnpm.some((item) => item.insertText === "pnpm build"));
    const yarn = await getScriptCommandCompletions(root, "yarn ", 5);
    assert.ok(yarn.some((item) => item.insertText === "yarn test"));
  });

  test("falls back to static commands without a workspace folder", async () => {
    const items = await getScriptCommandCompletions(undefined, "", 0);
    assert.ok(items.some((item) => item.insertText === "git status"));
    assert.ok(items.some((item) => item.insertText === "Test-Path "));
  });

  test("falls back to static commands when package.json is missing", async () => {
    const root = await createWorkspace();
    const items = await getScriptCommandCompletions(root, "", 0);
    assert.ok(items.some((item) => item.insertText === "npm install"));
    assert.ok(items.some((item) => item.insertText === "git status"));
  });

  test("ignores malformed package.json", async () => {
    const root = await createWorkspace("{ not valid json");
    const items = await getScriptCommandCompletions(root, "", 0);
    assert.ok(items.some((item) => item.insertText === "ls"));
    assert.ok(!items.some((item) => item.insertText === "npm run test"));
  });

  test("keeps package-manager base commands for an empty scripts object", async () => {
    const root = await createWorkspace(JSON.stringify({ scripts: {} }));
    const items = await getScriptCommandCompletions(root, "npm ", 4);
    assert.ok(items.some((item) => item.insertText === "npm install"));
    assert.ok(items.some((item) => item.insertText === "npm run "));
  });

  test("deprioritizes destructive commands", async () => {
    const items = await getScriptCommandCompletions(undefined, "", 0);
    const safe = items.find((item) => item.insertText === "git status");
    const destructive = items.find((item) => item.insertText === "git clean ");
    assert.ok(safe?.sortText);
    assert.ok(destructive?.sortText);
    assert.ok(destructive.sortText > safe.sortText);
  });
});
