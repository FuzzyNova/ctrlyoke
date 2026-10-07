import * as assert from "assert";
import * as path from "path";
import { suite, test } from "mocha";
import type { CliResolvedCommand } from "../../core/harness/shared/CliLauncherResolver";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import type { LanguageServersSettings } from "../../types/CtrlYokeSettings";
import {
  LANGUAGE_SERVER_CATALOG,
  type LanguageServerCatalogEntry,
} from "../../server/lsp/LanguageServerCatalog";
import {
  getPendingWorkspaceLanguageServerDefinitions,
  resolveLanguageServer,
  type LanguageServerResolutionOptions,
} from "../../server/lsp/LanguageServerResolver";

const emptyLanguageServers = (): LanguageServersSettings => ({
  ...CTRLYOKE_SETTINGS_DEFAULTS.languageServers,
  definitions: {},
  use: {},
  settings: {},
});

const pathDirectory = path.normalize("/path");
const toolBinDirectory = path.join("/tools", "lsp", "node_modules", ".bin");
const workspaceRoot = path.normalize("/workspace");

function options(
  overrides: Partial<LanguageServerResolutionOptions> = {}
): LanguageServerResolutionOptions {
  return {
    languageId: "typescript",
    userSettings: {
      languageServers: emptyLanguageServers(),
    },
    workspaceSettings: {
      languageServers: emptyLanguageServers(),
    },
    approvedWorkspaceDefinitionIds: new Set(),
    pathEntries: [pathDirectory],
    toolBinDirectory,
    workspaceRoot,
    platform: "linux",
    ...overrides,
  };
}

function definition(
  command: string
): LanguageServersSettings["definitions"][string] {
  return {
    command: [command, "--stdio"],
    languages: ["typescript"],
    extensions: ["ts"],
    rootMarkers: ["package.json"],
  };
}

function commandResult(command: string, args: string[]): CliResolvedCommand {
  return {
    command,
    args,
    displayCommand: [command, ...args].join(" "),
    launcherKind: "direct",
  };
}

