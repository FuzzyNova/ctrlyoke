import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript";
import { setup, suite, teardown, test } from "mocha";
import {
  HARNESS_HOME_ENV_VARS,
  getClaudeConfigDir,
  getClaudeGlobalConfigPath,
  getCodexHomeDir,
  getCopilotHomeDir,
  getOpenCodeGlobalConfigDir,
  getQwenHomeDir,
  getQwenRuntimeDir,
} from "../../utils/HarnessHome";
import {
  getClaudeUserConfigPath,
  getCopilotUserMcpConfigPath,
  getOpenCodeUserMcpConfigPath,
  getQwenUserMcpConfigPath,
} from "../../utils/McpConfigPaths";
import {
  getClaudeInstalledPluginsManifestPath,
  getHomeLspConfigPath,
  getOpenCodeUserLspConfigPath,
} from "../../utils/LspConfigPaths";
import {
  getHarnessUserAgentDirs,
  getHarnessUserSkillDirs,
} from "../../utils/HarnessDirectoryUtils";
import { HARNESS_IDS } from "../../types/DashboardConstants";
import { HarnessMcpExporter } from "../../utils/HarnessMcpExporter";
import { describeLspUserConfigPaths } from "../../utils/HarnessLspExporter";
import { LSP_EXPORT_TARGET_IDS } from "../../types/DashboardConstants";
import { formatDiscoveryPath } from "../../utils/DiscoveryUtils";
import { PATH_CONSTANTS } from "../../utils/ConfigurationUtils";

const HOME = os.homedir();
const MOVED = path.join(os.tmpdir(), "moved-harness-home");

