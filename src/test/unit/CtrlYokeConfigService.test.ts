import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import {
  CtrlYokeConfigService,
  type ConfigBackend,
} from "../../config/CtrlYokeConfigService";
import { FileConfigBackend } from "../../config/FileConfigBackend";
import { uniqueAtomicTempPath } from "../../config/AtomicFileWrite";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";
import { FakeWorkspaceSettingsTrust } from "../helpers/fakeWorkspaceSettingsTrust";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBackend(data: PartialCtrlYokeSettings): ConfigBackend {
  return {
    getAll: () => data,
    set: async (_path: string, _value: unknown) => {},
  };
}

// ---------------------------------------------------------------------------
// CtrlYokeConfigService tests
// ---------------------------------------------------------------------------

suite("CtrlYokeConfigService", () => {
  let service: CtrlYokeConfigService;

  setup(() => {
    service = new CtrlYokeConfigService();
  });

  test("returns all defaults when no backends are set", () => {
    const all = service.getAll();
    assert.strictEqual(
      all.defaults.harness,
      CTRLYOKE_SETTINGS_DEFAULTS.defaults.harness
    );
    assert.strictEqual(
      all.defaults.executionMode,
      CTRLYOKE_SETTINGS_DEFAULTS.defaults.executionMode
    );
    assert.strictEqual(
      all.queue.maxSteps,
      CTRLYOKE_SETTINGS_DEFAULTS.queue.maxSteps
    );
    assert.strictEqual(
      all.queue.maxParallelSteps,
      CTRLYOKE_SETTINGS_DEFAULTS.queue.maxParallelSteps
    );
    assert.strictEqual(
      all.diagnostics.verboseLogging,
      CTRLYOKE_SETTINGS_DEFAULTS.diagnostics.verboseLogging
    );
    assert.strictEqual(
      all.statusLine.byHarness["antigravity-cli"].enabled,
      true
    );
    assert.strictEqual(
      all.ui.collapsedToolOutputLineCount,
      CTRLYOKE_SETTINGS_DEFAULTS.ui.collapsedToolOutputLineCount
    );
  });

  test("merges language server definitions and keeps their defaults typed", () => {
    service.setUserBackend(
      makeBackend({
        languageServers: {
          definitions: {
            pyright: {
              command: ["pyright-langserver", "--stdio"],
              languages: ["python"],
              extensions: ["py"],
              rootMarkers: ["pyproject.toml"],
            },
          },
          use: { python: "pyright" },
        },
      })
    );

    const languageServers = service.getAll().languageServers;
    assert.deepStrictEqual(languageServers.use, { python: "pyright" });
    assert.deepStrictEqual(languageServers.definitions.pyright?.command, [
      "pyright-langserver",
      "--stdio",
    ]);
    assert.strictEqual(languageServers.idleShutdownMinutes, 10);
    assert.strictEqual(languageServers.maxRunning, 4);
    assert.strictEqual(languageServers.startOnLaunch, false);
  });

  test("resolves nested statusline settings through the config hierarchy", () => {
    service.setUserBackend(
      makeBackend({
        statusLine: {
          byHarness: {
            "antigravity-cli": {
              enabled: false,
              customCommand: "",
              useCtrlyokeStyle: true,
            },
          },
        },
      })
    );
    assert.strictEqual(
      service.get("statusLine").byHarness["antigravity-cli"].enabled,
      false
    );

    service.setWorkspaceBackend(
      makeBackend({
        statusLine: {
          byHarness: {
            "antigravity-cli": {
              enabled: true,
              customCommand: "",
              useCtrlyokeStyle: true,
            },
          },
        },
      })
    );
    assert.strictEqual(
      service.get("statusLine").byHarness["antigravity-cli"].enabled,
      false,
      "workspace statusline values are ignored because they are machine-scoped"
    );
  });

  test("user backend values override defaults", () => {
    service.setUserBackend(
      makeBackend({
        defaults: { harness: "claude-cli" },
        diagnostics: { verboseLogging: true },
      })
    );
    const all = service.getAll();
    assert.strictEqual(all.defaults.harness, "claude-cli");
    assert.strictEqual(all.diagnostics.verboseLogging, true);
    // Other defaults should still be present
    assert.strictEqual(
      all.defaults.executionMode,
      CTRLYOKE_SETTINGS_DEFAULTS.defaults.executionMode
    );
  });

  test("malformed object sections cannot replace object defaults", () => {
    service.setUserBackend(
      makeBackend({
        diagnostics: null,
        defaults: { toolPermissions: "invalid" },
      } as unknown as PartialCtrlYokeSettings)
    );

    assert.strictEqual(service.get("diagnostics").verboseLogging, false);
    assert.strictEqual(
      service.get("defaults").toolPermissions?.mode,
      CTRLYOKE_SETTINGS_DEFAULTS.defaults.toolPermissions?.mode
    );
  });

  test("higher scopes replace union-valued object leaves wholesale", () => {
    const cases: Array<{
      name: string;
      setting: "worktree" | "priorContext";
      user: PartialCtrlYokeSettings;
      workspace: PartialCtrlYokeSettings;
      expected: unknown;
    }> = [
      {
        name: "worktree object with false",
        setting: "worktree",
        user: { defaults: { worktree: { mode: "managed", merge: true } } },
        workspace: { defaults: { worktree: false } },
        expected: false,
      },
      {
        name: "worktree object with shorthand string",
        setting: "worktree",
        user: { defaults: { worktree: { mode: "managed" } } },
        workspace: { defaults: { worktree: "feature-x" } },
        expected: "feature-x",
      },
      {
        name: "worktree object with another object variant",
        setting: "worktree",
        user: {
          defaults: { worktree: { mode: "managed", merge: true, keep: true } },
        },
        workspace: { defaults: { worktree: { mode: "named", branch: "dev" } } },
        expected: { mode: "named", branch: "dev" },
      },
      {
        name: "priorContext object with keyword string",
        setting: "priorContext",
        user: { defaults: { priorContext: { previous: 2 } } },
        workspace: { defaults: { priorContext: "none" } },
        expected: "none",
      },
      {
        name: "priorContext object with number array",
        setting: "priorContext",
        user: { defaults: { priorContext: { previous: 2 } } },
        workspace: { defaults: { priorContext: [1, 3] } },
        expected: [1, 3],
      },
    ];

    for (const testCase of cases) {
      const caseService = new CtrlYokeConfigService();
      caseService.setUserBackend(makeBackend(testCase.user));
      caseService.setWorkspaceBackend(makeBackend(testCase.workspace));

      assert.deepStrictEqual(
        caseService.get("defaults")[testCase.setting],
        testCase.expected,
        testCase.name
      );
      const resolved = caseService.resolve("defaults");
      assert.strictEqual(resolved.source, "workspace", testCase.name);
      assert.deepStrictEqual(
        resolved.value,
        caseService.get("defaults"),
        testCase.name
      );
    }
  });

  test("keeps schema-nullable toolPermissions null from user and workspace scopes", () => {
    service.setUserBackend(
      makeBackend({ defaults: { toolPermissions: null } })
    );
    assert.strictEqual(service.get("defaults").toolPermissions, null);

    service.setUserBackend(makeBackend({}));
    service.setWorkspaceBackend({
      getAll: () => ({ defaults: { toolPermissions: null } }),
      set: async () => {},
    });
    assert.strictEqual(service.get("defaults").toolPermissions, null);
  });

  test("merges partial overlays onto nullable object defaults", () => {
    service.setUserBackend(
      makeBackend({ defaults: { toolPermissions: null } })
    );
    service.setCliOverlay({
      defaults: { toolPermissions: { mode: "custom" } },
    });

    assert.deepStrictEqual(service.get("defaults").toolPermissions, {
      ...CTRLYOKE_SETTINGS_DEFAULTS.defaults.toolPermissions,
      mode: "custom",
    });
  });

  test("filters malformed workspace object sections before merge", () => {
    service.setWorkspaceBackend({
      getAll: () =>
        ({
          diagnostics: "invalid",
          defaults: { toolPermissions: [] },
        }) as unknown as PartialCtrlYokeSettings,
      set: async () => {},
    });

    assert.strictEqual(service.get("diagnostics").verboseLogging, false);
    assert.strictEqual(
      service.get("defaults").toolPermissions?.mode,
      CTRLYOKE_SETTINGS_DEFAULTS.defaults.toolPermissions?.mode
    );
    assert.strictEqual(
      service.getScoped("diagnostics", "workspace"),
      undefined
    );
  });

  test("workspace backend overrides user backend", () => {
    service.setUserBackend(
      makeBackend({ defaults: { harness: "claude-cli" } })
    );
    service.setWorkspaceBackend(
      makeBackend({ defaults: { harness: "codex-cli" } })
    );
    assert.strictEqual(service.get("defaults").harness, "codex-cli");
  });

  test("allows workspace overrides for the normal-scope percent direction", () => {
    service.setUserBackend(
      makeBackend({ usageTracking: { percentDirection: "used" } })
    );
    service.setWorkspaceBackend(
      makeBackend({ usageTracking: { percentDirection: "remaining" } })
    );

    assert.strictEqual(
      service.get("usageTracking").percentDirection,
      "remaining"
    );
  });

  test("CLI overlay overrides workspace backend", () => {
    service.setUserBackend(
      makeBackend({ defaults: { harness: "claude-cli" } })
    );
    service.setWorkspaceBackend(
      makeBackend({ defaults: { harness: "codex-cli" } })
    );
    service.setCliOverlay({ defaults: { harness: "antigravity-cli" } });
    assert.strictEqual(service.get("defaults").harness, "antigravity-cli");
  });

  test("deep merge: workspace defaults.executionMode does not wipe execution.scriptTimeout", () => {
    service.setWorkspaceBackend(
      makeBackend({ defaults: { executionMode: "headless" } })
    );
    const all = service.getAll();
    assert.strictEqual(all.defaults.executionMode, "headless");
    // scriptTimeout should still come from defaults
    assert.strictEqual(
      all.execution.scriptTimeoutSec,
      CTRLYOKE_SETTINGS_DEFAULTS.execution.scriptTimeoutSec
    );
    assert.strictEqual(
      all.execution.closeTerminalOnComplete,
      CTRLYOKE_SETTINGS_DEFAULTS.execution.closeTerminalOnComplete
    );
  });

  suite("resolve(key)", () => {
    test('returns source "default" when no backends set', () => {
      const result = service.resolve("defaults");
      assert.strictEqual(result.source, "default");
      assert.strictEqual(
        (result.value as typeof CTRLYOKE_SETTINGS_DEFAULTS.defaults).harness,
        CTRLYOKE_SETTINGS_DEFAULTS.defaults.harness
      );
    });

    test('returns source "user" when user backend provides key', () => {
      service.setUserBackend(
        makeBackend({ defaults: { harness: "claude-cli" } })
      );
      const result = service.resolve("defaults");
      assert.strictEqual(result.source, "user");
      assert.strictEqual(
        (result.value as typeof CTRLYOKE_SETTINGS_DEFAULTS.defaults).harness,
        "claude-cli"
      );
    });

    test('returns source "workspace" when workspace backend provides key', () => {
      service.setUserBackend(
        makeBackend({ defaults: { harness: "claude-cli" } })
      );
      service.setWorkspaceBackend(
        makeBackend({ defaults: { harness: "codex-cli" } })
      );
      const result = service.resolve("defaults");
      assert.strictEqual(result.source, "workspace");
      assert.strictEqual(
        (result.value as typeof CTRLYOKE_SETTINGS_DEFAULTS.defaults).harness,
        "codex-cli"
      );
    });

    test('returns source "cli" when CLI overlay provides key', () => {
      service.setWorkspaceBackend(
        makeBackend({ defaults: { harness: "codex-cli" } })
      );
      service.setCliOverlay({ defaults: { harness: "antigravity-cli" } });
      const result = service.resolve("defaults");
      assert.strictEqual(result.source, "cli");
      assert.strictEqual(
        (result.value as typeof CTRLYOKE_SETTINGS_DEFAULTS.defaults).harness,
        "antigravity-cli"
      );
    });
  });

  test('getNested("defaults.executionMode") returns correct nested value', () => {
    service.setWorkspaceBackend(
      makeBackend({ defaults: { executionMode: "headless" } })
    );
    assert.strictEqual(service.getNested("defaults.executionMode"), "headless");
  });

  test("getNested returns default for unset nested key", () => {
    const defaultMode = CTRLYOKE_SETTINGS_DEFAULTS.defaults.executionMode;
    assert.strictEqual(
      service.getNested("defaults.executionMode"),
      defaultMode
    );
  });

  suite("getScoped(key, scope)", () => {
    test("returns undefined when the requested scope's backend lacks the key", () => {
      service.setUserBackend(
        makeBackend({ defaults: { harness: "claude-cli" } })
      );
      assert.strictEqual(service.getScoped("permissions", "user"), undefined);
    });

    test("returns only the requested scope's value, ignoring the other scope", () => {
      service.setUserBackend(
        makeBackend({
          permissions: { trustedExternalRoots: ["/home/user/logs"] },
        })
      );
      service.setWorkspaceBackend(
        makeBackend({
          permissions: { trustedExternalRoots: ["/shared/logs"] },
        })
      );
      assert.deepStrictEqual(
        service.getScoped("permissions", "user")?.trustedExternalRoots,
        ["/home/user/logs"]
      );
      assert.deepStrictEqual(
        service.getScoped("permissions", "workspace")?.trustedExternalRoots,
        ["/shared/logs"]
      );
    });

    test("ignores the CLI overlay entirely", () => {
      service.setCliOverlay({
        permissions: { trustedExternalRoots: ["/cli/only"] },
      });
      assert.strictEqual(service.getScoped("permissions", "user"), undefined);
      assert.strictEqual(
        service.getScoped("permissions", "workspace"),
        undefined
      );
    });
  });

  test("rejects workspace-scope worktree root writes before touching the backend", async () => {
    let wrote = false;
    service.setWorkspaceBackend({
      getAll: () => ({}),
      set: async () => {
        wrote = true;
      },
    });

    await assert.rejects(
      service.set("worktrees.root", "C:\\outside", "workspace"),
      /user-scope only/
    );
    assert.strictEqual(wrote, false);
  });

  test("rejects workspace-scope run history location writes", async () => {
    let wrote = false;
    service.setWorkspaceBackend({
      getAll: () => ({}),
      set: async () => {
        wrote = true;
      },
    });

    await assert.rejects(
      service.set("storage.runHistoryLocation", "workspace", "workspace"),
      /user-scope only/
    );
    assert.strictEqual(wrote, false);
  });

  test("rejects workspace-scope statusline and usage enable writes", async () => {
    let wrote = false;
    service.setWorkspaceBackend({
      getAll: () => ({}),
      set: async () => {
        wrote = true;
      },
    });

    await assert.rejects(
      service.set(
        "statusLine.byHarness.claude-cli.enabled",
        false,
        "workspace"
      ),
      /machine-scoped/
    );
    await assert.rejects(
      service.set("usageTracking.enabled", false, "workspace"),
      /machine-scoped/
    );
    for (const settingPath of [
      "languageServers.idleShutdownMinutes",
      "languageServers.maxRunning",
      "languageServers.startOnLaunch",
    ]) {
      await assert.rejects(
        service.set(settingPath, 1, "workspace"),
        /machine-scoped/
      );
    }
    assert.strictEqual(wrote, false);
  });

  test("ignores workspace-scope storage settings during the effective merge", () => {
    service.setUserBackend(
      makeBackend({ storage: { runHistoryLocation: "user" } })
    );
    service.setWorkspaceBackend({
      filePath: "C:\\workspace\\.ctrlyoke\\settings.json",
      getAll: () => ({ storage: { runHistoryLocation: "workspace" } }),
      set: async () => {},
    });

    assert.strictEqual(service.get("storage").runHistoryLocation, "user");
  });

  test("filters forbidden workspace paths while preserving allowed siblings", () => {
    service.setUserBackend(
      makeBackend({
        statusLine: {
          byHarness: {
            "antigravity-cli": {
              enabled: true,
              customCommand: "user-command",
              useCtrlyokeStyle: true,
            },
          },
        },
        permissions: {},
        usageTracking: {
          enabled: true,
          providerRefreshEnabled: false,
        },
      })
    );
    service.setWorkspaceBackend({
      filePath: "workspace-settings.json",
      getAll: () => ({
        statusLine: {
          byHarness: {
            "antigravity-cli": {
              enabled: false,
              customCommand: "workspace-command",
              useCtrlyokeStyle: false,
            },
          },
        },
        permissions: { trustedExternalRoots: ["/shared/logs"] },
        usageTracking: {
          enabled: false,
          providerRefreshEnabled: true,
        },
      }),
      set: async () => {},
    });

    assert.strictEqual(
      service.get("statusLine").byHarness["antigravity-cli"].enabled,
      true
    );
    assert.deepStrictEqual(service.get("permissions").trustedExternalRoots, [
      "/shared/logs",
    ]);
    assert.strictEqual(service.get("usageTracking").enabled, true);
    assert.strictEqual(
      service.get("usageTracking").providerRefreshEnabled,
      true
    );
    assert.strictEqual(
      service.getScoped("usageTracking", "workspace")?.enabled,
      undefined
    );
    assert.strictEqual(
      service.getLeafSources()["statusLine.byHarness.antigravity-cli"],
      "user"
    );
    assert.strictEqual(service.resolve("permissions").source, "workspace");
    assert.strictEqual(
      service.getLeafSources()["usageTracking.enabled"],
      "user"
    );
    assert.strictEqual(
      service.getLeafSources()["statusLine.byHarness.antigravity-cli"],
      "user"
    );
  });

  test("subscribe listener is called after notify()", () => {
    let called = 0;
    const unsubscribe = service.subscribe(() => {
      called++;
    });
    service.notify();
    assert.strictEqual(called, 1);
    service.notify();
    assert.strictEqual(called, 2);
    unsubscribe();
    service.notify();
    assert.strictEqual(called, 2);
  });
});

