import { execFile } from "child_process";
import * as path from "path";
import { promisify } from "util";
import { Log } from "../../../utils/Log";
import { resolveWindowsShell } from "../PtyProcessManager";

const execFileAsync = promisify(execFile);
const WINDOWS_CMD_WRAPPER =
  "& $args[0] @($args | Select-Object -Skip 1)";

type CliLauncherKind = "direct" | "powershell-file" | "powershell-command";

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
}

const launcherCache = new Map<string, Promise<CliLauncher>>();

export async function resolveCliCommand(
  commandName: string,
  args: string[]
): Promise<CliResolvedCommand> {
  const launcher = await getCliLauncher(commandName);
  const resolvedArgs = [...launcher.prefixArgs, ...args];

  return {
    command: launcher.command,
    args: resolvedArgs,
    displayCommand: formatCommandForDisplay(launcher.command, resolvedArgs),
    launcherKind: launcher.kind,
    resolvedPath: launcher.resolvedPath,
  };
}

export function formatCommandForDisplay(
  command: string,
  args: string[]
): string {
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

async function resolveWindowsLauncher(commandName: string): Promise<CliLauncher> {
  const shell = resolveWindowsShell();
  const metadata = await getWindowsCommandMetadata(commandName, shell);

  if (!metadata) {
    Log.debug(
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
  if (extension === ".ps1") {
    return {
      kind: "powershell-file",
      command: shell,
      prefixArgs: ["-NoProfile", "-File", resolvedPath],
      resolvedPath,
    };
  }

  if (extension === ".cmd" || extension === ".bat") {
    return {
      kind: "powershell-command",
      command: shell,
      prefixArgs: [
        "-NoProfile",
        "-Command",
        WINDOWS_CMD_WRAPPER,
        resolvedPath,
      ],
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

async function getWindowsCommandMetadata(
  commandName: string,
  shell: string
): Promise<WindowsCommandMetadata | undefined> {
  try {
    const escapedName = escapePowerShellSingleQuoted(commandName);
    const script =
      `$cmd = Get-Command -Name '${escapedName}' ` +
      `-CommandType Application,ExternalScript -ErrorAction Stop | ` +
      "Select-Object -First 1 Name,CommandType,Source,Path,Definition; " +
      "$cmd | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync(shell, ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 5000,
    });
    const trimmed = stdout.trim();
    if (!trimmed) {
      return undefined;
    }
    const parsed = JSON.parse(trimmed) as
      | WindowsCommandMetadata
      | WindowsCommandMetadata[];
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (error) {
    Log.debug(
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
