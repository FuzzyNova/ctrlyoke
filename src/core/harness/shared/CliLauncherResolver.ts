import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { Log } from "../../../utils/Log";
import { resolveWindowsShell } from "../PtyProcessManager";
import { buildCmdExeVerbatimArgs } from "./WindowsCmdEscaping";

const execFileAsync = promisify(execFile);

type CliLauncherKind = "direct" | "powershell-file" | "cmd-file" | "node-shim";

interface CliLauncher {
  kind: CliLauncherKind;
  command: string;
  prefixArgs: string[];
  resolvedPath?: string;
}

interface WindowsCommandMetadata {
  CommandType?: string;
  Definition?: string;
  Name?: string;
  Path?: string;
  Source?: string;
}

export interface CliResolvedCommand {
  command: string;
  args: string[];
  displayCommand: string;
  launcherKind: CliLauncherKind;
  resolvedPath?: string;
  /**
   * True when `args` is already a fully cmd.exe-escaped verbatim payload
   * (see {@link buildCmdExeVerbatimArgs}) rather than plain argv entries.
   * Spawn call sites must pass this through as `windowsVerbatimArguments: true`
   * (`child_process`) or join `args` into a single string before handing it to
   * `node-pty` — otherwise a second layer of argv quoting double-escapes an
   * already-escaped payload. Only ever true for the `cmd-file` launcher kind.
   */
  requiresShellVerbatimArgs?: boolean;
}

const launcherCache = new Map<string, Promise<CliLauncher>>();
const MAX_BATCH_PROXY_BYTES = 16 * 1024;

export async function resolveCliCommand(
  commandName: string,
  args: string[]
): Promise<CliResolvedCommand> {
  const launcher = await getCliLauncher(commandName);

  // .cmd/.bat shims can only be interpreted by cmd.exe, which re-parses the
  // whole command line with its own metacharacter grammar — quoting args for
  // the eventual target program (the usual convention) does not protect them
  // from that pass. Build a verbatim-safe payload instead of appending plain
  // argv entries after "/c". See WindowsCmdEscaping.ts for why.
  if (launcher.kind === "cmd-file" && launcher.resolvedPath) {
    const displayArgs = [...launcher.prefixArgs, ...args];
    const verbatimArgs = buildCmdExeVerbatimArgs(launcher.resolvedPath, args);

    return {
      command: launcher.command,
      args: verbatimArgs,
      displayCommand: formatCommandForDisplay(launcher.command, displayArgs),
      launcherKind: launcher.kind,
      resolvedPath: launcher.resolvedPath,
      requiresShellVerbatimArgs: true,
    };
  }

  const resolvedArgs = [...launcher.prefixArgs, ...args];

  return {
    command: launcher.command,
    args: resolvedArgs,
    displayCommand: formatCommandForDisplay(launcher.command, resolvedArgs),
    launcherKind: launcher.kind,
    resolvedPath: launcher.resolvedPath,
  };
}

function formatCommandForDisplay(command: string, args: string[]): string {
  return [command, ...args].map(formatDisplayArg).join(" ");
}

async function getCliLauncher(commandName: string): Promise<CliLauncher> {
  const cacheKey =
    process.platform === "win32"
      ? `win32:${commandName.toLowerCase()}`
      : `${process.platform}:${commandName}`;
  const cached = launcherCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const resolutionPromise =
    process.platform === "win32"
      ? resolveWindowsLauncher(commandName)
      : Promise.resolve({
          kind: "direct" as const,
          command: commandName,
          prefixArgs: [],
        });

  launcherCache.set(cacheKey, resolutionPromise);
  return resolutionPromise;
}

