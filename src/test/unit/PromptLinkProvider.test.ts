import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { suite, setup, teardown, test } from "mocha";
import { PromptLinkProvider } from "../../completions/PromptLinkProvider";
import { SkillDiscovery, type SkillInfo } from "../../utils/SkillDiscovery";
import { pathsEqual } from "../../utils/PathCasing";

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
});
