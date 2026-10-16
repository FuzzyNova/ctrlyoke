import * as assert from "assert";
import { suite, test } from "mocha";
import { fuzzyMatches, rankByFuzzyQuery, scoreFuzzyQuery } from "../../completions/FuzzyRanking";
import { WorkspacePathQuery } from "../../completions/WorkspacePathQuery";
import { WorkspacePathStore, type WorkspacePathEntry } from "../../completions/WorkspacePathStore";
import { WORKSPACE_ENTRY_KINDS } from "../../types/DashboardConstants";

function create(files: string[]): { store: WorkspacePathStore; query: WorkspacePathQuery } {
  const store = new WorkspacePathStore();
  store.replaceAll(files);
  return { store, query: new WorkspacePathQuery(store) };
}

const keys = [(entry: WorkspacePathEntry) => entry.name, (entry: WorkspacePathEntry) => entry.relativePath];

suite("WorkspacePathQuery", () => {
  test("matches camelCase gaps and ranks before applying the cap", async () => {
    const noise = Array.from({ length: 600 }, (_, i) => `aaa/editor-fixtures/case${i}.ts`);
    const { query } = create([...noise, "zzz/ui/components/editor/CodeMirrorEditor.tsx"]);
    const results = await query.queryFiles("codemirroreditor", { limit: 20 });
    assert.strictEqual(results[0]?.relativePath, "zzz/ui/components/editor/CodeMirrorEditor.tsx");
    assert.strictEqual(results[0]?.rank, 0);
    assert.ok(results.length <= 20);
  });

  test("preserves tied store order and puts directories before files for an empty query", async () => {
    const files = ["zzz/visible/SKILL.md", "aaa/ignored/one/SKILL.md", "aaa/ignored/two/SKILL.md", "README.md"];
    const { query } = create(files);
    const ranked = await query.queryFiles("SKILL.md");
    assert.deepStrictEqual(ranked.filter((item) => item.kind === "file").map((item) => item.relativePath), files.slice(0, 3));
    const empty = await query.queryFiles("");
    assert.deepStrictEqual(empty.slice(0, 2).map((item) => item.relativePath), ["zzz/visible", "zzz"]);
    assert.ok(empty.findIndex((item) => item.kind === "file") > 0);
  });

  test("returns only direct children in a scoped query", async () => {
    const { query } = create([
      "src/ui/editor/CodeMirrorEditor.tsx",
      "src/ui/editor/CodeMirrorTheme.ts",
      "src/ui/editor/commands/CommandPalette.tsx",
      "src/ui/workflow/Picker.tsx",
    ]);
    const scoped = await query.queryFiles("src/ui/editor/Co");
    assert.ok(scoped.some((item) => item.relativePath === "src/ui/editor/CodeMirrorEditor.tsx"));
    assert.ok(scoped.some((item) => item.relativePath === "src/ui/editor/commands"));
    assert.ok(!scoped.some((item) => item.relativePath.includes("CommandPalette")));
    assert.ok(!scoped.some((item) => item.relativePath.includes("Picker")));
    assert.deepStrictEqual(
      (await query.queryFiles("src/ui/editor/cme")).map((item) => item.relativePath),
      ["src/ui/editor/CodeMirrorEditor.tsx", "src/ui/editor/CodeMirrorTheme.ts"]
    );
  });

  test("matches prompt files by path, extension and fuzzy child name", async () => {
    const { query } = create([
      "prompts/seed.prompt.md", "prompts/setup.prompt.md", "prompts/sub/section.prompt.md",
      "docs/seed.md", "notes/readme.md",
    ]);
    assert.deepStrictEqual(
      (await query.queryPromptFiles("./prompts/se")).map((item) => item.relativePath),
      ["prompts/seed.prompt.md", "prompts/setup.prompt.md"]
    );
    assert.deepStrictEqual(
      (await query.queryPromptFiles("./prompts/stpm")).map((item) => item.relativePath),
      ["prompts/setup.prompt.md"]
    );
    assert.ok((await query.queryPromptFiles("")).every((item) => item.kind === WORKSPACE_ENTRY_KINDS.FILE));
  });

  test("suggests paths in the same-directory and prefix tiers", async () => {
    const { query } = create([
      "src/ui/editor/CodeMirrorEditor.tsx",
      "src/ui/other/CodeMirrorEditor.tsx",
      "src/ui/editor/commands",
    ]);
    const suggestions = await query.suggestPaths("src/ui/editor/CodeMirrorEdito", WORKSPACE_ENTRY_KINDS.FILE, 3);
    assert.deepStrictEqual(suggestions.map((item) => item.relativePath), [
      "src/ui/editor/CodeMirrorEditor.tsx", "src/ui/other/CodeMirrorEditor.tsx",
    ]);
  });

  test("narrowing returns the same results as a fresh full scan", async () => {
    const files = [
      "src/completions/CompletionCore.ts", "src/completions/ContextReferenceBuilder.ts",
      "src/completions/FuzzyRanking.ts", "src/completions/WorkspacePathQuery.ts",
      "src/test/unit/CompletionCore.test.ts",
    ];
    const { query } = create(files);
    await query.queryFiles("com");
    assert.deepStrictEqual(await query.queryFiles("comp"), await create(files).query.queryFiles("comp"));
  });

  test("reports progress on a large scan and aborts at a chunk boundary", async () => {
    const { query } = create(Array.from({ length: 100_000 }, (_, i) => `generated/file-${i}.ts`));
    const controller = new AbortController();
    let progress = 0;
    const results = await query.queryFiles("file", {
      limit: 10,
      signal: controller.signal,
      onProgress: () => { progress++; controller.abort(); },
    });
    assert.ok(progress > 0);
    assert.ok(results.length <= 10);
  });

  test("scorer and query match rankByFuzzyQuery, including multi-word queries", async () => {
    let seed = 91_721;
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
      return seed / 0x80000000;
    };
    const parts = ["CodeMirrorEditor", "WorkspacePathQuery", "CompletionCore", "PromptFilePicker", "FuzzyRanking"];
    const files = Array.from({ length: 80 }, (_, i) =>
      `src/${i % 5 === 0 ? "prompt files" : "completions"}/${parts[Math.floor(random() * parts.length)]}${i}.ts`
    );
    const { store, query } = create(files);
    for (const search of ["cme", "workspacepath", "completion core", "path query", "prompt files", "fuzzy ranking"]) {
      const expected = rankByFuzzyQuery(search, store.entries, keys).map((entry) => entry.relativePath);
      const scored = store.entries
        .map((entry, position) => ({
          entry,
          position,
          score: scoreFuzzyQuery(search, entry, keys),
        }))
        .filter((match) => match.score !== undefined)
        .sort((a, b) => b.score! - a.score! || a.position - b.position)
        .map(({ entry }) => entry.relativePath);
      assert.deepStrictEqual(scored, expected, `scorer parity for ${search}`);
      const actual = (await query.queryFiles(search, { limit: 500 })).map((item) => item.relativePath);
      assert.deepStrictEqual(actual, expected, `parity for ${search}`);
      for (const entry of store.entries) {
        const expectedMatch = rankByFuzzyQuery(search, [entry], keys).length > 0;
        assert.strictEqual(scoreFuzzyQuery(search, entry, keys) !== undefined, expectedMatch);
      }
    }
    assert.ok(fuzzyMatches("CodeMirrorEditor", "code editor"));
  });
});
