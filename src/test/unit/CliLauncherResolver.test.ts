import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  parseNpmCmdShimExecutableRelativePath,
  parseNpmCmdShimScriptRelativePath,
  parsePowerShellBatchProxyTarget,
  redactMcpConfigArgs,
  resolveCliCommand,
  setWindowsCommandMetadataResolverForTests,
} from "../../core/harness/shared/CliLauncherResolver";

suite("CliLauncherResolver", () => {
  test("redacts inline MCP configuration before display or persistence", () => {
    const secretConfig = JSON.stringify({
      mcpServers: { server: { env: { TOKEN: "secret-value" } } },
    });
    assert.deepStrictEqual(
      redactMcpConfigArgs([
        "--model",
        "qwen3.5-plus",
        "--mcp-config",
        secretConfig,
      ]),
      ["--model", "qwen3.5-plus", "--mcp-config", "[REDACTED]"]
    );
  });

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

  const npmShimPreamble = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
  ];
  // Written by npm for OpenCode 1.19, whose bin is a native executable.
  const nativeExeShim = [
    ...npmShimPreamble,
    '"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*',
  ].join("\r\n");
  const nodeScriptShim = [
    ...npmShimPreamble,
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    "",
  ].join("\r\n");

  test("tells npm's native-executable shim apart from its node-script shim", () => {
    assert.strictEqual(
      parseNpmCmdShimExecutableRelativePath(nativeExeShim),
      "node_modules\\opencode-ai\\bin\\opencode.exe"
    );
    assert.strictEqual(
      parseNpmCmdShimScriptRelativePath(nativeExeShim),
      undefined
    );
    assert.strictEqual(
      parseNpmCmdShimScriptRelativePath(nodeScriptShim),
      "node_modules\\@openai\\codex\\bin\\codex.js"
    );
    assert.strictEqual(
      parseNpmCmdShimExecutableRelativePath(nodeScriptShim),
      undefined
    );
    assert.strictEqual(
      parseNpmCmdShimExecutableRelativePath(nativeExeShim + "\r\necho done"),
      undefined
    );
  });

  test("launches a native-executable npm shim's target directly", async function () {
    // The shim's target path uses `\`, which only Windows' path module and
    // file system resolve; faking process.platform cannot change that.
    if (process.platform !== "win32") this.skip();
    const originalPlatform = Object.getOwnPropertyDescriptor(
      process,
      "platform"
    );
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cy-shim-"));
    const shimPath = path.join(directory, "opencode.cmd");
    const exePath = path.join(
      directory,
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe"
    );
    fs.mkdirSync(path.dirname(exePath), { recursive: true });
    fs.writeFileSync(exePath, "");
    fs.writeFileSync(shimPath, nativeExeShim);
    Object.defineProperty(process, "platform", { value: "win32" });
    const restoreResolver = setWindowsCommandMetadataResolverForTests(
      async () => ({ Path: shimPath })
    );

    try {
      const prompt = 'say "hi" & exit';
      const resolved = await resolveCliCommand("opencode", ["run", prompt]);
      assert.strictEqual(resolved.launcherKind, "direct");
      assert.strictEqual(resolved.command, exePath);
      assert.deepStrictEqual(resolved.args, ["run", prompt]);
      assert.ok(!resolved.requiresShellVerbatimArgs);
    } finally {
      restoreResolver();
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform);
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
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
