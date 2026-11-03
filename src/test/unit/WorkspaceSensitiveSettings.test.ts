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
  PERMISSION_MODES,
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
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
  suite("default sandbox", () => {
    test("auto-applies true and withholds false unless the user value is false", () => {
      assert.deepStrictEqual(
        collectWorkspaceSensitiveSettingRequests(
          settings({ defaults: { sandbox: true } }),
          {}
        ),
        []
      );
      const workspaceFalse = settings({ defaults: { sandbox: false } });
      assert.strictEqual(
        collectWorkspaceSensitiveSettingRequests(workspaceFalse, {}).length,
        1
      );
      assert.deepStrictEqual(
        collectWorkspaceSensitiveSettingRequests(
          workspaceFalse,
          settings({ defaults: { sandbox: false } })
        ),
        []
      );
    });
  });
  suite("Codex sandbox and approval settings", () => {
    test("auto-applies narrower and equal workspace values", () => {
      for (const [path, narrow, equal, user] of [
        [
          SETTING_PATHS.PERMISSIONS_CODEX_SANDBOX_MODE,
          CODEX_SANDBOX_MODES.READ_ONLY,
          CODEX_SANDBOX_MODES.WORKSPACE_WRITE,
          CODEX_SANDBOX_MODES.WORKSPACE_WRITE,
        ],
        [
          SETTING_PATHS.PERMISSIONS_CODEX_APPROVAL_POLICY,
          CODEX_APPROVAL_POLICIES.ON_REQUEST,
          CODEX_APPROVAL_POLICIES.NEVER,
          CODEX_APPROVAL_POLICIES.NEVER,
        ],
      ] as const) {
        const workspace =
          path === SETTING_PATHS.PERMISSIONS_CODEX_SANDBOX_MODE
            ? settings({ permissions: { codexSandboxMode: narrow } })
            : settings({ permissions: { codexApprovalPolicy: narrow } });
        const userSettings =
          path === SETTING_PATHS.PERMISSIONS_CODEX_SANDBOX_MODE
            ? settings({ permissions: { codexSandboxMode: user } })
            : settings({ permissions: { codexApprovalPolicy: user } });
        assert.deepStrictEqual(
          collectWorkspaceSensitiveSettingRequests(workspace, userSettings),
          []
        );
        const equalWorkspace =
          path === SETTING_PATHS.PERMISSIONS_CODEX_SANDBOX_MODE
            ? settings({ permissions: { codexSandboxMode: equal } })
            : settings({ permissions: { codexApprovalPolicy: equal } });
        assert.deepStrictEqual(
          collectWorkspaceSensitiveSettingRequests(
            equalWorkspace,
            userSettings
          ),
          []
        );
      }
      assert.deepStrictEqual(
        collectWorkspaceSensitiveSettingRequests(
          settings({
            permissions: {
              codexApprovalPolicy: CODEX_APPROVAL_POLICIES.UNTRUSTED,
            },
          }),
          settings({
            permissions: {
              codexApprovalPolicy: CODEX_APPROVAL_POLICIES.ON_REQUEST,
            },
          })
        ),
        []
      );
    });

    test("withholds wider values until approved and compares unset user values to defaults", () => {
      const workspace = settings({
        permissions: {
          codexSandboxMode: CODEX_SANDBOX_MODES.DANGER_FULL_ACCESS,
          codexApprovalPolicy: CODEX_APPROVAL_POLICIES.NEVER,
        },
      });
      const requests = collectWorkspaceSensitiveSettingRequests(
        workspace,
        settings({
          permissions: {
            codexSandboxMode: CODEX_SANDBOX_MODES.READ_ONLY,
            codexApprovalPolicy: CODEX_APPROVAL_POLICIES.ON_REQUEST,
          },
        })
      );
      assert.deepStrictEqual(
        requests.map((request) => request.summary),
        ["Codex sandbox: danger-full-access", "Codex approval policy: never"]
      );
      const withheld = removeUntrustedWorkspaceSensitiveSettings(
        workspace,
        {},
        () => false
      );
      assert.deepStrictEqual(withheld, { permissions: {} });
      assert.deepStrictEqual(
        removeUntrustedWorkspaceSensitiveSettings(workspace, {}, () => true),
        workspace
      );
      assert.deepStrictEqual(
        collectWorkspaceSensitiveSettingRequests(
          settings({
            permissions: {
              codexSandboxMode: CODEX_SANDBOX_MODES.DANGER_FULL_ACCESS,
              codexApprovalPolicy: CODEX_APPROVAL_POLICIES.NEVER,
            },
          }),
          {}
        ).map((request) => request.settingPath),
        [
          SETTING_PATHS.PERMISSIONS_CODEX_SANDBOX_MODE,
          SETTING_PATHS.PERMISSIONS_CODEX_APPROVAL_POLICY,
        ]
      );
      assert.strictEqual(
        collectWorkspaceSensitiveSettingRequests(
          settings({ permissions: { codexSandboxMode: "unknown-mode" } }),
          settings({ permissions: { codexSandboxMode: "unknown-mode" } })
        ).length,
        1
      );
    });
  });

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

  suite("defaults.worktree", () => {
    const worktreeRequests = (workspace: unknown, user: unknown = undefined) =>
      collectWorkspaceSensitiveSettingRequests(
        settings({ defaults: { worktree: workspace } }),
        user === undefined ? {} : settings({ defaults: { worktree: user } })
      );

    test("requests a worktree default that names a setup command", () => {
      const requests = worktreeRequests({
        mode: "managed",
        setup: "node evil.js",
      });
      assert.deepStrictEqual(
        requests.map((request) => request.settingPath),
        [SETTING_PATHS.DEFAULTS_WORKTREE]
      );
      assert.strictEqual(
        requests[0]!.summary,
        `${SETTING_PATHS.DEFAULTS_WORKTREE}: setup command node evil.js`
      );
      assert.strictEqual(
        worktreeRequests({ mode: "named", branch: "x", setup: "./s.sh" })
          .length,
        1
      );
    });

    test("needs no approval for a worktree default without a setup command", () => {
      for (const value of [
        true,
        false,
        "feature/x",
        { mode: "managed", merge: true },
        { mode: "managed", setup: "  " },
      ]) {
        assert.deepStrictEqual(worktreeRequests(value), [], String(value));
      }
    });

    test("needs no approval when the user's value runs the same setup", () => {
      assert.strictEqual(
        worktreeRequests(
          { mode: "managed", keep: true, setup: "npm ci" },
          { mode: "managed", setup: "npm ci" }
        ).length,
        0
      );
      assert.strictEqual(
        worktreeRequests(
          { mode: "managed", setup: "npm ci && evil" },
          { mode: "managed", setup: "npm ci" }
        ).length,
        1
      );
    });

    test("withholds an unapproved setup so the user value applies", () => {
      const result = removeUntrustedWorkspaceSensitiveSettings(
        settings({
          defaults: {
            agent: "reviewer",
            worktree: { mode: "managed", setup: "node evil.js" },
          },
        }),
        {},
        () => false
      );
      assert.deepStrictEqual(result.defaults, { agent: "reviewer" });
    });
  });

  suite("defaults.toolPermissions", () => {
    const toolPermissionRequests = (
      workspace: unknown,
      user: unknown = undefined
    ) =>
      collectWorkspaceSensitiveSettingRequests(
        settings({ defaults: { toolPermissions: workspace } }),
        user === undefined
          ? {}
          : settings({ defaults: { toolPermissions: user } })
      );

    test("requests a mode wider than the shipped default", () => {
      const requests = toolPermissionRequests({
        mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
      });
      assert.deepStrictEqual(
        requests.map((request) => request.settingPath),
        [SETTING_PATHS.DEFAULTS_TOOL_PERMISSIONS]
      );
      assert.ok(
        requests[0]!.summary.startsWith(
          `${SETTING_PATHS.DEFAULTS_TOOL_PERMISSIONS}: dangerouslyAllowAll`
        ),
        requests[0]!.summary
      );
    });

    test("requests deferring to the harness while the user's is managed", () => {
      assert.strictEqual(toolPermissionRequests(null).length, 1);
      assert.strictEqual(
        toolPermissionRequests({ mode: PERMISSION_MODES.NONE }).length,
        1
      );
    });

    test("requests removing a denial the user's setting applies", () => {
      const requests = toolPermissionRequests(
        { deniedTools: [] },
        {
          mode: PERMISSION_MODES.ALLOW_ALL,
          allowedTools: [],
          deniedTools: ["shell(rm:*)"],
        }
      );
      assert.strictEqual(requests.length, 1);
    });

    test("requests a custom allow-list entry the user's custom list lacks", () => {
      const user = {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["write"],
        deniedTools: [],
      };
      assert.strictEqual(
        toolPermissionRequests({ allowedTools: ["write", "shell"] }, user)
          .length,
        1
      );
      assert.strictEqual(
        toolPermissionRequests({ allowedTools: [] }, user).length,
        0
      );
    });

    test("needs no approval for a workspace that only narrows", () => {
      assert.strictEqual(
        toolPermissionRequests({ mode: PERMISSION_MODES.CUSTOM }).length,
        0
      );
      assert.strictEqual(
        toolPermissionRequests(
          { deniedTools: ["shell(rm:*)", "shell(curl:*)"] },
          {
            mode: PERMISSION_MODES.ALLOW_ALL,
            allowedTools: [],
            deniedTools: ["shell(rm:*)"],
          }
        ).length,
        0
      );
    });

    test("needs no approval for a mode the user already grants", () => {
      assert.strictEqual(
        toolPermissionRequests(
          { mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL },
          { mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL }
        ).length,
        0
      );
      assert.strictEqual(toolPermissionRequests(null, null).length, 0);
    });

    test("withholds an unapproved wider value so the user value applies", () => {
      const result = removeUntrustedWorkspaceSensitiveSettings(
        settings({
          defaults: {
            toolPermissions: { mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL },
            executionMode: "headless",
          },
        }),
        {},
        () => false
      ) as Record<string, Record<string, unknown>>;
      assert.deepStrictEqual(result.defaults, { executionMode: "headless" });
    });

    test("keeps a narrower value without asking", () => {
      const narrower = { mode: PERMISSION_MODES.CUSTOM };
      const result = removeUntrustedWorkspaceSensitiveSettings(
        settings({ defaults: { toolPermissions: narrower } }),
        {},
        () => false
      ) as Record<string, Record<string, unknown>>;
      assert.deepStrictEqual(result.defaults, { toolPermissions: narrower });
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