suite("LanguageServerResolver", () => {
  test("prefers executable Windows shims over extensionless npm shim files", async () => {
    const resolved = await resolveLanguageServer(
      options({ platform: "win32" }),
      {
        fileExists: async (filePath) =>
          filePath.endsWith("typescript-language-server.cmd") ||
          filePath.endsWith("typescript-language-server"),
        resolveCommand: async (command, args) => commandResult(command, args),
      }
    );
    assert.ok(resolved);
    assert.ok(resolved.command.command.endsWith("typescript-language-server.cmd"));
  });

  test("uses workspace selection and resolves definitions user, approved workspace, then catalog", async () => {
    const userSettings = emptyLanguageServers();
    const workspaceSettings = emptyLanguageServers();
    userSettings.definitions.server = definition("user-server");
    workspaceSettings.definitions.server = definition("workspace-server");
    workspaceSettings.use.typescript = "server";

    const seen: string[] = [];
    const resolved = await resolveLanguageServer(
      options({
        userSettings: { languageServers: userSettings },
        workspaceSettings: { languageServers: workspaceSettings },
        approvedWorkspaceDefinitionIds: new Set(["server"]),
      }),
      {
        fileExists: async (filePath) => {
          seen.push(filePath);
          return [
            path.join(pathDirectory, "user-server"),
            path.join(pathDirectory, "workspace-server"),
            path.join(pathDirectory, "typescript-language-server"),
          ].includes(filePath);
        },
        resolveCommand: async (command, args) => commandResult(command, args),
      }
    );

    assert.strictEqual(resolved?.source, "user");
    assert.strictEqual(
      resolved?.command.command,
      path.join(pathDirectory, "user-server")
    );
    assert.deepStrictEqual(resolved?.command.args, ["--stdio"]);
    assert.deepStrictEqual(seen, [path.join(pathDirectory, "user-server")]);
  });

  test("leaves unapproved workspace definitions pending and falls through to available built-ins in catalog order", async () => {
    const workspaceSettings = emptyLanguageServers();
    workspaceSettings.use.typescript = "workspace-only";
    workspaceSettings.definitions["workspace-only"] = definition("untrusted");

    const catalog: LanguageServerCatalogEntry[] = [
      {
        ...LANGUAGE_SERVER_CATALOG[0]!,
        id: "first-default",
        command: ["first-default", "--stdio"],
      },
      {
        ...LANGUAGE_SERVER_CATALOG[0]!,
        id: "second-default",
        command: ["second-default", "--stdio"],
      },
    ];
    const probed: string[] = [];
    const resolved = await resolveLanguageServer(
      options({
        workspaceSettings: { languageServers: workspaceSettings },
        catalog,
      }),
      {
        fileExists: async (filePath) => {
          probed.push(filePath);
          return filePath === path.join(pathDirectory, "second-default");
        },
        resolveCommand: async (command, args) => commandResult(command, args),
      }
    );

    assert.strictEqual(resolved?.id, "second-default");
    assert.strictEqual(resolved?.source, "built-in");
    assert.deepStrictEqual(probed, [
      path.join(pathDirectory, "first-default"),
      path.join(toolBinDirectory, "first-default"),
      path.join(workspaceRoot, "node_modules", ".bin", "first-default"),
      path.join(pathDirectory, "second-default"),
    ]);
  });

  test("probes PATH before the ctrlyoke tool directory and workspace node_modules", async () => {
    const executable = "typescript-language-server";
    const candidates = [
      path.join(pathDirectory, executable),
      path.join(toolBinDirectory, executable),
      path.join(workspaceRoot, "node_modules", ".bin", executable),
    ];
    const probed: string[] = [];
    const resolved = await resolveLanguageServer(options(), {
      fileExists: async (filePath) => {
        probed.push(filePath);
        return filePath === candidates[2];
      },
      resolveCommand: async (command, args) => commandResult(command, args),
    });

    assert.strictEqual(resolved?.command.command, candidates[2]);
    assert.deepStrictEqual(probed, candidates);
  });

  test("honors an explicit false selection", async () => {
    const userSettings = emptyLanguageServers();
    userSettings.use.typescript = false;
    let probed = false;
    const resolved = await resolveLanguageServer(
      options({ userSettings: { languageServers: userSettings } }),
      {
        fileExists: async () => {
          probed = true;
          return true;
        },
        resolveCommand: async (command, args) => commandResult(command, args),
      }
    );
    assert.strictEqual(resolved, undefined);
    assert.strictEqual(probed, false);
  });

  test("reports workspace definitions as pending until approved", () => {
    const definitions = {
      safe: definition("safe-server"),
      pending: definition("workspace-server"),
    };
    assert.deepStrictEqual(
      getPendingWorkspaceLanguageServerDefinitions(
        definitions,
        new Set(["safe"])
      ),
      [{ id: "pending", definition: definitions.pending }]
    );
  });

  test("catalog ids and mason names are unique, with documented launch args retained", () => {
    const ids = LANGUAGE_SERVER_CATALOG.map(({ id }) => id);
    const masonNames = LANGUAGE_SERVER_CATALOG.map(
      ({ masonName }) => masonName
    );
    assert.strictEqual(new Set(ids).size, ids.length);
    assert.strictEqual(new Set(masonNames).size, masonNames.length);

    const entriesRequiringArgs = new Map([
      ["typescript-language-server", "--stdio"],
      ["vtsls", "--stdio"],
      ["pyright", "--stdio"],
      ["vscode-json-language-server", "--stdio"],
      ["vscode-css-language-server", "--stdio"],
      ["vscode-html-language-server", "--stdio"],
      ["yaml-language-server", "--stdio"],
      ["bash-language-server", "start"],
      ["marksman", "server"],
      ["taplo", "lsp"],
      ["docker-language-server", "start"],
    ]);
    for (const [id, expectedArg] of entriesRequiringArgs) {
      const entry = LANGUAGE_SERVER_CATALOG.find(
        (candidate) => candidate.id === id
      );
      assert.ok(entry, `Missing catalog entry ${id}`);
      assert.ok(
        entry.command.slice(1).includes(expectedArg),
        `${id} must include ${expectedArg}`
      );
    }
    for (const entry of LANGUAGE_SERVER_CATALOG) {
      assert.ok(entry.command[0], `${entry.id} needs an executable`);
      assert.ok(entry.masonName.trim(), `${entry.id} needs a Mason join key`);
      assert.ok(entry.license.trim(), `${entry.id} needs an SPDX license`);
      assert.ok(
        entry.homepage.startsWith("https://"),
        `${entry.id} needs a homepage`
      );
    }
  });
});