async function resolveWindowsLauncher(
  commandName: string
): Promise<CliLauncher> {
  const shell = resolveWindowsShell();
  const metadata = await getWindowsCommandMetadata(commandName, shell);

  if (!metadata) {
    Log.warn(
      `⚠️ Failed to resolve Windows launcher for ${commandName}; using direct invocation`
    );
    return {
      kind: "direct",
      command: commandName,
      prefixArgs: [],
    };
  }

  const resolvedPath = getWindowsCommandPath(metadata);
  if (!resolvedPath) {
    return {
      kind: "direct",
      command: commandName,
      prefixArgs: [],
    };
  }

  const extension = path.extname(resolvedPath).toLowerCase();
  Log.debug(
    `[CliLauncherResolver] ${commandName} → "${resolvedPath}" (${extension || "no ext"})`
  );

  if (extension === ".ps1") {
    return {
      kind: "powershell-file",
      command: shell,
      prefixArgs: ["-NoProfile", "-File", resolvedPath],
      resolvedPath,
    };
  }

  if (extension === ".cmd" || extension === ".bat") {
    const powershellProxyTarget =
      await resolvePowerShellBatchProxyTarget(resolvedPath);
    if (powershellProxyTarget) {
      Log.debug(
        `[CliLauncherResolver] bypassing PowerShell batch proxy "${resolvedPath}" → "${powershellProxyTarget}"`
      );
      return {
        kind: "powershell-file",
        command: shell,
        prefixArgs: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          powershellProxyTarget,
        ],
        resolvedPath: powershellProxyTarget,
      };
    }

    const nodeShimTarget = await resolveNodeCliShimTarget(resolvedPath, shell);
    if (nodeShimTarget) {
      Log.debug(
        `[CliLauncherResolver] bypassing npm cmd shim "${resolvedPath}" → "${nodeShimTarget.nodePath}" "${nodeShimTarget.scriptPath}"`
      );
      return {
        kind: "node-shim",
        command: nodeShimTarget.nodePath,
        prefixArgs: [nodeShimTarget.scriptPath],
        resolvedPath: nodeShimTarget.scriptPath,
      };
    }

    return {
      kind: "cmd-file",
      command: "cmd.exe",
      prefixArgs: ["/c", resolvedPath],
      resolvedPath,
    };
  }

  return {
    kind: "direct",
    command: resolvedPath,
    prefixArgs: [],
    resolvedPath,
  };
}

/**
 * Recognize the VS Code Copilot launcher shape:
 *
 *   @echo off
 *   powershell -ExecutionPolicy Bypass -File "C:\...\copilot.ps1" %*
 *
 * Launching that proxy through cmd.exe inserts an extra console/shell boundary
 * that prevents Copilot's interactive `-i` prompt from reaching its TUI. Calling
 * the referenced PowerShell file directly preserves argv boundaries and the PTY.
 *
 * The match is intentionally strict — batch files that don't match this exact
 * shape fall through to {@link parseNpmCmdShimScriptRelativePath}, and failing
 * that, the generic cmd.exe route.
 */
export function parsePowerShellBatchProxyTarget(
  contents: string
): string | undefined {
  const match = contents.match(
    /^\s*@echo\s+off\s*\r?\n\s*powershell(?:\.exe)?\s+-ExecutionPolicy\s+Bypass\s+-File\s+"([^"\r\n]+)"\s+%\*\s*$/i
  );
  const target = match?.[1]?.trim();
  if (
    !target ||
    !path.win32.isAbsolute(target) ||
    path.win32.extname(target).toLowerCase() !== ".ps1"
  ) {
    return undefined;
  }
  return target;
}

