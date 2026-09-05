import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import {
  CtrlYokeConfigService,
  type ConfigBackend,
} from "../../config/CtrlYokeConfigService";
import { FileConfigBackend } from "../../config/FileConfigBackend";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";

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
      all.queue.maxSize,
      CTRLYOKE_SETTINGS_DEFAULTS.queue.maxSize
    );
    assert.strictEqual(
      all.queue.maxParallelSteps,
      CTRLYOKE_SETTINGS_DEFAULTS.queue.maxParallelSteps
    );
    assert.strictEqual(
      all.enableDiagnosticLogs,
      CTRLYOKE_SETTINGS_DEFAULTS.enableDiagnosticLogs
    );
    assert.strictEqual(
      all.permissions.statusLineTracking.antigravity.enabled,
      true
    );
    assert.strictEqual(
      all.ui.collapsedToolOutputLineCount,
      CTRLYOKE_SETTINGS_DEFAULTS.ui.collapsedToolOutputLineCount
    );
  });

  test("resolves nested statusline settings through the config hierarchy", () => {
    service.setUserBackend(
      makeBackend({
        permissions: {
          statusLineTracking: {
            antigravity: {
              enabled: false,
              customCommand: "",
              useCtrlyokeStyle: true,
            },
          },
        },
      })
    );
    assert.strictEqual(
      service.get("permissions").statusLineTracking.antigravity.enabled,
      false
    );

    service.setWorkspaceBackend(
      makeBackend({
        permissions: {
          statusLineTracking: {
            antigravity: {
              enabled: true,
              customCommand: "",
              useCtrlyokeStyle: true,
            },
          },
        },
      })
    );
    assert.strictEqual(
      service.get("permissions").statusLineTracking.antigravity.enabled,
      false,
      "workspace statusline values are ignored because they are machine-scoped"
    );
  });

  test("user backend values override defaults", () => {
    service.setUserBackend(
      makeBackend({
        defaults: { harness: "claude-cli" },
        enableDiagnosticLogs: true,
      })
    );
    const all = service.getAll();
    assert.strictEqual(all.defaults.harness, "claude-cli");
    assert.strictEqual(all.enableDiagnosticLogs, true);
    // Other defaults should still be present
    assert.strictEqual(
      all.defaults.executionMode,
      CTRLYOKE_SETTINGS_DEFAULTS.defaults.executionMode
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
      all.execution.scriptTimeout,
      CTRLYOKE_SETTINGS_DEFAULTS.execution.scriptTimeout
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
          permissions: { allowedExternalFileRoots: ["/home/user/logs"] },
        })
      );
      service.setWorkspaceBackend(
        makeBackend({
          permissions: { allowedExternalFileRoots: ["/shared/logs"] },
        })
      );
      assert.deepStrictEqual(
        service.getScoped("permissions", "user")?.allowedExternalFileRoots,
        ["/home/user/logs"]
      );
      assert.deepStrictEqual(
        service.getScoped("permissions", "workspace")?.allowedExternalFileRoots,
        ["/shared/logs"]
      );
    });

    test("ignores the CLI overlay entirely", () => {
      service.setCliOverlay({
        permissions: { allowedExternalFileRoots: ["/cli/only"] },
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
        "permissions.statusLineTracking.claude.enabled",
        false,
        "workspace"
      ),
      /machine-scoped/
    );
    await assert.rejects(
      service.set("usageTracking.enabled", false, "workspace"),
      /machine-scoped/
    );
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
        permissions: {
          statusLineTracking: {
            antigravity: {
              enabled: true,
              customCommand: "user-command",
              useCtrlyokeStyle: true,
            },
          },
        },
        usageTracking: {
          enabled: true,
          providerRefreshEnabled: false,
        },
      })
    );
    service.setWorkspaceBackend({
      filePath: "workspace-settings.json",
      getAll: () => ({
        permissions: {
          statusLineTracking: {
            antigravity: {
              enabled: false,
              customCommand: "workspace-command",
              useCtrlyokeStyle: false,
            },
          },
          allowedExternalFileRoots: ["/shared/logs"],
        },
        usageTracking: {
          enabled: false,
          providerRefreshEnabled: true,
        },
      }),
      set: async () => {},
    });

    assert.strictEqual(
      service.get("permissions").statusLineTracking.antigravity.enabled,
      true
    );
    assert.deepStrictEqual(
      service.get("permissions").allowedExternalFileRoots,
      ["/shared/logs"]
    );
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
      service.getScoped("permissions", "workspace")?.statusLineTracking,
      undefined
    );
    assert.strictEqual(service.resolve("permissions").source, "workspace");
    assert.strictEqual(
      service.getLeafSources()["usageTracking.enabled"],
      "user"
    );
    assert.strictEqual(
      service.getLeafSources()["permissions.statusLineTracking.antigravity"],
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
// FileConfigBackend tests
// ---------------------------------------------------------------------------

suite("FileConfigBackend", () => {
  let tmpDir: string;

  setup(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fp-config-test-"));
  });

  teardown(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
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
        enableDiagnosticLogs: true,
      }),
      "utf-8"
    );
    const backend = new FileConfigBackend(configPath);
    const result = backend.getAll();
    assert.strictEqual(result.defaults?.harness, "claude-cli");
    assert.strictEqual(result.enableDiagnosticLogs, true);
  });

  test("getAll() returns {} on invalid JSON", () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(configPath, "{ invalid json }", "utf-8");
    const backend = new FileConfigBackend(configPath);
    assert.deepStrictEqual(backend.getAll(), {});
  });

  test("set() creates file and directory if they do not exist", async () => {
    const configPath = path.join(tmpDir, "sub", "settings.json");
    const backend = new FileConfigBackend(configPath);
    await backend.set("defaults.harness", "claude-cli");
    assert.ok(fs.existsSync(configPath), "config file should be created");
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.strictEqual(content.defaults?.harness, "claude-cli");
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
        execution: { scriptTimeout: 60 },
      }),
      "utf-8"
    );
    const backend = new FileConfigBackend(configPath);
    await backend.set("defaults.executionMode", "headless");
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.strictEqual(content.defaults.executionMode, "headless");
    assert.strictEqual(content.defaults.harness, "copilot-cli");
    assert.strictEqual(content.execution.scriptTimeout, 60);
  });

  test("set() with undefined removes the key", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        defaults: { harness: "claude-cli" },
        enableDiagnosticLogs: true,
      }),
      "utf-8"
    );
    const backend = new FileConfigBackend(configPath);
    await backend.set("enableDiagnosticLogs", undefined);
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.ok(
      !("enableDiagnosticLogs" in content),
      "key should be deleted when value is undefined"
    );
  });

  test("filePath getter returns the configured path", () => {
    const configPath = path.join(tmpDir, "settings.json");
    const backend = new FileConfigBackend(configPath);
    assert.strictEqual(backend.filePath, configPath);
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

  test("round-trips step color settings through the config hierarchy", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    const backend = new FileConfigBackend(configPath);
    const service = new CtrlYokeConfigService();
    service.setUserBackend(backend);

    await service.set("ui.stepColors.enabled", false, "user");
    await service.set("ui.stepColors.byHarness.claude-cli", "#123456", "user");
    await service.set("ui.stepColors.script", "#654321", "user");

    assert.deepStrictEqual(service.get("ui").stepColors, {
      enabled: false,
      byHarness: { "claude-cli": "#123456" },
      script: "#654321",
    });
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(configPath, "utf-8")).ui.stepColors,
      {
        enabled: false,
        byHarness: { "claude-cli": "#123456" },
        script: "#654321",
      }
    );
  });
});
