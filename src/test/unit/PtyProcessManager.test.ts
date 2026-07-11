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
