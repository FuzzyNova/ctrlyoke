import * as assert from "assert";
import { spawn } from "child_process";
import { suite, test } from "mocha";
import {
  buildShellWrapArgs,
  resolveShellInvocation,
  shellNeedsVerbatimArguments,
  toPtySpawnArgs,
} from "../../core/harness/PtyProcessManager";
import { resolveScriptInvocation } from "../../core/orchestration/ScriptProcessRunner";
import { SHELL_KINDS } from "../../types/DashboardConstants";
import { ConfigurationUtils } from "../../utils/ConfigurationUtils";

/**
 * Exit-code propagation is the contract end conditions compare against, and it
 * is shell-specific: `sh -c` and `cmd /c` propagate a child's status while
 * PowerShell does not. These tests pin the wrapping that makes every shell
 * behave the same way.
 */
suite("Shell invocation", () => {
  function withTerminalShell<T>(shellExecutable: string, callback: () => T): T {
    const originalGetTerminalSettings = ConfigurationUtils.getTerminalSettings;
    ConfigurationUtils.getTerminalSettings = () => ({
      ...originalGetTerminalSettings(),
      shellExecutable,
    });
    try {
      return callback();
    } finally {
      ConfigurationUtils.getTerminalSettings = originalGetTerminalSettings;
    }
  }

  suite("resolveShellInvocation", () => {
    test("prefers a pinned override over terminal.shellExecutable", () => {
      const invocation = withTerminalShell("cmd.exe", () =>
        resolveShellInvocation("echo hello", "  bash  ")
      );

      assert.strictEqual(invocation.executable, "bash");
      assert.strictEqual(invocation.shellKind, SHELL_KINDS.BASH);
      assert.strictEqual(invocation.windowsVerbatimArguments, false);
    });

    test("falls through to terminal.shellExecutable for empty overrides", () => {
      const invocation = withTerminalShell("  cmd.exe  ", () =>
        resolveShellInvocation("echo hello", " \t ")
      );

      assert.strictEqual(invocation.executable, "cmd.exe");
      assert.strictEqual(invocation.shellKind, SHELL_KINDS.CMD);
      assert.strictEqual(invocation.windowsVerbatimArguments, true);
    });

    test("uses the script-step shell argv for worktree setup", () => {
      const script = "Write-Output setup";
      const [setupInvocation, scriptStepInvocation] = withTerminalShell(
        "bash",
        () => [
          resolveScriptInvocation(script),
          resolveShellInvocation(script),
        ]
      );

      assert.deepStrictEqual(setupInvocation.argv, [
        scriptStepInvocation.executable,
        ...scriptStepInvocation.args,
      ]);
      assert.strictEqual(
        setupInvocation.windowsVerbatimArguments,
        scriptStepInvocation.windowsVerbatimArguments
      );
    });

    test("falls through to platform auto-detection when neither override is set", () => {
      const invocation = withTerminalShell("  ", () =>
        resolveShellInvocation("echo hello", undefined, "win32")
      );

      assert.ok(invocation.executable.length > 0);
      assert.ok(
        invocation.shellKind === SHELL_KINDS.PWSH ||
          invocation.shellKind === SHELL_KINDS.POWERSHELL
      );
    });

    test("keeps cmd verbatim arguments enabled for a pinned cmd shell", () => {
      const invocation = withTerminalShell("powershell.exe", () =>
        resolveShellInvocation('node -e "process.exit(7)"', "cmd")
      );

      assert.strictEqual(invocation.shellKind, SHELL_KINDS.CMD);
      assert.strictEqual(invocation.windowsVerbatimArguments, true);
    });
  });

  suite("buildShellWrapArgs", () => {
    test("wraps POSIX shells with a bare -c and no epilogue", () => {
      assert.deepStrictEqual(buildShellWrapArgs(SHELL_KINDS.BASH, "exit 7"), [
        "-c",
        "exit 7",
      ]);
      assert.deepStrictEqual(buildShellWrapArgs(SHELL_KINDS.SH, "exit 7"), [
        "-c",
        "exit 7",
      ]);
    });

    test("wraps cmd with /d /c and no epilogue", () => {
      assert.deepStrictEqual(buildShellWrapArgs(SHELL_KINDS.CMD, "exit 7"), [
        "/d",
        "/c",
        "exit 7",
      ]);
    });

    test("wraps wsl through bash -lc", () => {
      assert.deepStrictEqual(buildShellWrapArgs(SHELL_KINDS.WSL, "exit 7"), [
        "-e",
        "bash",
        "-lc",
        "exit 7",
      ]);
    });

    for (const shellKind of [SHELL_KINDS.POWERSHELL, SHELL_KINDS.PWSH]) {
      test(`appends an exit-code epilogue for ${shellKind}`, () => {
        const args = buildShellWrapArgs(shellKind, "npm test");
        assert.deepStrictEqual(args.slice(0, 2), ["-NoProfile", "-Command"]);

        const script = args[2];
        // Separated by a newline so a script ending in a comment cannot
        // swallow the epilogue.
        assert.ok(script.startsWith("npm test\n"));
        // Prefers a native exit code, then falls back to $? rather than
        // reporting success for a failed cmdlet.
        assert.ok(
          script.includes("if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }")
        );
        assert.ok(script.includes("if (-not $__ctrlyokeOk) { exit 1 }"));
        assert.ok(script.trimEnd().endsWith("exit 0"));
      });
    }
  });

  suite("toPtySpawnArgs", () => {
    test("passes an array through when standard quoting is correct", () => {
      const args = ["-NoProfile", "-Command", 'echo "hi"'];
      assert.deepStrictEqual(toPtySpawnArgs(args, false), args);
    });

    test("does not alias the caller's array", () => {
      const args = ["-c", "true"];
      const result = toPtySpawnArgs(args, false);
      assert.notStrictEqual(result, args);
      assert.deepStrictEqual(result, args);
    });

    test("joins into one verbatim command line for cmd payloads", () => {
      // node-pty appends a string `args` after the command untouched; an array
      // would be re-quoted as \" and reach cmd.exe mangled.
      assert.strictEqual(
        toPtySpawnArgs(["/d", "/c", 'node -e "process.exit(7)"'], true),
        '/d /c node -e "process.exit(7)"'
      );
    });

    test("matches the shell resolution it is meant to pair with", () => {
      const cmdArgs = buildShellWrapArgs(SHELL_KINDS.CMD, 'echo "x"');
      assert.strictEqual(
        typeof toPtySpawnArgs(
          cmdArgs,
          shellNeedsVerbatimArguments(SHELL_KINDS.CMD)
        ),
        "string"
      );
      const bashArgs = buildShellWrapArgs(SHELL_KINDS.BASH, 'echo "x"');
      assert.ok(
        Array.isArray(
          toPtySpawnArgs(
            bashArgs,
            shellNeedsVerbatimArguments(SHELL_KINDS.BASH)
          )
        )
      );
    });
  });

  suite("shellNeedsVerbatimArguments", () => {
    test("is required only for cmd", () => {
      assert.strictEqual(shellNeedsVerbatimArguments(SHELL_KINDS.CMD), true);
      for (const shellKind of [
        SHELL_KINDS.POWERSHELL,
        SHELL_KINDS.PWSH,
        SHELL_KINDS.BASH,
        SHELL_KINDS.SH,
        SHELL_KINDS.ZSH,
        SHELL_KINDS.WSL,
      ]) {
        assert.strictEqual(shellNeedsVerbatimArguments(shellKind), false);
      }
    });
  });

  // Behavioral proof that the wrapping actually propagates exit codes. Runs the
  // real shell, so it is Windows-only and skips when the shell is unavailable.
  suite("exit-code propagation (windows)", function () {
    this.timeout(30000);

    function runWrapped(
      executable: string,
      shellKind: (typeof SHELL_KINDS)[keyof typeof SHELL_KINDS],
      script: string
    ): Promise<number | "unavailable"> {
      return new Promise((resolve) => {
        const child = spawn(executable, buildShellWrapArgs(shellKind, script), {
          shell: false,
          windowsVerbatimArguments: shellNeedsVerbatimArguments(shellKind),
        });
        child.on("error", () => resolve("unavailable"));
        child.on("close", (code) => resolve(code ?? -1));
      });
    }

    const cases: Array<[string, string, number]> = [
      ["a native non-zero exit", 'node -e "process.exit(7)"', 7],
      ["a native zero exit", 'node -e "process.exit(0)"', 0],
      ["an explicit exit", "exit 3", 3],
      [
        "a multi-line script",
        'Write-Output "step"\nnode -e "process.exit(4)"',
        4,
      ],
      ["a script ending in a comment", 'node -e "process.exit(5)"\n# done', 5],
    ];

    for (const [label, script, expected] of cases) {
      test(`powershell reports ${label}`, async function () {
        if (process.platform !== "win32") return this.skip();
        const code = await runWrapped(
          "powershell.exe",
          SHELL_KINDS.POWERSHELL,
          script
        );
        if (code === "unavailable") return this.skip();
        assert.strictEqual(code, expected);
      });
    }

    test("powershell still reports a failing cmdlet as non-zero", async function () {
      if (process.platform !== "win32") return this.skip();
      const code = await runWrapped(
        "powershell.exe",
        SHELL_KINDS.POWERSHELL,
        "Get-Item /definitely-no-such-path-xyz"
      );
      if (code === "unavailable") return this.skip();
      assert.notStrictEqual(code, 0);
    });

    test("cmd propagates a native exit code with verbatim arguments", async function () {
      if (process.platform !== "win32") return this.skip();
      const code = await runWrapped(
        "cmd.exe",
        SHELL_KINDS.CMD,
        'node -e "process.exit(7)"'
      );
      if (code === "unavailable") return this.skip();
      assert.strictEqual(code, 7);
    });
  });
});
