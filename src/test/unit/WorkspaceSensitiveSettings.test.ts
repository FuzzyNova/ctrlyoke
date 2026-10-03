import * as assert from "assert";
import { suite, test } from "mocha";
import {
  collectWorkspaceMcpRegistryRequests,
  collectWorkspaceSensitiveSettingRequests,
  removeUntrustedWorkspaceSensitiveSettings,
  workspaceSensitiveSettingRequestKey,
} from "../../config/WorkspaceSensitiveSettings";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";
import type { McpServerConfig } from "../../types/CtrlYokeTypes";
import {
  SETTING_PATHS,
  WORKSPACE_MCP_REGISTRY_TRUST_PATH,
} from "../../types/DashboardConstants";

const evilHook = { event: "stop", command: "./tools/evil.sh" } as const;
const userHook = { event: "stop", command: "notify-send done" } as const;
const stdioServer = { id: "github", command: "npx", args: ["evil-mcp"] };

function settings(value: unknown): PartialCtrlYokeSettings {
  return value as PartialCtrlYokeSettings;
}

suite("WorkspaceSensitiveSettings", () => {
  suite("collectWorkspaceSensitiveSettingRequests", () => {
    test("requests every setting that can choose a program to run", () => {
      const requests = collectWorkspaceSensitiveSettingRequests(
        settings({
          terminal: { shellExecutable: "./tools/evil.exe" },
          defaults: {
            additionalArgs: { "claude-cli": "--settings evil.json" },
            hooks: [evilHook],
            mcpServers: ["ctrlyoke", stdioServer],
            endCondition: { script: "./check.sh" },
            preCondition: { script: "./pre.sh" },
          },
        }),
        {}
      );

      assert.deepStrictEqual(
        requests.map((request) => request.settingPath),
        [
          SETTING_PATHS.TERMINAL_SHELL_EXECUTABLE,
          `${SETTING_PATHS.DEFAULTS_ADDITIONAL_ARGS}.claude-cli`,
          SETTING_PATHS.DEFAULTS_HOOKS,
          SETTING_PATHS.DEFAULTS_MCP_SERVERS,
          SETTING_PATHS.DEFAULTS_END_CONDITION,
          SETTING_PATHS.DEFAULTS_PRE_CONDITION,
        ]
      );
      assert.ok(requests[0]!.summary.includes("./tools/evil.exe"));
    });

    test("ignores values that cannot launch anything", () => {
      const requests = collectWorkspaceSensitiveSettingRequests(
        settings({
          terminal: { shellExecutable: "  " },
          defaults: {
            additionalArgs: { "claude-cli": "" },
            mcpServers: ["ctrlyoke", { id: "remote", url: "https://x" }],
            endCondition: null,
          },
          server: { autoStart: true, bindAddress: "0.0.0.0" },
        }),
        {}
      );
      assert.deepStrictEqual(requests, []);
    });

    test("needs no approval for a value identical to the user's own", () => {
      const requests = collectWorkspaceSensitiveSettingRequests(
        settings({
          terminal: { shellExecutable: "pwsh" },
          defaults: { hooks: [userHook, evilHook] },
        }),
        settings({
          terminal: { shellExecutable: "pwsh" },
          defaults: { hooks: [{ command: "notify-send done", event: "stop" }] },
        })
      );
      assert.deepStrictEqual(
        requests.map((request) => request.summary),
        [
          `${SETTING_PATHS.DEFAULTS_HOOKS}: {"command":"./tools/evil.sh","event":"stop"}`,
        ]
      );
    });

    test("a changed value is a different request", () => {
      const [before] = collectWorkspaceSensitiveSettingRequests(
        settings({ terminal: { shellExecutable: "pwsh" } }),
        {}
      );
      const [after] = collectWorkspaceSensitiveSettingRequests(
        settings({ terminal: { shellExecutable: "./pwsh" } }),
        {}
      );
      assert.notStrictEqual(before!.fingerprint, after!.fingerprint);
    });

    test("key order does not change the fingerprint", () => {
      const [first] = collectWorkspaceSensitiveSettingRequests(
        settings({ defaults: { hooks: [{ event: "stop", command: "x" }] } }),
        {}
      );
      const [second] = collectWorkspaceSensitiveSettingRequests(
        settings({ defaults: { hooks: [{ command: "x", event: "stop" }] } }),
        {}
      );
      assert.strictEqual(first!.fingerprint, second!.fingerprint);
    });
  });

  suite("removeUntrustedWorkspaceSensitiveSettings", () => {
    const denyAll = () => false;

    test("removes a withheld scalar so the user value applies", () => {
      const workspace = settings({
        terminal: { shellExecutable: "./evil", mobileBarLayout: "x" },
      });
      const result = removeUntrustedWorkspaceSensitiveSettings(
        workspace,
        {},
        denyAll
      ) as Record<string, Record<string, unknown>>;
      assert.deepStrictEqual(result.terminal, { mobileBarLayout: "x" });
      assert.strictEqual(
        (workspace.terminal as Record<string, unknown>).shellExecutable,
        "./evil",
        "the cached workspace object must not be mutated"
      );
    });

    test("keeps allowed and harmless entries, drops the rest", () => {
      const [allowed] = collectWorkspaceSensitiveSettingRequests(
        settings({ defaults: { mcpServers: [{ id: "ok", command: "ok" }] } }),
        {}
      );
      const result = removeUntrustedWorkspaceSensitiveSettings(
        settings({
          defaults: {
            mcpServers: ["ctrlyoke", { id: "ok", command: "ok" }, stdioServer],
          },
        }),
        {},
        (request) =>
          workspaceSensitiveSettingRequestKey(request) ===
          workspaceSensitiveSettingRequestKey(allowed!)
      );
      assert.deepStrictEqual(result.defaults?.mcpServers, [
        "ctrlyoke",
        { id: "ok", command: "ok" },
      ]);
    });

    test("an array emptied by the filter is removed rather than left empty", () => {
      const result = removeUntrustedWorkspaceSensitiveSettings(
        settings({ defaults: { hooks: [evilHook], agent: "reviewer" } }),
        {},
        denyAll
      );
      assert.deepStrictEqual(result.defaults, { agent: "reviewer" });
    });

    test("filters harness flags per harness", () => {
      const result = removeUntrustedWorkspaceSensitiveSettings(
        settings({
          defaults: {
            additionalArgs: { "claude-cli": "--evil", "codex-cli": "--ok" },
          },
        }),
        settings({ defaults: { additionalArgs: { "codex-cli": "--ok" } } }),
        denyAll
      );
      assert.deepStrictEqual(result.defaults?.additionalArgs, {
        "codex-cli": "--ok",
      });
    });
  });

  suite("collectWorkspaceMcpRegistryRequests", () => {
    test("requests stdio entries unless identical to the user's entry", () => {
      const workspace: McpServerConfig[] = [
        { id: "github", command: "npx", args: ["evil"] },
        { id: "same", command: "node", args: ["server.js"] },
        { id: "remote", url: "https://example.test/mcp" },
      ];
      const user: McpServerConfig[] = [
        { id: "github", command: "npx", args: ["github-mcp"] },
        { id: "same", command: "node", args: ["server.js"] },
      ];
      const requests = collectWorkspaceMcpRegistryRequests(workspace, user);
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(
        requests[0]!.settingPath,
        WORKSPACE_MCP_REGISTRY_TRUST_PATH
      );
      assert.ok(requests[0]!.summary.includes('"github"'));
    });
  });
});
