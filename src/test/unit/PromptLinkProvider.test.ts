import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, setup, teardown, test } from "mocha";
import { PromptLinkProvider } from "../../completions/PromptLinkProvider";
import { SkillDiscovery, type SkillInfo } from "../../utils/SkillDiscovery";
import { pathsEqual } from "../../utils/PathCasing";
import { PromptDocumentStub } from "../helpers/PromptDocumentStub";

suite("PromptLinkProvider slash-token links", () => {
  const originalWorkspaceFolders = vscode.workspace.workspaceFolders;
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
    Object.defineProperty(vscode.workspace, "workspaceFolders", {
      value: originalWorkspaceFolders,
      configurable: true,
    });
    SkillDiscovery.discoverSkills = originalDiscoverSkills;
  });

  test("links explicit skills while leaving native slash commands alone", async () => {
    const text = "/skill:commit /commit /mcp";
    const document = {
      fileName: path.join(workspaceRoot, "prompt.prompt.md"),
      languageId: "markdown",
      getText: () => text,
      positionAt: (offset: number) => new vscode.Position(0, offset),
    } as unknown as vscode.TextDocument;

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
    const document = {
      fileName: path.join(workspaceRoot, "prompt.prompt.md"),
      languageId: "markdown",
      getText: () => text,
      positionAt: (offset: number) => new vscode.Position(0, offset),
    } as unknown as vscode.TextDocument;

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
    const document = {
      fileName: path.join(workspaceRoot, "workflow.ctrlyoke.yaml"),
      languageId: "yaml",
      getText: () => text,
      positionAt: (offset: number) => new vscode.Position(0, offset),
    } as unknown as vscode.TextDocument;

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

  test("does not link partial git-change references inside longer tokens", async () => {
    const text = "~differently ~1500000x ~staged_files ~stash:1a";
    const document = {
      fileName: path.join(workspaceRoot, "prompt.prompt.md"),
      languageId: "markdown",
      getText: () => text,
      positionAt: (offset: number) => new vscode.Position(0, offset),
    } as unknown as vscode.TextDocument;

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
