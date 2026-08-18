import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { SecretStoreUnavailableError, type SecretStore } from "./SecretStore";

export { SecretStoreUnavailableError } from "./SecretStore";

const CREDENTIAL_SERVICE = "ctrlyoke";
const CREDENTIAL_INDEX_KEY = "ctrlyoke.secret.index";
const WINDOWS_TARGET_PREFIX = "ctrlyoke.";

const WINDOWS_CREDENTIAL_SCRIPT = `
Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class CtrlYokeCredentialManager {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public UInt32 Flags;
    public UInt32 Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public UInt32 CredentialBlobSize;
    public IntPtr CredentialBlob;
    public UInt32 Persist;
    public UInt32 AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredRead(string target, UInt32 type, UInt32 flags, out IntPtr credential);

  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWrite(ref CREDENTIAL credential, UInt32 flags);

  [DllImport("Advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDelete(string target, UInt32 type, UInt32 flags);

  [DllImport("Advapi32.dll", SetLastError = true)]
  public static extern void CredFree(IntPtr credential);
}
'@

$credential = [IntPtr]::Zero

if ($operation -eq 'get') {
  if (-not [CtrlYokeCredentialManager]::CredRead($target, 1, 0, [ref]$credential)) {
    exit 44
  }
  try {
    $native = [Runtime.InteropServices.Marshal]::PtrToStructure(
      $credential,
      [type][CtrlYokeCredentialManager+CREDENTIAL]
    )
    if ($native.CredentialBlobSize -eq 0) {
      [Console]::Out.Write('')
    } else {
      $bytes = New-Object byte[] $native.CredentialBlobSize
      [Runtime.InteropServices.Marshal]::Copy($native.CredentialBlob, $bytes, 0, $bytes.Length)
      [Console]::Out.Write([Text.Encoding]::Unicode.GetString($bytes))
    }
  } finally {
    [CtrlYokeCredentialManager]::CredFree($credential)
  }
  exit 0
}

if ($operation -eq 'store') {
  $value = [Console]::In.ReadToEnd()
  $bytes = [Text.Encoding]::Unicode.GetBytes($value)
  $blob = [Runtime.InteropServices.Marshal]::AllocCoTaskMem($bytes.Length)
  try {
    [Runtime.InteropServices.Marshal]::Copy($bytes, 0, $blob, $bytes.Length)
    $native = New-Object CtrlYokeCredentialManager+CREDENTIAL
    $native.Type = 1
    $native.TargetName = $target
    $native.CredentialBlobSize = [UInt32]$bytes.Length
    $native.CredentialBlob = $blob
    $native.Persist = 2
    $native.UserName = 'ctrlyoke'
    if (-not [CtrlYokeCredentialManager]::CredWrite([ref]$native, 0)) {
      throw 'CredWrite failed.'
    }
  } finally {
    [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blob)
  }
  exit 0
}

if ($operation -eq 'delete') {
  if (-not [CtrlYokeCredentialManager]::CredDelete($target, 1, 0)) {
    exit 44
  }
  exit 0
}

throw "Unsupported credential operation: $operation"
`;

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

type CommandRunner = (
  command: string,
  args: readonly string[],
  input?: string
) => Promise<CommandResult>;

interface CredentialBackend {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface OsCredentialStoreOptions {
  readonly platform?: NodeJS.Platform;
  readonly runCommand?: CommandRunner;
}

/**
 * CLI/server SecretStore backed by the native credential store for the host.
 * It deliberately has no file or plaintext fallback.
 */
export class OsCredentialStore implements SecretStore {
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: CommandRunner;
  private readonly backend: CredentialBackend;

  constructor(options: OsCredentialStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runCommand = options.runCommand ?? runCommand;
    this.backend = this.createBackend();
  }

  async get(key: string): Promise<string | undefined> {
    return this.withAvailability(() => this.backend.get(key));
  }

  async store(key: string, value: string): Promise<void> {
    await this.withAvailability(async () => {
      await this.backend.store(key, value);
      await this.addKeyToIndex(key);
    });
  }

  async delete(key: string): Promise<void> {
    await this.withAvailability(async () => {
      await this.backend.delete(key);
      await this.removeKeyFromIndex(key);
    });
  }

  async keys(): Promise<string[]> {
    return this.withAvailability(async () => {
      const index = await this.backend.get(CREDENTIAL_INDEX_KEY);
      if (!index) {
        return [];
      }
      try {
        const parsed: unknown = JSON.parse(index);
        return Array.isArray(parsed) &&
          parsed.every((key) => typeof key === "string")
          ? parsed
          : [];
      } catch {
        return [];
      }
    });
  }

  private createBackend(): CredentialBackend {
    switch (this.platform) {
      case "darwin":
        return new MacOsCredentialBackend(this.runCommand);
      case "linux":
        return new LinuxCredentialBackend(this.runCommand);
      case "win32":
        return new WindowsCredentialBackend(this.runCommand);
      default:
        return new UnavailableCredentialBackend(this.platform);
    }
  }

  private async addKeyToIndex(key: string): Promise<void> {
    if (key === CREDENTIAL_INDEX_KEY) {
      return;
    }
    const keys = new Set(await this.keys());
    keys.add(key);
    await this.backend.store(
      CREDENTIAL_INDEX_KEY,
      JSON.stringify([...keys].sort())
    );
  }

