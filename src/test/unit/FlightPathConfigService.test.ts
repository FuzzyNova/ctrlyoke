import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test, setup, teardown } from "mocha";
import {
  FlightPathConfigService,
  type ConfigBackend,
} from "../../config/FlightPathConfigService";
import { FileConfigBackend } from "../../config/FileConfigBackend";
import { FLIGHTPATH_SETTINGS_DEFAULTS } from "../../types/FlightPathSettings";
import type { PartialFlightPathSettings } from "../../types/FlightPathSettings";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeBackend(data: PartialFlightPathSettings): ConfigBackend {
  return {
    getAll: () => data,
    set: async (_path: string, _value: unknown) => {},
  };
}

// ---------------------------------------------------------------------------
// FlightPathConfigService tests
// ---------------------------------------------------------------------------

suite("FlightPathConfigService", () => {
  let service: FlightPathConfigService;

  setup(() => {
    service = new FlightPathConfigService();
  });

  test("returns all defaults when no backends are set", () => {
    const all = service.getAll();
    assert.strictEqual(all.defaults.harness, FLIGHTPATH_SETTINGS_DEFAULTS.defaults.harness);
    assert.strictEqual(
      all.execution.mode,
      FLIGHTPATH_SETTINGS_DEFAULTS.execution.mode
    );
    assert.strictEqual(
      all.queue.maxSize,
      FLIGHTPATH_SETTINGS_DEFAULTS.queue.maxSize
    );
    assert.strictEqual(
      all.enableDiagnosticLogs,
      FLIGHTPATH_SETTINGS_DEFAULTS.enableDiagnosticLogs
    );
  });

  test("user backend values override defaults", () => {
    service.setUserBackend(
      makeBackend({ defaults: { harness: "claude-cli" }, enableDiagnosticLogs: true })
    );
    const all = service.getAll();
    assert.strictEqual(all.defaults.harness, "claude-cli");
    assert.strictEqual(all.enableDiagnosticLogs, true);
    // Other defaults should still be present
    assert.strictEqual(
      all.execution.mode,
      FLIGHTPATH_SETTINGS_DEFAULTS.execution.mode
    );
  });

  test("workspace backend overrides user backend", () => {
    service.setUserBackend(makeBackend({ defaults: { harness: "claude-cli" } }));
    service.setWorkspaceBackend(makeBackend({ defaults: { harness: "codex-cli" } }));
    assert.strictEqual(service.get("defaults").harness, "codex-cli");
  });

  test("CLI overlay overrides workspace backend", () => {
    service.setUserBackend(makeBackend({ defaults: { harness: "claude-cli" } }));
    service.setWorkspaceBackend(makeBackend({ defaults: { harness: "codex-cli" } }));
    service.setCliOverlay({ defaults: { harness: "gemini-cli" } });
    assert.strictEqual(service.get("defaults").harness, "gemini-cli");
  });

  test("deep merge: workspace execution.mode does not wipe execution.scriptTimeout", () => {
    service.setWorkspaceBackend(
      makeBackend({ execution: { mode: "headless" } })
    );
    const all = service.getAll();
    assert.strictEqual(all.execution.mode, "headless");
    // scriptTimeout should still come from defaults
    assert.strictEqual(
      all.execution.scriptTimeout,
      FLIGHTPATH_SETTINGS_DEFAULTS.execution.scriptTimeout
    );
    assert.strictEqual(
      all.execution.closeTerminalOnComplete,
      FLIGHTPATH_SETTINGS_DEFAULTS.execution.closeTerminalOnComplete
    );
  });

  suite("resolve(key)", () => {
    test('returns source "default" when no backends set', () => {
      const result = service.resolve("defaults");
      assert.strictEqual(result.source, "default");
      assert.strictEqual((result.value as typeof FLIGHTPATH_SETTINGS_DEFAULTS.defaults).harness, FLIGHTPATH_SETTINGS_DEFAULTS.defaults.harness);
    });

    test('returns source "user" when user backend provides key', () => {
      service.setUserBackend(makeBackend({ defaults: { harness: "claude-cli" } }));
      const result = service.resolve("defaults");
      assert.strictEqual(result.source, "user");
      assert.strictEqual((result.value as typeof FLIGHTPATH_SETTINGS_DEFAULTS.defaults).harness, "claude-cli");
    });

    test('returns source "workspace" when workspace backend provides key', () => {
      service.setUserBackend(makeBackend({ defaults: { harness: "claude-cli" } }));
      service.setWorkspaceBackend(makeBackend({ defaults: { harness: "codex-cli" } }));
      const result = service.resolve("defaults");
      assert.strictEqual(result.source, "workspace");
      assert.strictEqual((result.value as typeof FLIGHTPATH_SETTINGS_DEFAULTS.defaults).harness, "codex-cli");
    });

    test('returns source "cli" when CLI overlay provides key', () => {
      service.setWorkspaceBackend(makeBackend({ defaults: { harness: "codex-cli" } }));
      service.setCliOverlay({ defaults: { harness: "gemini-cli" } });
      const result = service.resolve("defaults");
      assert.strictEqual(result.source, "cli");
      assert.strictEqual((result.value as typeof FLIGHTPATH_SETTINGS_DEFAULTS.defaults).harness, "gemini-cli");
    });
  });

  test('getNested("execution.mode") returns correct nested value', () => {
    service.setWorkspaceBackend(
      makeBackend({ execution: { mode: "headless" } })
    );
    assert.strictEqual(service.getNested("execution.mode"), "headless");
  });

  test("getNested returns default for unset nested key", () => {
    const defaultMode = FLIGHTPATH_SETTINGS_DEFAULTS.execution.mode;
    assert.strictEqual(service.getNested("execution.mode"), defaultMode);
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
      JSON.stringify({ defaults: { harness: "claude-cli" }, enableDiagnosticLogs: true }),
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
    await backend.set("defaults.harness", "gemini-cli");
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.strictEqual(content.defaults?.harness, "gemini-cli");
  });

  test("set() updates a nested setting without wiping siblings", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ execution: { mode: "interactive", scriptTimeout: 60 } }),
      "utf-8"
    );
    const backend = new FileConfigBackend(configPath);
    await backend.set("execution.mode", "headless");
    const content = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    assert.strictEqual(content.execution.mode, "headless");
    assert.strictEqual(content.execution.scriptTimeout, 60);
  });

  test("set() with undefined removes the key", async () => {
    const configPath = path.join(tmpDir, "settings.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ defaults: { harness: "claude-cli" }, enableDiagnosticLogs: true }),
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
});
