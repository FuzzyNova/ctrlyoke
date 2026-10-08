import * as assert from "assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { suite, setup, teardown, test } from "mocha";
import {
  LSP_EXPORT_TARGET_IDS,
  SETTING_SCOPES,
} from "../../types/DashboardConstants";
import type { LanguageServerDefinition } from "../../types/CtrlYokeSettings";
import { safeDiscoverLocalLanguageServers } from "../../utils/LspDiscoveryUtils";
import { HarnessLspExporter } from "../../utils/HarnessLspExporter";

suite("HarnessLspExporter", () => {
  let root: string;
  let home: string;
  let oldHome: string | undefined;
  let oldUserProfile: string | undefined;
  const definition: LanguageServerDefinition = {
    command: ["node", "server.js", "--stdio"],
    languages: ["typescript", "typescriptreact", "javascript"],
    extensions: ["ts", "tsx", "js"],
    rootMarkers: ["package.json"],
    env: { MODE: "test" },
  };

  setup(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "cy-lsp-export-"));
    home = path.join(root, "home");
    await fs.mkdir(home, { recursive: true });
    oldHome = process.env.HOME;
    oldUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });
  teardown(async () => {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;
    await fs.rm(root, { recursive: true, force: true });
  });

  test("writes each target's native shape and preserves other entries", async () => {
    const exporter = new HarnessLspExporter(root);
    const targets = [
      [
        LSP_EXPORT_TARGET_IDS.QWEN_WORKSPACE,
        path.join(root, ".lsp.json"),
        "typescript",
      ],
      [
        LSP_EXPORT_TARGET_IDS.COPILOT_WORKSPACE,
        path.join(root, ".github", "lsp.json"),
        "typescript",
      ],
      [
        LSP_EXPORT_TARGET_IDS.COPILOT_USER,
        path.join(home, ".copilot", "lsp-config.json"),
        "typescript",
      ],
      [
        LSP_EXPORT_TARGET_IDS.OPENCODE_WORKSPACE,
        path.join(root, "opencode.json"),
        ".ts",
      ],
      [
        LSP_EXPORT_TARGET_IDS.OPENCODE_USER,
        path.join(home, ".config", "opencode", "opencode.json"),
        ".ts",
      ],
      [
        LSP_EXPORT_TARGET_IDS.CCLSP_WORKSPACE,
        path.join(root, "cclsp.json"),
        "ts",
      ],
    ] as const;
    for (const [target, filePath, expectedExtension] of targets) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        JSON.stringify(
          {
            keep: true,
            ...(target === LSP_EXPORT_TARGET_IDS.CCLSP_WORKSPACE
              ? {
                  servers: [
                    { name: "other", extensions: ["py"], command: ["pyright"] },
                  ],
                }
              : {
                  [target.startsWith("opencode")
                    ? "lsp"
                    : target.startsWith("copilot")
                      ? "lspServers"
                      : "existing"]:
                    target.startsWith("copilot") ||
                    target.startsWith("opencode")
                      ? { untouched: { command: "other" } }
                      : { command: "other" },
                }),
          },
          null,
          2
        )
      );
      const scope =
        target === LSP_EXPORT_TARGET_IDS.COPILOT_USER ||
        target === LSP_EXPORT_TARGET_IDS.OPENCODE_USER
          ? SETTING_SCOPES.USER
          : SETTING_SCOPES.WORKSPACE;
      await exporter.export("typescript-lsp", definition, target, scope);
      const document = JSON.parse(await fs.readFile(filePath, "utf8"));
      assert.strictEqual(document.keep, true);
      const entry =
        target === LSP_EXPORT_TARGET_IDS.CCLSP_WORKSPACE
          ? document.servers.find(
              (item: { command: string[] }) =>
                JSON.stringify(item.command) ===
                JSON.stringify(definition.command)
            )
          : target.startsWith("opencode")
            ? document.lsp["typescript-lsp"]
            : target.startsWith("copilot")
              ? document.lspServers["typescript-lsp"]
              : document["typescript-lsp"];
      assert.ok(entry);
      if (target === LSP_EXPORT_TARGET_IDS.QWEN_WORKSPACE) {
        assert.strictEqual(entry.command, "node");
        assert.deepStrictEqual(entry.args, ["server.js", "--stdio"]);
        assert.deepStrictEqual(entry.extensionToLanguage, {
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".js": "javascript",
        });
        assert.deepStrictEqual(document.existing, { command: "other" });
      } else if (target.startsWith("copilot")) {
        assert.strictEqual(entry.command, "node");
        assert.deepStrictEqual(entry.args, ["server.js", "--stdio"]);
        assert.deepStrictEqual(entry.fileExtensions, {
          ".ts": "typescript",
          ".tsx": "typescriptreact",
          ".js": "javascript",
        });
        assert.deepStrictEqual(document.lspServers.untouched, {
          command: "other",
        });
      } else if (target.startsWith("opencode")) {
        assert.deepStrictEqual(entry.command, definition.command);
        assert.deepStrictEqual(entry.extensions, [".ts", ".tsx", ".js"]);
        assert.deepStrictEqual(document.lsp.untouched, { command: "other" });
      } else {
        assert.deepStrictEqual(entry.command, definition.command);
        assert.deepStrictEqual(entry.extensions, ["ts", "tsx", "js"]);
        assert.deepStrictEqual(document.servers, [
          { name: "other", extensions: ["py"], command: ["pyright"] },
          { extensions: ["ts", "tsx", "js"], command: definition.command },
        ]);
      }
      assert.ok(JSON.stringify(entry).includes(expectedExtension));
      assert.ok(!("rootMarkers" in entry));
    }
  });

  test("round-trips a workspace export through local scan and import", async () => {
    const roundTripDefinition = { ...definition, rootMarkers: [] };
    const exporter = new HarnessLspExporter(root);
    await exporter.export(
      "typescript-lsp",
      roundTripDefinition,
      LSP_EXPORT_TARGET_IDS.QWEN_WORKSPACE,
      SETTING_SCOPES.WORKSPACE
    );
    const scan = await safeDiscoverLocalLanguageServers(root);
    const imported = scan.servers.find(
      (entry) => entry.id === "typescript-lsp"
    );
    assert.ok(imported);
    assert.deepStrictEqual(imported.definition, roundTripDefinition);
  });

  test("merges existing config keys and enables opencode built-ins when lsp is true", async () => {
    const filePath = path.join(root, "opencode.json");
    await fs.writeFile(filePath, JSON.stringify({ lsp: true }));
    await new HarnessLspExporter(root).export(
      "typescript-lsp",
      definition,
      LSP_EXPORT_TARGET_IDS.OPENCODE_WORKSPACE,
      SETTING_SCOPES.WORKSPACE
    );
    const document = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.deepStrictEqual(Object.keys(document.lsp), ["typescript-lsp"]);
    assert.deepStrictEqual(
      document.lsp["typescript-lsp"].command,
      definition.command
    );
    await fs.writeFile(
      filePath,
      JSON.stringify({
        lsp: {
          "typescript-lsp": {
            command: ["old"],
            initializationOptions: { keep: true },
          },
        },
      })
    );
    await new HarnessLspExporter(root).export(
      "typescript-lsp",
      definition,
      LSP_EXPORT_TARGET_IDS.OPENCODE_WORKSPACE,
      SETTING_SCOPES.WORKSPACE
    );
    const merged = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.deepStrictEqual(merged.lsp["typescript-lsp"].initializationOptions, {
      keep: true,
    });
    assert.deepStrictEqual(
      merged.lsp["typescript-lsp"].command,
      definition.command
    );
  });

  test("replaces a cclsp entry by id and its matching extension set", async () => {
    const filePath = path.join(root, "cclsp.json");
    await fs.writeFile(
      filePath,
      JSON.stringify({
        servers: [
          {
            name: "typescript-lsp",
            extensions: ["ts", "tsx", "js"],
            command: ["old"],
            initializationOptions: { keep: true },
          },
        ],
      })
    );
    await new HarnessLspExporter(root).export(
      "typescript-lsp",
      definition,
      LSP_EXPORT_TARGET_IDS.CCLSP_WORKSPACE,
      SETTING_SCOPES.WORKSPACE
    );
    const document = JSON.parse(await fs.readFile(filePath, "utf8"));
    assert.strictEqual(document.servers.length, 1);
    assert.deepStrictEqual(document.servers[0].command, definition.command);
    assert.deepStrictEqual(document.servers[0].initializationOptions, {
      keep: true,
    });
  });
});
