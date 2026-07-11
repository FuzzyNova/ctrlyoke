import * as assert from "assert";
import { suite, test } from "mocha";
import { SHELL_KINDS } from "../../types/DashboardConstants";
import {
  PtyProcessManager,
  resolveShellKind,
  type PtyDimensionsPersistence,
} from "../../core/harness/PtyProcessManager";

suite("PtyProcessManager spawn dimensions", () => {
  test("defaults to 220x50 when no size has been persisted or observed", () => {
    const manager = new PtyProcessManager();
    assert.deepStrictEqual(manager.getSpawnDimensions(), {
      cols: 220,
      rows: 50,
    });
  });

  test("applies a persisted controller size as the spawn size", () => {
    const persistence: PtyDimensionsPersistence = {
      loadDimensions: () => ({ cols: 56, rows: 29 }),
      saveDimensions: () => {},
    };
    const manager = new PtyProcessManager();
    manager.setDimensionsPersistence(persistence);
    assert.deepStrictEqual(manager.getSpawnDimensions(), {
      cols: 56,
      rows: 29,
    });
  });

  test("ignores absent or non-positive persisted dimensions", () => {
    const manager = new PtyProcessManager();
    manager.setDimensionsPersistence({
      loadDimensions: () => undefined,
      saveDimensions: () => {},
    });
    assert.deepStrictEqual(manager.getSpawnDimensions(), {
      cols: 220,
      rows: 50,
    });

    manager.setDimensionsPersistence({
      loadDimensions: () => ({ cols: 0, rows: 0 }),
      saveDimensions: () => {},
    });
    assert.deepStrictEqual(manager.getSpawnDimensions(), {
      cols: 220,
      rows: 50,
    });
  });

  test("setSpawnDimensions updates a client's size and ignores non-positive values", () => {
    const manager = new PtyProcessManager();
    manager.setSpawnDimensions("client-1", 80, 24);
    assert.deepStrictEqual(manager.getSpawnDimensions("client-1"), {
      cols: 80,
      rows: 24,
    });
    // Non-positive dimensions (e.g. a 0×0 collapsed container) are ignored.
    manager.setSpawnDimensions("client-1", 0, 24);
    manager.setSpawnDimensions("client-1", 80, -1);
    assert.deepStrictEqual(manager.getSpawnDimensions("client-1"), {
      cols: 80,
      rows: 24,
    });
  });

  test("keys spawn size by clientId — one client's size never leaks to another", () => {
    const manager = new PtyProcessManager();
    // Thin phone controls workflow A; wide desktop controls workflow B.
    manager.setSpawnDimensions("thin-tab", 40, 20);
    manager.setSpawnDimensions("wide-tab", 200, 50);
    assert.deepStrictEqual(manager.getSpawnDimensions("thin-tab"), {
      cols: 40,
      rows: 20,
    });
    assert.deepStrictEqual(manager.getSpawnDimensions("wide-tab"), {
      cols: 200,
      rows: 50,
    });
    // An unknown/absent client resolves to the cold-start fallback, not another
    // client's size.
    assert.deepStrictEqual(manager.getSpawnDimensions("never-seen"), {
      cols: 200,
      rows: 50, // last-reported fallback
    });
  });

  test("setSpawnDimensions persists the fallback only on an actual change", () => {
    const saved: Array<{ cols: number; rows: number }> = [];
    const manager = new PtyProcessManager();
    manager.setDimensionsPersistence({
      loadDimensions: () => undefined,
      saveDimensions: (dims) => saved.push(dims),
    });
    manager.setSpawnDimensions("c1", 100, 30); // change → persist
    manager.setSpawnDimensions("c1", 100, 30); // no change → no persist
    manager.setSpawnDimensions("c1", 120, 30); // change → persist
    assert.deepStrictEqual(saved, [
      { cols: 100, rows: 30 },
      { cols: 120, rows: 30 },
    ]);
  });
});

suite("PtyProcessManager", () => {
  test("should classify common shell executables", () => {
    assert.strictEqual(
      resolveShellKind("C:\\Program Files\\PowerShell\\7\\pwsh.exe"),
      SHELL_KINDS.PWSH
    );
    assert.strictEqual(
      resolveShellKind(
        "C:\\Program Files\\PowerShell\\7-preview\\pwsh-preview.exe"
      ),
      SHELL_KINDS.PWSH
    );
    assert.strictEqual(
      resolveShellKind("powershell.exe"),
      SHELL_KINDS.POWERSHELL
    );
    assert.strictEqual(resolveShellKind("/bin/zsh"), SHELL_KINDS.ZSH);
    assert.strictEqual(resolveShellKind("/bin/bash"), SHELL_KINDS.BASH);
    assert.strictEqual(resolveShellKind("/bin/dash"), SHELL_KINDS.SH);
    assert.strictEqual(resolveShellKind("/usr/bin/fish"), SHELL_KINDS.FISH);
    assert.strictEqual(
      resolveShellKind("C:\\Windows\\System32\\cmd.exe"),
      SHELL_KINDS.CMD
    );
    assert.strictEqual(
      resolveShellKind("C:\\Windows\\System32\\wsl.exe"),
      SHELL_KINDS.WSL
    );
    assert.strictEqual(
      resolveShellKind("/usr/bin/nushell"),
      SHELL_KINDS.NUSHELL
    );
  });
});
