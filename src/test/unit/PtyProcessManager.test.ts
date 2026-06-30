import * as assert from "assert";
import { suite, test } from "mocha";
import { SHELL_KINDS } from "../../types/DashboardConstants";
import { resolveShellKind } from "../../core/harness/PtyProcessManager";

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
