import * as assert from "assert";
import { suite, test } from "mocha";
import { parsePowerShellBatchProxyTarget } from "../../core/harness/shared/CliLauncherResolver";

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
});
