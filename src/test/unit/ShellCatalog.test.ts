import * as assert from "assert";
import { suite, test } from "mocha";
import {
  SHELL_KINDS,
  SHELL_TYPES,
  UI_PLATFORMS,
} from "../../types/DashboardConstants";
import {
  MULTILINE_CMD_SCRIPT_ERROR,
  SHELL_CHOICES,
  SHELL_KIND_PLATFORMS,
  findShellChoice,
  getShellInvocationError,
  isShellAvailableOnPlatform,
  resolveShellKind,
  shellChoicesForPlatform,
  shellDisplayName,
} from "../../utils/ShellCatalog";

suite("ShellCatalog", () => {
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

  test("strips directories and the .exe suffix from a display name", () => {
    assert.strictEqual(shellDisplayName("/bin/zsh"), SHELL_TYPES.ZSH);
    assert.strictEqual(
      shellDisplayName("C:\\Program Files\\Git\\bin\\bash.exe"),
      SHELL_TYPES.BASH
    );
  });

  test("offers every catalog shell on some platform, and only Windows shells on Windows", () => {
    for (const choice of SHELL_CHOICES) {
      assert.ok(
        SHELL_KIND_PLATFORMS[choice.kind].length > 0,
        `${choice.value} is offered but available nowhere`
      );
    }

    const windows = shellChoicesForPlatform(UI_PLATFORMS.WINDOWS).map(
      (choice) => choice.value
    );
    assert.ok(windows.includes(SHELL_KINDS.PWSH));
    assert.ok(windows.includes(SHELL_TYPES.CMD));
    // Git for Windows ships bash, so it stays offered there.
    assert.ok(windows.includes(SHELL_TYPES.BASH));
    assert.ok(!windows.includes(SHELL_TYPES.ZSH));

    const mac = shellChoicesForPlatform(UI_PLATFORMS.MAC).map(
      (choice) => choice.value
    );
    assert.ok(mac.includes(SHELL_TYPES.ZSH));
    assert.ok(!mac.includes(SHELL_TYPES.CMD));
    assert.ok(!mac.includes(SHELL_KINDS.POWERSHELL));
  });

  test("recognizes a catalog shell written as a path, an alias, or an .exe", () => {
    assert.strictEqual(findShellChoice("/bin/zsh")?.value, SHELL_TYPES.ZSH);
    assert.strictEqual(findShellChoice("ZSH")?.value, SHELL_TYPES.ZSH);
    assert.strictEqual(findShellChoice("cmd.exe")?.value, SHELL_TYPES.CMD);
    assert.strictEqual(findShellChoice("/bin/dash")?.value, SHELL_TYPES.SH);
    assert.strictEqual(findShellChoice("nushell")?.value, SHELL_TYPES.NU);
  });

  test("does not fold an unrecognized executable into bash the way resolveShellKind does", () => {
    assert.strictEqual(findShellChoice("C:\\tools\\myshell.exe"), undefined);
    assert.strictEqual(findShellChoice(""), undefined);
    // resolveShellKind's catch-all still answers bash for execution purposes.
    assert.strictEqual(
      resolveShellKind("C:\\tools\\myshell.exe"),
      SHELL_KINDS.BASH
    );
  });

  test("reports platform availability for a pinned shell", () => {
    assert.strictEqual(
      isShellAvailableOnPlatform("zsh", UI_PLATFORMS.WINDOWS),
      false
    );
    assert.strictEqual(
      isShellAvailableOnPlatform("/bin/zsh", UI_PLATFORMS.MAC),
      true
    );
    assert.strictEqual(
      isShellAvailableOnPlatform("cmd", UI_PLATFORMS.MAC),
      false
    );
    assert.strictEqual(
      isShellAvailableOnPlatform("pwsh", UI_PLATFORMS.LINUX),
      true
    );
    // An unrecognized custom path must never be reported as unavailable.
    assert.strictEqual(
      isShellAvailableOnPlatform(
        "C:\\tools\\myshell.exe",
        UI_PLATFORMS.WINDOWS
      ),
      true
    );
  });

  test("flags a multi-line script pinned to cmd", () => {
    assert.strictEqual(
      getShellInvocationError("echo one\necho two", SHELL_KINDS.CMD),
      MULTILINE_CMD_SCRIPT_ERROR
    );
    // Pinned literally: this text is what both the runtime error and the
    // authoring-time dropdown warning show the user.
    assert.strictEqual(
      MULTILINE_CMD_SCRIPT_ERROR,
      "Multi-line scripts cannot run under cmd. Set this script's `shell` field to a shell that supports multi-line scripts, for example `shell: pwsh`."
    );
    assert.strictEqual(
      getShellInvocationError("echo one", SHELL_KINDS.CMD),
      undefined
    );
    assert.strictEqual(
      getShellInvocationError("echo one\necho two", SHELL_KINDS.PWSH),
      undefined
    );
  });
});
