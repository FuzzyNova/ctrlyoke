import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, setup, teardown, test } from "mocha";
import { PromptLinkProvider } from "../../completions/PromptLinkProvider";
import { SkillDiscovery, type SkillInfo } from "../../utils/SkillDiscovery";
import { pathsEqual } from "../../utils/PathCasing";
import { PromptDocumentStub } from "../helpers/PromptDocumentStub";
import { snapshotProperty } from "../helpers/propertySnapshot";

suite("PromptLinkProvider slash-token links", () => {
  const restoreWorkspaceFolders = snapshotProperty(
    vscode.workspace,
    "workspaceFolders"
  );
  const originalDiscoverSkills = SkillDiscovery.discoverSkills;
  const workspaceRoot = path.join(os.tmpdir(), "ctrlyoke-prompt-links");
  const skillPath = path.join(
    workspaceRoot,
    ".ctrlyoke",
    "skills",
    "commit",
    "SKILL.md"
  );

  setup(() => {
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      value: [
        {
          name: "workspace",
          uri: vscode.Uri.file(workspaceRoot),
          index: 0,
        },
      ],
      configurable: true,
    });
    const skill: SkillInfo = {
      name: "commit",
      displayName: "Commit",
      path: skillPath,
      description: "Create a focused commit",
      source: "workspace",
    };
    SkillDiscovery.discoverSkills = async () => [skill];
  });

  teardown(() => {
    restoreWorkspaceFolders();
    SkillDiscovery.discoverSkills = originalDiscoverSkills;
  });

  test("links explicit skills while leaving native slash commands alone", async () => {
    const text = "/skill:commit /commit /mcp";
    const document = new PromptDocumentStub(
      path.join(workspaceRoot, "prompt.prompt.md"),
      "markdown",
      text
    ).asDocument();

    const links = await new PromptLinkProvider().provideDocumentLinks(
      document,
      {} as vscode.CancellationToken
    );

    assert.ok(links);
    assert.strictEqual(links.length, 1);
    assert.ok(
      links[0].target && pathsEqual(links[0].target.fsPath, skillPath),
      `expected ${links[0].target?.fsPath} to resolve to ${skillPath}`
    );
    assert.strictEqual(links[0].tooltip, "Open ctrlyoke skill commit");
    assert.strictEqual(links[0].range.start.character, 0);
    assert.strictEqual(links[0].range.end.character, "/skill:commit".length);
  });

  test("links secret references to the Secrets settings page", async () => {
    const text = "Use !SERVICE_TOKEN here";
    const document = new PromptDocumentStub(
      path.join(workspaceRoot, "prompt.prompt.md"),
      "markdown",
      text
    ).asDocument();

    const links = await new PromptLinkProvider().provideDocumentLinks(
      document,
      {} as vscode.CancellationToken
    );

    assert.ok(links);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].target?.scheme, "command");
    assert.strictEqual(links[0].target?.path, "ctrlyoke.openSecretsSettings");
    assert.strictEqual(links[0].tooltip, "Open ctrlyoke Secrets settings");
  });

  test("links symbol references with definition-relative paths", async () => {
    const text = "#sym:./a.ts:foo:1-5";
    const document = new PromptDocumentStub(
      path.join(workspaceRoot, "workflow.ctrlyoke.yaml"),
      "yaml",
      `steps:\n  - prompt: "${text}"`
    ).asDocument();

    const links = await new PromptLinkProvider().provideDocumentLinks(
      document,
      {} as vscode.CancellationToken
    );

    assert.ok(links);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].target?.scheme, "command");
    assert.strictEqual(links[0].target?.path, "ctrlyoke.openFileWithSelection");
    assert.ok(links[0].target?.query.includes("a.ts"));
  });

  test("reveals a directory reference through ctrlyoke's own command", async () => {
    const text = "Look in @src/editor/";
    const document = new PromptDocumentStub(
      path.join(workspaceRoot, "prompt.prompt.md"),
      "markdown",
      text
    ).asDocument();

    const links = await new PromptLinkProvider().provideDocumentLinks(
      document,
      {} as vscode.CancellationToken
    );

    assert.ok(links);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].target?.scheme, "command");
    assert.strictEqual(links[0].target?.path, "ctrlyoke.revealDirectory");
    // `revealInExplorer` ignores a JSON URI string and reveals the active
    // editor's file instead, so the argument is a path for our command.
    const args = JSON.parse(links[0].target?.query ?? "") as { path: string };
    assert.ok(
      pathsEqual(args.path, path.join(workspaceRoot, "src", "editor")),
      `expected ${args.path} to be the referenced directory`
    );
  });

  test("gives a file reference one link, not one for its folder too", async () => {
    const text = "Open @src/editor/CodeMirrorEditor.tsx and @src/editor/";
    const document = new PromptDocumentStub(
      path.join(workspaceRoot, "prompt.prompt.md"),
      "markdown",
      text
    );

    const links =
      (await new PromptLinkProvider().provideDocumentLinks(
        document.asDocument(),
        {} as vscode.CancellationToken
      )) ?? [];

    assert.deepStrictEqual(
      links.map((link) =>
        text.slice(
          document.offsetAt(link.range.start),
          document.offsetAt(link.range.end)
        )
      ),
      ["@src/editor/CodeMirrorEditor.tsx", "@src/editor/"]
    );
  });

  test("resolves scanned references with their existing ranges and targets", async () => {
    const text = [
      "@src/plain.ts",
      '@"src/quoted file.ts"',
      "@src/editor/CodeMirrorEditor.tsx",
      "@src/plain-directory/",
      '@"src/quoted directory/"',
      "#selection:src/plain.ts:10-20",
      '#selection:"src/quoted file.ts":21-30',
      '#sym.type-parameter:"src/my utils.ts":"get value":31-40',
    ].join(" | ");
    const document = new PromptDocumentStub(
      path.join(workspaceRoot, "prompt.prompt.md"),
      "markdown",
      text
    );

    const links =
      (await new PromptLinkProvider().provideDocumentLinks(
        document.asDocument(),
        {} as vscode.CancellationToken
      )) ?? [];
    const linkTexts = links.map((link) =>
      text.slice(
        document.offsetAt(link.range.start),
        document.offsetAt(link.range.end)
      )
    );

    assert.deepStrictEqual(linkTexts, [
      '@"src/quoted file.ts"',
      "@src/plain.ts",
      "@src/editor/CodeMirrorEditor.tsx",
      '@"src/quoted directory/"',
      "@src/plain-directory/",
      "#selection:src/plain.ts:10-20",
      '#selection:"src/quoted file.ts":21-30',
      '#sym.type-parameter:"src/my utils.ts":"get value":31-40',
    ]);

    for (const [index, relativePath] of [
      [0, "src/quoted file.ts"],
      [1, "src/plain.ts"],
      [2, "src/editor/CodeMirrorEditor.tsx"],
    ] as const) {
      assert.strictEqual(
        pathsEqual(
          links[index].target?.fsPath ?? "",
          path.join(workspaceRoot, relativePath)
        ),
        true
      );
    }

    for (const [index, relativePath] of [
      [3, "src/quoted directory"],
      [4, "src/plain-directory"],
    ] as const) {
      const link = links[index];
      assert.strictEqual(link.target?.path, "ctrlyoke.revealDirectory");
      const args = JSON.parse(link.target?.query ?? "") as { path: string };
      assert.ok(pathsEqual(args.path, path.join(workspaceRoot, relativePath)));
    }

    for (const [index, relativePath, startLine, endLine] of [
      [5, "src/plain.ts", 10, 20],
      [6, "src/quoted file.ts", 21, 30],
      [7, "src/my utils.ts", 31, 40],
    ] as const) {
      const target = links[index].target;
      assert.strictEqual(target?.path, "ctrlyoke.openFileWithSelection");
      const args = JSON.parse(target?.query ?? "") as {
        uri: string;
        startLine: number;
        endLine: number;
      };
      assert.ok(
        pathsEqual(
          vscode.Uri.parse(args.uri).fsPath,
          path.join(workspaceRoot, relativePath)
        )
      );
      assert.strictEqual(args.startLine, startLine);
      assert.strictEqual(args.endLine, endLine);
    }
    assert.strictEqual(
      links[7].tooltip,
      "Go to get value in src/my utils.ts:31-40"
    );
  });

  test("scans decoded workflow prompt spans and maps links to source", async () => {
    const cases = [
      {
        file: "w.ctrlyoke.json",
        language: "json",
        text: String.raw`{"prompt":"@src/a.ts\nnext and @\"docs/my file.md\""}`,
        expected: ['@\\"docs/my file.md\\"', "@src/a.ts"],
      },
      {
        file: "w.ctrlyoke.yaml",
        language: "yaml",
        text: 'prompt: "Read @\\"my dir/a.ts\\" now"',
        expected: ['@\\"my dir/a.ts\\"'],
      },
      {
        file: "w.ctrlyoke.yaml",
        language: "yaml",
        text: "prompt: Review @src/a.ts # comment @src/b.ts",
        expected: ["@src/a.ts"],
      },
    ];

    for (const { file, language, text, expected } of cases) {
      const document = new PromptDocumentStub(
        path.join(workspaceRoot, file),
        language,
        text
      );
      const links =
        (await new PromptLinkProvider().provideDocumentLinks(
          document.asDocument(),
          {} as vscode.CancellationToken
        )) ?? [];
      assert.deepStrictEqual(
        links.map((link) =>
          text.slice(
            document.offsetAt(link.range.start),
            document.offsetAt(link.range.end)
          )
        ),
        expected
      );
    }
  });

  test("does not link partial git-change references inside longer tokens", async () => {
    const text = "~differently ~1500000x ~staged_files ~stash:1a";
    const document = new PromptDocumentStub(
      path.join(workspaceRoot, "prompt.prompt.md"),
      "markdown",
      text
    ).asDocument();

    const links = await new PromptLinkProvider().provideDocumentLinks(
      document,
      {} as vscode.CancellationToken
    );

    assert.deepStrictEqual(links, []);
  });

  suite("references inside code", () => {
    const linkTexts = async (
      fileName: string,
      languageId: string,
      text: string
    ): Promise<string[]> => {
      const document = new PromptDocumentStub(
        path.join(workspaceRoot, fileName),
        languageId,
        text
      );
      const links =
        (await new PromptLinkProvider().provideDocumentLinks(
          document.asDocument(),
          {} as vscode.CancellationToken
        )) ?? [];
      return links.map((link) =>
        text.slice(
          document.offsetAt(link.range.start),
          document.offsetAt(link.range.end)
        )
      );
    };

    test("skips inline code and fenced blocks in a .prompt.md file", async () => {
      const text = ["Review `@a.ts` and @b.ts", "", "```", "@c.ts", "```"].join(
        "\n"
      );
      assert.deepStrictEqual(await linkTexts("p.prompt.md", "markdown", text), [
        "@b.ts",
      ]);
    });

    test("still links a reference after an escaped backtick", async () => {
      const text = "Use \\`@a.ts here";
      assert.deepStrictEqual(await linkTexts("p.prompt.md", "markdown", text), [
        "@a.ts",
      ]);
    });

    test("skips an indented fence inside a YAML block scalar", async () => {
      const text = [
        "steps:",
        "  - prompt: |",
        "      Read @a.ts",
        "      ```",
        "      @b.ts",
        "      ```",
        "      and `@c.ts`",
      ].join("\n");
      assert.deepStrictEqual(await linkTexts("w.ctrlyoke.yaml", "yaml", text), [
        "@a.ts",
      ]);
    });

    test("skips inline code in a JSON prompt string", async () => {
      const text = JSON.stringify(
        { prompt: "Read @a.ts and `@b.ts`" },
        null,
        2
      );
      assert.deepStrictEqual(await linkTexts("w.ctrlyoke.json", "json", text), [
        "@a.ts",
      ]);
    });
  });
});