suite("HarnessHome", () => {
  test("formats ..-prefixed workspace children as relative paths", () => {
    const root = path.join(os.tmpdir(), "ctrlyoke-discovery-root");
    const child = path.join(root, "..cache", "agent.md");
    assert.strictEqual(formatDiscoveryPath(child, root), "..cache/agent.md");
  });

  suite("resolvers", () => {
    test("default to the CLI's directory under the home directory", () => {
      const env = {};
      assert.strictEqual(getClaudeConfigDir(env), path.join(HOME, ".claude"));
      assert.strictEqual(
        getClaudeGlobalConfigPath(env),
        path.join(HOME, ".claude.json")
      );
      assert.strictEqual(getQwenHomeDir(env), path.join(HOME, ".qwen"));
      assert.strictEqual(getQwenRuntimeDir(env), path.join(HOME, ".qwen"));
      assert.strictEqual(getCopilotHomeDir(env), path.join(HOME, ".copilot"));
      assert.strictEqual(getCodexHomeDir(env), path.join(HOME, ".codex"));
      assert.strictEqual(
        getOpenCodeGlobalConfigDir(env),
        path.join(HOME, ".config", "opencode")
      );
    });

    test("treat a blank override as unset", () => {
      const env = Object.fromEntries(
        Object.values(HARNESS_HOME_ENV_VARS).map((name) => [name, "   "])
      );
      assert.strictEqual(getClaudeConfigDir(env), path.join(HOME, ".claude"));
      assert.strictEqual(getQwenRuntimeDir(env), path.join(HOME, ".qwen"));
      assert.strictEqual(getCopilotHomeDir(env), path.join(HOME, ".copilot"));
      assert.strictEqual(getCodexHomeDir(env), path.join(HOME, ".codex"));
    });

    test("CLAUDE_CONFIG_DIR moves the config directory and .claude.json into it", () => {
      const env = { CLAUDE_CONFIG_DIR: ` ${MOVED} ` };
      assert.strictEqual(getClaudeConfigDir(env), MOVED);
      assert.strictEqual(
        getClaudeGlobalConfigPath(env),
        path.join(MOVED, ".claude.json")
      );
    });

    test("QWEN_RUNTIME_DIR moves only runtime output; QWEN_HOME moves both", () => {
      const runtime = path.join(MOVED, "runtime");
      assert.deepStrictEqual(
        [
          getQwenHomeDir({ QWEN_RUNTIME_DIR: runtime }),
          getQwenRuntimeDir({ QWEN_RUNTIME_DIR: runtime }),
        ],
        [path.join(HOME, ".qwen"), runtime]
      );
      assert.deepStrictEqual(
        [
          getQwenHomeDir({ QWEN_HOME: MOVED }),
          getQwenRuntimeDir({ QWEN_HOME: MOVED }),
        ],
        [MOVED, MOVED]
      );
      assert.strictEqual(
        getQwenRuntimeDir({ QWEN_HOME: MOVED, QWEN_RUNTIME_DIR: runtime }),
        runtime
      );
    });

    test("expand a leading ~ the way Qwen does", () => {
      assert.strictEqual(
        getQwenHomeDir({ QWEN_HOME: "~/alt-qwen" }),
        path.join(HOME, "alt-qwen")
      );
      assert.strictEqual(getCopilotHomeDir({ COPILOT_HOME: "~" }), HOME);
    });

    test("COPILOT_HOME, CODEX_HOME and XDG_CONFIG_HOME move their harness", () => {
      assert.strictEqual(getCopilotHomeDir({ COPILOT_HOME: MOVED }), MOVED);
      assert.strictEqual(getCodexHomeDir({ CODEX_HOME: MOVED }), MOVED);
      assert.strictEqual(
        getOpenCodeGlobalConfigDir({ XDG_CONFIG_HOME: MOVED }),
        path.join(MOVED, "opencode")
      );
    });
  });

  suite("consumers follow process.env", () => {
    const names = Object.values(HARNESS_HOME_ENV_VARS);
    const extraNames = ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"];
    let previous: Record<string, string | undefined>;

    setup(() => {
      previous = Object.fromEntries(
        [...names, ...extraNames].map((name) => [name, process.env[name]])
      );
      for (const name of [...names, ...extraNames]) delete process.env[name];
    });

    teardown(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });

    test("user MCP, LSP, agent and skill paths move with each harness home", () => {
      const claude = path.join(MOVED, "claude");
      const qwen = path.join(MOVED, "qwen");
      const copilot = path.join(MOVED, "copilot");
      const codex = path.join(MOVED, "codex");
      const xdg = path.join(MOVED, "xdg");
      process.env.CLAUDE_CONFIG_DIR = claude;
      process.env.QWEN_HOME = qwen;
      process.env.COPILOT_HOME = copilot;
      process.env.CODEX_HOME = codex;
      process.env.XDG_CONFIG_HOME = xdg;

      assert.strictEqual(
        getClaudeUserConfigPath(),
        path.join(claude, ".claude.json")
      );
      assert.strictEqual(
        getClaudeInstalledPluginsManifestPath(),
        path.join(claude, "plugins", "installed_plugins.json")
      );
      assert.strictEqual(
        getQwenUserMcpConfigPath(),
        path.join(qwen, "settings.json")
      );
      assert.strictEqual(
        getCopilotUserMcpConfigPath(),
        path.join(copilot, "mcp-config.json")
      );
      assert.strictEqual(
        getHomeLspConfigPath(),
        path.join(copilot, "lsp-config.json")
      );
      assert.strictEqual(
        getOpenCodeUserMcpConfigPath(),
        path.join(xdg, "opencode", "opencode.json")
      );
      assert.strictEqual(
        getOpenCodeUserLspConfigPath(),
        path.join(xdg, "opencode", "opencode.json")
      );

      for (const [harnessId, home] of [
        [HARNESS_IDS.CLAUDE_CLI, claude],
        [HARNESS_IDS.QWEN_CLI, qwen],
        [HARNESS_IDS.COPILOT_CLI, copilot],
        [HARNESS_IDS.CODEX_CLI, codex],
        [HARNESS_IDS.OPENCODE_CLI, path.join(xdg, "opencode")],
      ] as const) {
        assert.deepStrictEqual(getHarnessUserAgentDirs(harnessId), [
          path.join(home, "agents"),
        ]);
        assert.deepStrictEqual(getHarnessUserSkillDirs(harnessId), [
          path.join(home, "skills"),
        ]);
      }
    });

    test("the dashboard's user-scope export labels come from the resolved paths", () => {
      const copilot = path.join(HOME, "alt-copilot");
      process.env.COPILOT_HOME = copilot;
      process.env.CLAUDE_CONFIG_DIR = MOVED;

      const mcp = new HarnessMcpExporter().describeUserConfigPaths();
      assert.strictEqual(
        mcp[HARNESS_IDS.COPILOT_CLI],
        "~/alt-copilot/mcp-config.json"
      );
      assert.strictEqual(
        mcp[HARNESS_IDS.CLAUDE_CLI],
        formatDiscoveryPath(path.join(MOVED, ".claude.json"))
      );
      assert.strictEqual(mcp[HARNESS_IDS.QWEN_CLI], "~/.qwen/settings.json");

      const lsp = describeLspUserConfigPaths();
      assert.strictEqual(
        lsp[LSP_EXPORT_TARGET_IDS.COPILOT_USER],
        "~/alt-copilot/lsp-config.json"
      );
      assert.strictEqual(
        lsp[LSP_EXPORT_TARGET_IDS.OPENCODE_USER],
        "~/.config/opencode/opencode.json"
      );
    });
  });

  // Every harness-home path must go through HarnessHome.ts, or a user who
  // moves the home with an environment variable gets a ctrlyoke that reads
  // and writes a directory the CLI never looks at.
  suite("lint", () => {
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const sourceRoot = path.join(repoRoot, "src");
    const RESOLVER_FILE = path.join(sourceRoot, "utils", "HarnessHome.ts");
    const HARNESS_HOME_SEGMENT =
      /^\.(claude|qwen|copilot|codex)(\.json)?([\\/]|$)/;
    // A whole string that is a `~/.claude/...` path; prose that mentions one is fine.
    const TILDE_HARNESS_HOME = /^~[\\/]\.(claude|qwen|copilot|codex)\b\S*$/;

    function listSources(directory: string, files: string[] = []): string[] {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          const top = path.relative(sourceRoot, filePath).split(path.sep)[0];
          if (
            top !== "test" &&
            entry.name !== PATH_CONSTANTS.NODE_MODULES_DIR
          ) {
            listSources(filePath, files);
          }
        } else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) {
          files.push(filePath);
        }
      }
      return files;
    }

    function isHomedirCall(node: ts.Node): boolean {
      if (!ts.isCallExpression(node)) return false;
      const callee = node.expression;
      return (
        (ts.isIdentifier(callee) && callee.text === "homedir") ||
        (ts.isPropertyAccessExpression(callee) &&
          callee.name.text === "homedir")
      );
    }

    function findViolations(filePath: string): string[] {
      const text = fs.readFileSync(filePath, "utf8");
      const source = ts.createSourceFile(
        filePath,
        text,
        ts.ScriptTarget.Latest,
        true
      );
      // Identifiers assigned straight from homedir(), e.g. `const home = os.homedir()`.
      const homeNames = new Set<string>();
      const violations: string[] = [];
      const isWebview = filePath.includes(
        path.join("src", "ui", "webview-react")
      );
      const where = (node: ts.Node) =>
        `${path.relative(repoRoot, filePath)}:${
          source.getLineAndCharacterOfPosition(node.getStart()).line + 1
        }`;

      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          node.initializer &&
          isHomedirCall(node.initializer)
        ) {
          homeNames.add(node.name.text);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ["join", "resolve"].includes(node.expression.name.text)
        ) {
          const [first, second] = node.arguments;
          const fromHome =
            first !== undefined &&
            (isHomedirCall(first) ||
              (ts.isIdentifier(first) && homeNames.has(first.text)));
          if (
            fromHome &&
            second !== undefined &&
            ts.isStringLiteralLike(second) &&
            HARNESS_HOME_SEGMENT.test(second.text)
          ) {
            violations.push(
              `${where(node)} joins the home directory with "${second.text}"`
            );
          }
        }
        // `~/.claude/...` path strings are resolved against os.homedir()
        // somewhere. The dashboard keeps a few as display fallbacks until
        // the backend reports the real path.
        if (
          !isWebview &&
          (ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node)) &&
          TILDE_HARNESS_HOME.test(node.text)
        ) {
          violations.push(`${where(node)} hard-codes "${node.text}"`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      return violations;
    }

    test("no harness home path is built outside HarnessHome.ts", () => {
      const violations = listSources(sourceRoot)
        .filter((file) => file !== RESOLVER_FILE)
        .flatMap(findViolations);
      assert.deepStrictEqual(
        violations,
        [],
        "Build these paths from the resolvers in src/utils/HarnessHome.ts"
      );
    });

    test("the lint catches the shapes it guards against", () => {
      const probeDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "harness-home-lint-")
      );
      try {
        const probe = path.join(probeDir, "probe.ts");
        fs.writeFileSync(
          probe,
          [
            'const a = path.join(os.homedir(), ".claude", "projects");',
            "const home = os.homedir();",
            'const b = path.join(home, ".qwen", "settings.json");',
            'const c = path.join(os.homedir(), ".claude.json");',
            'const d = ["~/.copilot/agents"];',
            'const ok = path.join(workspaceRoot, ".qwen", "settings.json");',
            'const ok2 = path.join(os.homedir(), ".gemini");',
          ].join("\n")
        );
        assert.strictEqual(findViolations(probe).length, 4);
      } finally {
        fs.rmSync(probeDir, { recursive: true, force: true });
      }
    });
  });
});
