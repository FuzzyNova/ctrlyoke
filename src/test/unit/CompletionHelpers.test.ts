import * as assert from "assert";
import * as vscode from "vscode";
import { suite, test, setup, teardown } from "mocha";
import {
  getOutputChannelSlug,
  toVSCodeCompletionItem,
} from "../../completions/CompletionHelpers";
import {
  clearSlashTokenCompletionCache,
  getCtrlYokeSlashCompletions,
} from "../../completions/SlashTokenCompletionHelpers";
import type { PlainCompletionItem } from "../../completions/CompletionCore";
import {
  CAPTURING_OUTPUT_PLACEHOLDER,
  VSCODE_COMMANDS,
} from "../../types/DashboardConstants";
import { SkillDiscovery, type SkillInfo } from "../../utils/SkillDiscovery";
import { McpRegistryFileManager } from "../../utils/McpRegistryFileManager";
import type { ManagedMcpServer } from "../../types/WebviewMessageTypes";
import type { McpServerConfig } from "../../types/CtrlYokeTypes";

suite("CompletionHelpers VS Code adapters", () => {
  test("converts an ordinary item without attaching a capture command", () => {
    const item = toVSCodeCompletionItem(
      {
        label: "README.md",
        kind: vscode.CompletionItemKind.File,
        insertText: "README.md",
      },
      "@"
    );
    assert.strictEqual(item.label, "README.md");
    assert.strictEqual(item.command, undefined);
  });

  test("converts captured output items to the resolver command", () => {
    const plain: PlainCompletionItem = {
      label: "agenthost (Output)",
      kind: vscode.CompletionItemKind.File,
      insertText: CAPTURING_OUTPUT_PLACEHOLDER,
      captureId: "capture-1",
    };
    const item = toVSCodeCompletionItem(plain, "@");
    assert.strictEqual(item.insertText, CAPTURING_OUTPUT_PLACEHOLDER);
    assert.deepStrictEqual(item.command, {
      command: VSCODE_COMMANDS.RESOLVE_OUTPUT_CAPTURE,
      title: "Resolve output capture",
      arguments: ["capture-1"],
    });
  });

  test("uses the workspace relative path as an output channel slug", () => {
    const document = {
      uri: vscode.Uri.file("/workspace/logs/agent.log"),
    } as vscode.TextDocument;
    const original = vscode.workspace.asRelativePath;
    Object.defineProperty(vscode.workspace, "asRelativePath", {
      configurable: true,
      value: () => "logs/agent.log",
    });
    try {
      assert.strictEqual(getOutputChannelSlug(document), "logs/agent.log");
    } finally {
      Object.defineProperty(vscode.workspace, "asRelativePath", {
        configurable: true,
        value: original,
      });
    }
  });
});

suite("slash-token completions", () => {
  const originalDiscoverSkills = SkillDiscovery.discoverSkills;
  const originalReadAll = McpRegistryFileManager.prototype.readAll;
  const skills: SkillInfo[] = [
    {
      name: "commit",
      displayName: "Commit",
      path: "/skills/commit/SKILL.md",
      description: "Create a focused commit",
      source: "workspace",
    },
    {
      name: "review",
      displayName: "Review",
      path: "/skills/review/SKILL.md",
      description: "Review changes",
      source: "user",
    },
  ];
  const playwright: McpServerConfig = {
    id: "playwright",
    command: "node",
    args: ["playwright-server.js"],
  };
  const managedServers: ManagedMcpServer[] = [
    {
      id: playwright.id,
      displayName: "Playwright",
      config: playwright,
      locations: [],
    },
  ];

  setup(() => {
    clearSlashTokenCompletionCache();
    SkillDiscovery.discoverSkills = async () => skills;
    McpRegistryFileManager.prototype.readAll = async () => managedServers;
  });
  teardown(() => {
    clearSlashTokenCompletionCache();
    SkillDiscovery.discoverSkills = originalDiscoverSkills;
    McpRegistryFileManager.prototype.readAll = originalReadAll;
  });

  test("merges skills and registry servers for the bare slash trigger", async () => {
    const items = await getCtrlYokeSlashCompletions("/workspace", "/");
    assert.deepStrictEqual(
      items.map((item) => item.label),
      ["commit", "ctrlyoke", "playwright", "review"]
    );
    assert.strictEqual(
      items.find((item) => item.label === "commit")?.detail,
      "ctrlyoke skill · workspace · Create a focused commit"
    );
    assert.strictEqual(
      items.find((item) => item.label === "playwright")?.detail,
      "ctrlyoke MCP server · node playwright-server.js"
    );
  });

  test("always offers the built-in ctrlyoke MCP server", async () => {
    const bareItems = await getCtrlYokeSlashCompletions(
      "/workspace",
      "/ctrlyoke"
    );
    assert.deepStrictEqual(
      bareItems.map((item) => item.label),
      ["ctrlyoke"]
    );
    const items = await getCtrlYokeSlashCompletions(
      "/workspace",
      "/mcp:ctrlyoke"
    );
    assert.deepStrictEqual(
      items.map((item) => item.label),
      ["ctrlyoke"]
    );
    assert.strictEqual(items[0].insertText, "/mcp:ctrlyoke");
  });

  test("filters skill and MCP namespaces by substring", async () => {
    const skillItems = await getCtrlYokeSlashCompletions(
      "/workspace",
      "/skill:c"
    );
    const serverItems = await getCtrlYokeSlashCompletions(
      "/workspace",
      "/mcp:play"
    );
    assert.deepStrictEqual(
      skillItems.map((item) => item.insertText),
      ["/skill:commit"]
    );
    assert.deepStrictEqual(
      serverItems.map((item) => item.insertText),
      ["/mcp:playwright"]
    );
  });

  test("matches merged results anywhere in the name", async () => {
    const items = await getCtrlYokeSlashCompletions("/workspace", "/wright");
    assert.deepStrictEqual(
      items.map((item) => item.label),
      ["playwright"]
    );
  });

  test("does not depend on a selected harness", async () => {
    const first = await getCtrlYokeSlashCompletions("/workspace", "/");
    const second = await getCtrlYokeSlashCompletions("/workspace", "/");
    assert.deepStrictEqual(
      first.map(({ label, insertText, detail }) => ({
        label,
        insertText,
        detail,
      })),
      second.map(({ label, insertText, detail }) => ({
        label,
        insertText,
        detail,
      }))
    );
  });
});