// ---------------------------------------------------------------------------
// Workspace sensitive-settings gate
// ---------------------------------------------------------------------------

suite("CtrlYokeConfigService workspace sensitive settings", () => {
  let service: CtrlYokeConfigService;
  let trust: FakeWorkspaceSettingsTrust;
  let tempDir: string;

  function workspaceBackend(data: PartialCtrlYokeSettings): ConfigBackend {
    return { ...makeBackend(data), workspaceRoot: tempDir };
  }

  setup(() => {
    tempDir = makeTempDir("ctrlyoke-sensitive-settings-");
    service = new CtrlYokeConfigService();
    trust = new FakeWorkspaceSettingsTrust();
    service.setWorkspaceSettingsTrust(trust);
    service.setUserBackend(
      makeBackend({ terminal: { shellExecutable: "pwsh" } as never })
    );
  });

  teardown(() => {
    removeTempDir(tempDir);
  });

  test("withholds an undecided workspace shell and reports it", () => {
    service.setWorkspaceBackend(
      workspaceBackend({
        terminal: { shellExecutable: "./tools/evil.exe" } as never,
      })
    );

    assert.strictEqual(service.getAll().terminal.shellExecutable, "pwsh");
    assert.strictEqual(trust.reported.length, 1);
    assert.strictEqual(
      trust.reported[0]!.identity,
      service.getWorkspaceTrustIdentity()
    );
    assert.deepStrictEqual(
      service.getWorkspaceSensitiveSettingStates().map((s) => s.decision),
      [undefined]
    );
  });

  test("applies an allowed value and ignores a denied one", async () => {
    service.setWorkspaceBackend(
      workspaceBackend({
        terminal: { shellExecutable: "bash" } as never,
        defaults: { hooks: [{ event: "stop", command: "./x.sh" }] } as never,
      })
    );
    const [shell, hook] = service
      .getWorkspaceSensitiveSettingStates()
      .map((state) => state.request);
    const identity = service.getWorkspaceTrustIdentity()!;
    await trust.setDecisions(identity, [shell!], "allow");
    await trust.setDecisions(identity, [hook!], "deny");

    const all = service.getAll();
    assert.strictEqual(all.terminal.shellExecutable, "bash");
    assert.deepStrictEqual(all.defaults.hooks, []);
    assert.strictEqual(service.resolve("terminal").source, "workspace");
  });

  test("withholds everything when the workspace backend has no root", () => {
    service.setWorkspaceSettingsTrust(new FakeWorkspaceSettingsTrust(true));
    service.setWorkspaceBackend(
      makeBackend({ terminal: { shellExecutable: "./evil" } as never })
    );
    assert.strictEqual(service.getWorkspaceTrustIdentity(), undefined);
    assert.strictEqual(service.getAll().terminal.shellExecutable, "pwsh");
  });

  test("a workspace value equal to the user's own needs no approval", () => {
    service.setWorkspaceBackend(
      workspaceBackend({ terminal: { shellExecutable: "pwsh" } as never })
    );
    assert.deepStrictEqual(service.getWorkspaceSensitiveSettingStates(), []);
    assert.strictEqual(service.getAll().terminal.shellExecutable, "pwsh");
  });

  test("withholds the value from scoped reads and leaf sources too", () => {
    service.setWorkspaceBackend(
      workspaceBackend({ terminal: { shellExecutable: "./evil" } as never })
    );
    assert.strictEqual(
      service.getScoped("terminal", "workspace")?.shellExecutable,
      undefined
    );
    assert.strictEqual(
      service.getLeafSources()["terminal.shellExecutable"],
      "user",
      "the user's own shell is what applies"
    );
  });

  test("approves a value the user writes at workspace scope, but not one already pending", async () => {
    const settingsFile = path.join(tempDir, ".ctrlyoke", "settings.json");
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        defaults: { hooks: [{ event: "stop", command: "./committed.sh" }] },
      })
    );
    service.setWorkspaceBackend(new FileConfigBackend(settingsFile, tempDir));

    await service.set("terminal.shellExecutable", "zsh", "workspace");
    await service.set(
      "defaults.hooks",
      [
        { event: "stop", command: "./committed.sh" },
        { event: "stop", command: "./mine.sh" },
      ],
      "workspace"
    );

    const decisions = Object.fromEntries(
      service
        .getWorkspaceSensitiveSettingStates()
        .map((state) => [state.request.summary, state.decision])
    );
    assert.deepStrictEqual(decisions, {
      "terminal.shellExecutable: zsh": "allow",
      'defaults.hooks: {"command":"./committed.sh","event":"stop"}': undefined,
      'defaults.hooks: {"command":"./mine.sh","event":"stop"}': "allow",
    });
    assert.strictEqual(service.getAll().terminal.shellExecutable, "zsh");
    assert.deepStrictEqual(
      service.getAll().defaults.hooks.map((hook) => hook.command),
      ["./mine.sh"]
    );
  });
});

