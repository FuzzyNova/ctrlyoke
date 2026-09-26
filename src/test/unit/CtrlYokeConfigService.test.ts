import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import {
  CtrlYokeConfigService,
  type ConfigBackend,
} from "../../config/CtrlYokeConfigService";
import { FileConfigBackend } from "../../config/FileConfigBackend";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import type { PartialCtrlYokeSettings } from "../../types/CtrlYokeSettings";
import { makeTempDir, removeTempDir } from "../helpers/tempWorkspace";

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

  test("set() creates file and directory if they do not exist", async () => {
    const configPath = path.join(tmpDir, "sub", "settings.json");
    const backend = new FileConfigBackend(configPath);
    await backend.set("defaults.harness", "claude-cli");
    assert.ok(fs.existsSync(configPath), "config file should be created");
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.strictEqual(content.defaults?.harness, "claude-cli");
    assert.strictEqual(content.schemaVersion, 1);
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