  private async removeKeyFromIndex(key: string): Promise<void> {
    if (key === CREDENTIAL_INDEX_KEY) {
      return;
    }
    const keys = new Set(await this.keys());
    keys.delete(key);
    await this.backend.store(
      CREDENTIAL_INDEX_KEY,
      JSON.stringify([...keys].sort())
    );
  }

  private async withAvailability<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SecretStoreUnavailableError) {
        throw error;
      }
      if (isMissingCommandError(error)) {
        throw new SecretStoreUnavailableError(this.platform, error);
      }
      throw error;
    }
  }
}

class UnavailableCredentialBackend implements CredentialBackend {
  constructor(private readonly platform: NodeJS.Platform) {}

  get(): Promise<string | undefined> {
    return Promise.reject(new SecretStoreUnavailableError(this.platform));
  }

  store(): Promise<void> {
    return Promise.reject(new SecretStoreUnavailableError(this.platform));
  }

  delete(): Promise<void> {
    return Promise.reject(new SecretStoreUnavailableError(this.platform));
  }
}

class MacOsCredentialBackend implements CredentialBackend {
  constructor(private readonly run: CommandRunner) {}

  async get(key: string): Promise<string | undefined> {
    const result = await this.run("security", [
      "find-generic-password",
      "-s",
      CREDENTIAL_SERVICE,
      "-a",
      key,
      "-w",
    ]);
    return result.exitCode === 0
      ? withoutCommandNewline(result.stdout)
      : undefined;
  }

  async store(key: string, value: string): Promise<void> {
    await requireSuccessfulCommand(
      this.run(
        "security",
        [
          "add-generic-password",
          "-U",
          "-s",
          CREDENTIAL_SERVICE,
          "-a",
          key,
          "-w",
        ],
        value
      ),
      "security"
    );
  }

  async delete(key: string): Promise<void> {
    const result = await this.run("security", [
      "delete-generic-password",
      "-s",
      CREDENTIAL_SERVICE,
      "-a",
      key,
    ]);
    if (result.exitCode !== 0 && !isMissingCredential(result)) {
      throw commandFailure("security", result);
    }
  }
}

class LinuxCredentialBackend implements CredentialBackend {
  constructor(private readonly run: CommandRunner) {}

  async get(key: string): Promise<string | undefined> {
    const result = await this.run("secret-tool", [
      "lookup",
      "service",
      CREDENTIAL_SERVICE,
      "account",
      key,
    ]);
    return result.exitCode === 0
      ? withoutCommandNewline(result.stdout)
      : undefined;
  }

  async store(key: string, value: string): Promise<void> {
    await requireSuccessfulCommand(
      this.run(
        "secret-tool",
        [
          "store",
          "--label=ctrlyoke",
          "service",
          CREDENTIAL_SERVICE,
          "account",
          key,
        ],
        value
      ),
      "secret-tool"
    );
  }

  async delete(key: string): Promise<void> {
    const result = await this.run("secret-tool", [
      "clear",
      "service",
      CREDENTIAL_SERVICE,
      "account",
      key,
    ]);
    if (result.exitCode !== 0 && !isMissingCredential(result)) {
      throw commandFailure("secret-tool", result);
    }
  }
}

class WindowsCredentialBackend implements CredentialBackend {
  constructor(private readonly run: CommandRunner) {}

  get(key: string): Promise<string | undefined> {
    return this.execute("get", key).then((result) =>
      result.exitCode === 0 ? result.stdout : undefined
    );
  }

  async store(key: string, value: string): Promise<void> {
    await requireSuccessfulCommand(
      this.execute("store", key, value),
      "CredMan"
    );
  }

  async delete(key: string): Promise<void> {
    const result = await this.execute("delete", key);
    if (result.exitCode !== 0 && !isMissingCredential(result)) {
      throw commandFailure("CredMan", result);
    }
  }

  private execute(
    operation: "get" | "store" | "delete",
    key: string,
    value?: string
  ): Promise<CommandResult> {
    const operationValue = Buffer.from(operation, "utf8").toString("base64");
    const targetValue = Buffer.from(
      `${WINDOWS_TARGET_PREFIX}${key}`,
      "utf8"
    ).toString("base64");
    const operationAndTarget = `$operation = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${operationValue}'))
$target = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${targetValue}'))
`;
    const script = Buffer.from(
      WINDOWS_CREDENTIAL_SCRIPT.replace(
        "$credential = [IntPtr]::Zero",
        `${operationAndTarget}$credential = [IntPtr]::Zero`
      ),
      "utf16le"
    ).toString("base64");
    return this.run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        script,
      ],
      value
    );
  }
}

async function runCommand(
  command: string,
  args: readonly string[],
  input?: string
): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child: ChildProcessWithoutNullStreams = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
    if (input === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(input);
    }
  });
}

async function requireSuccessfulCommand(
  resultPromise: Promise<CommandResult>,
  command: string
): Promise<void> {
  const result = await resultPromise;
  if (result.exitCode !== 0) {
    throw commandFailure(command, result);
  }
}

function commandFailure(command: string, result: CommandResult): Error {
  const detail = result.stderr.trim();
  return new Error(
    `${command} credential-store command failed${detail ? `: ${detail}` : "."}`
  );
}

function isMissingCredential(result: CommandResult): boolean {
  return (
    result.exitCode === 44 ||
    /not found|could not be found|no secret found|no such item/i.test(
      result.stderr
    )
  );
}

function isMissingCommandError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function withoutCommandNewline(value: string): string {
  return value.endsWith("\r\n")
    ? value.slice(0, -2)
    : value.endsWith("\n")
      ? value.slice(0, -1)
      : value;
}