// ---------------------------------------------------------------------------
// FileConfigBackend tests
// ---------------------------------------------------------------------------

suite("FileConfigBackend", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = makeTempDir("cy-config-test-");
  });

  teardown(() => {
    removeTempDir(tmpDir);
  });

  test("getAll() returns {} if file does not exist", () => {
    const backend = new FileConfigBackend(
      path.join(tmpDir, "nonexistent", "settings.json")
    );
    assert.deepStrictEqual(backend.getAll(), {});
  });

  test("getAll() parses valid JSON", () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaults: { harness: "claude-cli" },
        diagnostics: { verboseLogging: true },
      }),
      "utf-8"
    );
    const backend = new FileConfigBackend(configPath);
    const result = backend.getAll();
    assert.strictEqual(result.defaults?.harness, "claude-cli");
    assert.strictEqual(result.diagnostics?.verboseLogging, true);
  });

  test("getAll() returns {} on invalid JSON", () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(configPath, "{ invalid json }", "utf-8");
    const backend = new FileConfigBackend(configPath);
    assert.deepStrictEqual(backend.getAll(), {});
  });

  test("empty, whitespace-only, and comment-only files accept writes", async () => {
    const contentByCase = [
      "",
      " \r\n\t",
      "// settings go here\n/* empty */",
      "\uFEFF \r\n",
      "\uFEFF// settings go here\n",
    ];
    for (const [index, content] of contentByCase.entries()) {
      const configPath = path.join(tmpDir, `empty-${index}.json`);
      fs.writeFileSync(configPath, content, "utf-8");
      const backend = new FileConfigBackend(configPath);

      assert.deepStrictEqual(backend.getAll(), {});
      await backend.set("diagnostics.verboseLogging", true);
      assert.strictEqual(
        JSON.parse(fs.readFileSync(configPath, "utf-8")).diagnostics
          .verboseLogging,
        true
      );
    }
  });

  test("rejects non-object roots without changing their bytes", async () => {
    for (const [index, content] of [
      "null",
      "[]",
      '"settings"',
      "42",
    ].entries()) {
      const configPath = path.join(tmpDir, `root-${index}.json`);
      const original = Buffer.from(content, "utf-8");
      fs.writeFileSync(configPath, original);
      const backend = new FileConfigBackend(configPath);

      assert.deepStrictEqual(backend.getAll(), {});
      await assert.rejects(
        backend.set("ui.showCostEstimates", false),
        /invalid JSON/
      );
      assert.deepStrictEqual(fs.readFileSync(configPath), original);
    }
  });

  test("null or primitive sections do not replace object defaults", () => {
    const service = new CtrlYokeConfigService();
    service.setUserBackend({
      getAll: () =>
        ({
          diagnostics: null,
          defaults: { toolPermissions: 7 },
        }) as unknown as PartialCtrlYokeSettings,
      set: async () => {},
    });

    assert.strictEqual(service.get("diagnostics").verboseLogging, false);
    assert.strictEqual(
      service.get("defaults").toolPermissions?.mode,
      CTRLYOKE_SETTINGS_DEFAULTS.defaults.toolPermissions?.mode
    );
  });

  test("set() preserves settings in a BOM-prefixed file", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      configPath,
      `\uFEFF${JSON.stringify({
        worktrees: { root: "D:/worktrees" },
        execution: { injectMode: "append" },
      })}`,
      "utf-8"
    );
    const backend = new FileConfigBackend(configPath);

    await backend.set("ui.showCostEstimates", false);

    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.deepStrictEqual(content.worktrees, { root: "D:/worktrees" });
    assert.deepStrictEqual(content.execution, { injectMode: "append" });
    assert.strictEqual(content.ui.showCostEstimates, false);
  });

  test("set() accepts JSONC comments and trailing commas", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      configPath,
      '{\n  // Keep hand-edited settings.\n  "worktrees": {"root": "D:/worktrees",},\n}\n',
      "utf-8"
    );
    const backend = new FileConfigBackend(configPath);

    await backend.set("ui.showCostEstimates", false);

    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.deepStrictEqual(content.worktrees, { root: "D:/worktrees" });
    assert.strictEqual(content.ui.showCostEstimates, false);
  });

  test("set() rejects invalid existing files without changing their bytes", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    const original = Buffer.from('{ "worktrees": { "root": , } }\r\n', "utf-8");
    fs.writeFileSync(configPath, original);
    const backend = new FileConfigBackend(configPath);

    assert.deepStrictEqual(backend.getAll(), {});
    await assert.rejects(
      backend.set("ui.showCostEstimates", false),
      (error: Error) =>
        error.message.includes("invalid JSON") &&
        error.message.includes(configPath)
    );
    assert.deepStrictEqual(fs.readFileSync(configPath), original);
  });

  test("set() creates file and directory if they do not exist", async () => {
    const configPath = path.join(tmpDir, "sub", "settings.json");
    const backend = new FileConfigBackend(configPath);
    await backend.set("defaults.harness", "claude-cli");
    assert.ok(fs.existsSync(configPath), "config file should be created");
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.strictEqual(content.defaults?.harness, "claude-cli");
    assert.strictEqual(content.schemaVersion, 1);
    assert.strictEqual(content.$schema, undefined);
  });

  test("set() updates an existing top-level setting", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ defaults: { harness: "copilot-cli" } }),
      "utf-8"
    );
    const backend = new FileConfigBackend(configPath);
    await backend.set("defaults.harness", "antigravity-cli");
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.strictEqual(content.defaults?.harness, "antigravity-cli");
  });

  test("set() updates a nested setting without wiping siblings", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaults: { executionMode: "interactive", harness: "copilot-cli" },
        execution: { scriptTimeoutSec: 60 },
      }),
      "utf-8"
    );
    const backend = new FileConfigBackend(configPath);
    await backend.set("defaults.executionMode", "headless");
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.strictEqual(content.defaults.executionMode, "headless");
    assert.strictEqual(content.defaults.harness, "copilot-cli");
    assert.strictEqual(content.execution.scriptTimeoutSec, 60);
  });

  test("set() with undefined removes the key", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaults: { harness: "claude-cli" },
        diagnostics: { verboseLogging: true },
      }),
      "utf-8"
    );
    const backend = new FileConfigBackend(configPath);
    await backend.set("diagnostics.verboseLogging", undefined);
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.ok(
      !("verboseLogging" in content.diagnostics),
      "key should be deleted when value is undefined"
    );
  });

  test("set() rejects prototype-sensitive path segments", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    const original = Buffer.from('{"ui":{"showCostEstimates":true}}', "utf-8");
    fs.writeFileSync(configPath, original);
    const backend = new FileConfigBackend(configPath);

    for (const settingPath of [
      "__proto__.polluted",
      "constructor.prototype.polluted",
      "ui.prototype.polluted",
    ]) {
      await assert.rejects(
        async () => backend.set(settingPath, "yes"),
        /path segment .* is not allowed/
      );
    }

    assert.strictEqual(({} as Record<string, unknown>).polluted, undefined);
    assert.deepStrictEqual(fs.readFileSync(configPath), original);
  });

  test("uses unique process-scoped names for atomic temp files", () => {
    const configPath = path.join(tmpDir, "settings.json");
    const first = uniqueAtomicTempPath(configPath);
    const second = uniqueAtomicTempPath(configPath);
    const prefix = `${configPath}.${process.pid}.`;
    const randomSuffix = first.slice(prefix.length, -".tmp".length);

    assert.ok(first.startsWith(prefix));
    assert.match(randomSuffix, /^[0-9a-f-]{36}$/);
    assert.ok(first.endsWith(".tmp"));
    assert.notStrictEqual(first, second);
  });

  test("filePath getter returns the configured path", () => {
    const configPath = path.join(tmpDir, "settings.json");
    const backend = new FileConfigBackend(configPath);
    assert.strictEqual(backend.filePath, configPath);
  });

  test("reads newer settings best-effort but refuses to write them", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    const original = {
      schemaVersion: 2,
      defaults: { harness: "claude-cli" },
      futureSettings: { retained: true },
    };
    fs.writeFileSync(configPath, JSON.stringify(original), "utf8");
    const backend = new FileConfigBackend(configPath);

    assert.strictEqual(backend.getAll().defaults?.harness, "claude-cli");
    assert.strictEqual(backend.isReadOnly, true);
    await assert.rejects(
      backend.set("defaults.harness", "codex-cli"),
      /settings was written by a newer version of ctrlyoke/u
    );
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(configPath, "utf8")),
      original
    );
  });

  test("concurrent set() calls to different paths do not clobber each other", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    const backend = new FileConfigBackend(configPath);
    // Mirrors TerminalControlBarEditor's addShortcut(), which fires two
    // onUpdate() calls to different paths for one user action without
    // awaiting the first. Without serialized writes, the second set()'s
    // read-modify-write can race ahead of the first and silently drop it.
    await Promise.all([
      backend.set("terminal.mobileCustomShortcuts", [
        { id: "abc-123", label: "", sequence: "" },
      ]),
      backend.set("terminal.mobileBarLayout", {
        bar: ["key:esc"],
        popup: ["abc-123"],
        hidden: [],
      }),
    ]);
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.deepStrictEqual(content.terminal.mobileCustomShortcuts, [
      { id: "abc-123", label: "", sequence: "" },
    ]);
    assert.deepStrictEqual(content.terminal.mobileBarLayout, {
      bar: ["key:esc"],
      popup: ["abc-123"],
      hidden: [],
    });
  });

  test("serializes concurrent writes from backends for the same path", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    const userBackend = new FileConfigBackend(configPath);
    const workspaceBackend = new FileConfigBackend(
      `${tmpDir}${path.sep}nested${path.sep}..${path.sep}settings.json`
    );

    await Promise.all([
      userBackend.set("ui.showCliCommand", false),
      workspaceBackend.set("execution.injectMode", false),
    ]);

    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.strictEqual(content.ui.showCliCommand, false);
    assert.strictEqual(content.execution.injectMode, false);
  });

  test("shares cached reads across scopes backed by the same file", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ui: { showCliCommand: true } }),
      "utf-8"
    );
    const service = new CtrlYokeConfigService();
    service.setUserBackend(new FileConfigBackend(configPath));
    service.setWorkspaceBackend(new FileConfigBackend(configPath));

    assert.strictEqual(service.get("ui").showCliCommand, true);
    await service.set("ui.showCliCommand", false, "user");

    assert.strictEqual(service.get("ui").showCliCommand, false);
  });

  test("round-trips step color mode and harness color settings", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    const backend = new FileConfigBackend(configPath);
    const service = new CtrlYokeConfigService();
    service.setUserBackend(backend);

    await service.set("ui.stepColorMode", "none", "user");
    await service.set(
      "ui.harnessColors.byHarness.claude-cli",
      "#123456",
      "user"
    );
    await service.set("ui.harnessColors.script", "#654321", "user");

    assert.strictEqual(service.get("ui").stepColorMode, "none");
    assert.deepStrictEqual(service.get("ui").harnessColors, {
      byHarness: { "claude-cli": "#123456" },
      script: "#654321",
    });
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(configPath, "utf-8")).ui.harnessColors,
      {
        byHarness: { "claude-cli": "#123456" },
        script: "#654321",
      }
    );
  });

  test("round-trips coordination settings through CtrlYokeConfigService", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    const backend = new FileConfigBackend(configPath);
    const service = new CtrlYokeConfigService();
    service.setUserBackend(backend);

    await service.set("coordination.maxEntries", 12, "user");
    await service.set("coordination.maxNoteLength", 3210, "user");
    await service.set("coordination.allowExternalParticipants", false, "user");

    assert.strictEqual(service.get("coordination").maxEntries, 12);
    assert.strictEqual(service.get("coordination").maxNoteLength, 3210);
    assert.strictEqual(
      service.get("coordination").allowExternalParticipants,
      false
    );
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(configPath, "utf-8")).coordination,
      {
        maxEntries: 12,
        maxNoteLength: 3210,
        allowExternalParticipants: false,
      }
    );
  });
});