async function resolvePowerShellBatchProxyTarget(
  batchPath: string
): Promise<string | undefined> {
  try {
    const stat = await fs.promises.stat(batchPath);
    if (!stat.isFile() || stat.size > MAX_BATCH_PROXY_BYTES) {
      return undefined;
    }

    const contents = await fs.promises.readFile(batchPath, "utf8");
    const target = parsePowerShellBatchProxyTarget(contents);
    if (!target) {
      return undefined;
    }

    const targetStat = await fs.promises.stat(target);
    return targetStat.isFile() ? target : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Recognize npm's standard Windows `.cmd` shim template (generated by the
 * `cmd-shim` package for every npm global/local bin, e.g. `codex.cmd`,
 * `opencode.cmd`, `qwen.cmd`) and extract the relative path to the JS entry
 * point it ultimately runs via `node`:
 *
 *   @ECHO off
 *   GOTO start
 *   :find_dp0
 *   SET dp0=%~dp0
 *   EXIT /b
 *   :start
 *   SETLOCAL
 *   CALL :find_dp0
 *
 *   IF EXIST "%dp0%\node.exe" (
 *     SET "_prog=%dp0%\node.exe"
 *   ) ELSE (
 *     SET "_prog=node"
 *     SET PATHEXT=%PATHEXT:;.JS;=;%
 *   )
 *
 *   endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\<script>" %*
 *
 * Resolving this shim to its underlying `node <script>` invocation and
 * calling that directly — rather than routing through `cmd.exe /c <shim>` —
 * avoids cmd.exe's own metacharacter grammar entirely. That grammar (`< > &
 * | ^ "` and friends) reinterprets argv content that was only quoted for the
 * eventual target program; Codex's inline-hooks trust key legitimately
 * contains `<session-flags>`, and a payload combining that with TOML's
 * embedded double quotes breaks cmd.exe's own caret-escaping in ways that
 * are, empirically, not fixable by escaping alone (verified against real
 * cmd.exe: an argument shaped like `"C:\<session-flags>\config.toml"` fails
 * with "The system cannot find the file specified" even when every
 * metacharacter is caret-escaped per the standard algorithm — see
 * WindowsCmdEscaping.ts). Bypassing the shim sidesteps that class of bug
 * rather than chasing it.
 *
 * The match is intentionally strict — the template has been stable across
 * npm 7–10, but a non-matching `.cmd`/`.bat` file (a different generator, a
 * hand-written shim) falls through to the generic cmd.exe route.
 */
export function parseNpmCmdShimScriptRelativePath(
  contents: string
): string | undefined {
  const match = contents.match(
    /^\s*@ECHO off\r?\nGOTO start\r?\n:find_dp0\r?\nSET dp0=%~dp0\r?\nEXIT \/[bB]0?\r?\n:start\r?\nSETLOCAL\r?\nCALL :find_dp0\r?\n\r?\nIF EXIST "%dp0%\\node\.exe" \(\r?\n  SET "_prog=%dp0%\\node\.exe"\r?\n\) ELSE \(\r?\n  SET "_prog=node"\r?\n  SET PATHEXT=%PATHEXT:;\.JS;=;%\r?\n\)\r?\n\r?\nendLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"\s+"%dp0%\\(.+?)" %\*\r?\n?\s*$/
  );
  const relativePath = match?.[1]?.trim();
  return relativePath && !path.win32.isAbsolute(relativePath)
    ? relativePath
    : undefined;
}

async function resolveNodeCliShimTarget(
  batchPath: string,
  shell: string
): Promise<{ nodePath: string; scriptPath: string } | undefined> {
  try {
    const stat = await fs.promises.stat(batchPath);
    if (!stat.isFile() || stat.size > MAX_BATCH_PROXY_BYTES) {
      return undefined;
    }

    const contents = await fs.promises.readFile(batchPath, "utf8");
    const relativeScriptPath = parseNpmCmdShimScriptRelativePath(contents);
    if (!relativeScriptPath) {
      return undefined;
    }

    const dp0 = path.dirname(batchPath) + path.sep;
    const scriptPath = path.join(dp0, relativeScriptPath);
    const scriptStat = await fs.promises.stat(scriptPath);
    if (!scriptStat.isFile()) {
      return undefined;
    }

    const bundledNodeExe = path.join(dp0, "node.exe");
    const nodePath = (await fileExists(bundledNodeExe))
      ? bundledNodeExe
      : await resolveBareNodeExecutable(shell);

    return nodePath ? { nodePath, scriptPath } : undefined;
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function resolveBareNodeExecutable(
  shell: string
): Promise<string | undefined> {
  const metadata = await getWindowsCommandMetadata("node", shell);
  return metadata ? getWindowsCommandPath(metadata) : undefined;
}

async function getWindowsCommandMetadata(
  commandName: string,
  shell: string
): Promise<WindowsCommandMetadata | undefined> {
  try {
    const escapedName = escapePowerShellSingleQuoted(commandName);
    // Prefer Application (.exe, .cmd, .bat) over ExternalScript (.ps1).
    // npm .ps1 shims check $MyInvocation.ExpectingInput and pipe $input to node
    // when stdin is an open pipe, causing a 30-second hang via execFileAsync.
    // The .cmd counterpart calls node directly and avoids this issue.
    const script =
      `$cmd = Get-Command -Name '${escapedName}' -CommandType Application ` +
      `-ErrorAction SilentlyContinue | Select-Object -First 1 Name,CommandType,Source,Path,Definition; ` +
      `if (-not $cmd) { $cmd = Get-Command -Name '${escapedName}' -CommandType ExternalScript ` +
      `-ErrorAction SilentlyContinue | Select-Object -First 1 Name,CommandType,Source,Path,Definition }; ` +
      `if ($cmd) { $cmd | ConvertTo-Json -Compress }`;
    const { stdout } = await execFileAsync(
      shell,
      ["-NoProfile", "-Command", script],
      {
        encoding: "utf8",
        timeout: 5000,
      }
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = JSON.parse(trimmed) as
      | WindowsCommandMetadata
      | WindowsCommandMetadata[];
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (error) {
    Log.warn(
      `⚠️ Windows launcher resolution failed for ${commandName}: ${String(error)}`
    );
    return undefined;
  }
}

function getWindowsCommandPath(
  metadata: WindowsCommandMetadata
): string | undefined {
  const candidate =
    metadata.Source ?? metadata.Path ?? metadata.Definition ?? metadata.Name;
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return undefined;
  }
  return candidate.trim();
}

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function formatDisplayArg(arg: string): string {
  if (arg.length === 0) {
    return '""';
  }
  return /[\s"`'$&|<>()[\]{};,]/.test(arg) ? JSON.stringify(arg) : arg;
}
