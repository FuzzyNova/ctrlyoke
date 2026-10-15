import * as assert from "assert";
import { suite, test } from "mocha";
import {
  parsePowerShellBatchProxyTarget,
  resolveCliCommand,
  setWindowsCommandMetadataResolverForTests,
} from "../../core/harness/shared/CliLauncherResolver";

suite("CliLauncherResolver", () => {
  test("recognizes a pure PowerShell batch proxy", () => {
    const target = "C:\\Users\\test user\\AppData\\copilotCli\\copilot.ps1";
    const contents =
      '@echo off\r\npowershell -ExecutionPolicy Bypass -File "' +
      target +
      '" %*\r\n';

    assert.strictEqual(parsePowerShellBatchProxyTarget(contents), target);
  });

  test("accepts powershell.exe and case-insensitive proxy syntax", () => {
    const target = "C:\\Tools\\copilot.ps1";
    const contents =
      '@ECHO OFF\nPowerShell.exe -executionpolicy bypass -file "' +
      target +
      '" %*';

    assert.strictEqual(parsePowerShellBatchProxyTarget(contents), target);
  });

  test("does not reinterpret general batch scripts", () => {
    const npmShim = [
      "@ECHO off",
      "SETLOCAL",
      'node "%~dp0\\node_modules\\tool\\cli.js" %*',
    ].join("\r\n");
    const proxyWithExtraCommand = [
      "@echo off",
      'powershell -ExecutionPolicy Bypass -File "C:\\Tools\\copilot.ps1" %*',
      "echo done",
    ].join("\r\n");

    assert.strictEqual(parsePowerShellBatchProxyTarget(npmShim), undefined);
    assert.strictEqual(
      parsePowerShellBatchProxyTarget(proxyWithExtraCommand),
      undefined
    );
  });

  test("rejects non-absolute and non-PowerShell targets", () => {
    assert.strictEqual(
      parsePowerShellBatchProxyTarget(
        '@echo off\npowershell -ExecutionPolicy Bypass -File "copilot.ps1" %*'
      ),
      undefined
    );
    assert.strictEqual(
      parsePowerShellBatchProxyTarget(
        '@echo off\npowershell -ExecutionPolicy Bypass -File "C:\\Tools\\copilot.cmd" %*'
      ),
      undefined
    );
  });

  test("retries a failed Windows lookup and caches a resolved launcher", async () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform"
    );
    Object.defineProperty(process, "platform", { value: "win32" });
    let probeCount = 0;
    const restoreResolver = setWindowsCommandMetadataResolverForTests(
      async () => {
        probeCount += 1;
        return probeCount === 1 ? undefined : { Path: "C:\\Tools\\codex.exe" };
      }
    );

    try {
      const fallback = await resolveCliCommand("codex", ["--version"]);
      assert.strictEqual(fallback.launcherKind, "direct");
      assert.strictEqual(fallback.resolvedPath, undefined);

      const resolved = await resolveCliCommand("codex", ["--version"]);
      assert.strictEqual(resolved.resolvedPath, "C:\\Tools\\codex.exe");
      assert.strictEqual(resolved.command, "C:\\Tools\\codex.exe");

      await resolveCliCommand("codex", ["--help"]);
      assert.strictEqual(probeCount, 2, "successful launcher should be cached");
    } finally {
      restoreResolver();
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
    }
  });
});
