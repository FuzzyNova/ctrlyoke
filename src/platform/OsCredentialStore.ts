import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Socket } from "node:net";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { withFileLock } from "../utils/FileLockUtils";
import { SecretStoreUnavailableError, type SecretStore } from "./SecretStore";

export { SecretStoreUnavailableError } from "./SecretStore";

const CREDENTIAL_SERVICE = "ctrlyoke";
const CREDENTIAL_INDEX_KEY = "ctrlyoke.secret.index";
const WINDOWS_TARGET_PREFIX = "ctrlyoke.";

/**
 * `CredWrite` rejects any blob larger than `CRED_MAX_CREDENTIAL_BLOB_SIZE`
 * (5 * 512 = 2560 bytes) with a bare `ERROR_INVALID_PARAMETER`. The blob is
 * written as UTF-16, so the real ceiling is exactly 1280 UTF-16 code units per
 * credential — far below a multi-KB value such as a signed Keygen license file
 * or a PEM private key, so `ChunkedCredentialBackend` splits a value across
 * several credentials to honour the `SecretStore` contract.
 */
const WINDOWS_MAX_BLOB_BYTES = 2560;
const WINDOWS_CHUNK_LENGTH = WINDOWS_MAX_BLOB_BYTES / 2;
/**
 * `security` has no safe way to take a secret as an argument: `-w <value>`
 * and `-X <hex>` put it on argv, which `ps` shows to every user on macOS, and
 * a bare trailing `-w` reads it from the password prompt, which keeps only the
 * first 128 bytes, wants it typed twice, and stores an empty password (exit 0)
 * when stdin holds it once. So the command goes to `security -i` on stdin with
 * the value as `-X <hex>`. That interactive reader cuts a line at 4 KB, so a
 * keychain value is chunked too: 600 UTF-16 code units are at most 1800 UTF-8
 * bytes, 3600 hex digits, which leaves room for the command and the key.
 */
const MACOS_CHUNK_LENGTH = 600;
const MACOS_MAX_COMMAND_LINE_LENGTH = 4000;
/**
 * Continuation chunks live at `<target>#<index>` and the chunk count at
 * `<target>#count`. `#` cannot appear in a ctrlyoke secret key (see
 * `SecretKey.ts`), so a chunk target can never collide with a real key's own
 * target, and `count` is not a number so it cannot collide with a chunk index.
 */
const CHUNK_SEPARATOR = "#";
const CHUNK_COUNT_SUFFIX = `${CHUNK_SEPARATOR}count`;

/** Native command failures that mean the credential backend cannot be used. */
const BACKEND_UNAVAILABLE_PATTERNS: Partial<
  Record<NodeJS.Platform, readonly RegExp[]>
> = {
  linux: [
    /Cannot autolaunch a dbus-daemon without a \$DISPLAY/i,
    /Error spawning command line .*dbus-launch/i,
    /org\.freedesktop\.secrets/i,
    /Failed to connect to socket .*dbus/i,
  ],
  darwin: [
    /User interaction is not allowed/i,
    /Interaction is not allowed with the Security Server/i,
    /errSecInteractionNotAllowed/i,
    /(?:error\s*)?-25308\b/i,
  ],
  win32: [/Win32 error 1312\b/i],
};

const WINDOWS_CREDENTIAL_FUNCTIONS = `
$ProgressPreference = 'SilentlyContinue'

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

# Returns the exit code; output and errors go through [Console]::Out/Error, and
# a value to store arrives on [Console]::In, so the one-shot script and the
# persistent helper below share this body unchanged.
function Invoke-CtrlYokeCredentialOperation([string]$operation, [string]$target) {
  $credential = [IntPtr]::Zero

  if ($operation -eq 'batch') {
    $keysJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
    $keys = ConvertFrom-Json -InputObject $keysJson
    $results = @{}
    foreach ($keyName in $keys) {
      $targetName = "$target$keyName"
      $credential = [IntPtr]::Zero
      if ([CtrlYokeCredentialManager]::CredRead($targetName, 1, 0, [ref]$credential)) {
        try {
          $native = [Runtime.InteropServices.Marshal]::PtrToStructure($credential, [type][CtrlYokeCredentialManager+CREDENTIAL])
          $bytes = New-Object byte[] $native.CredentialBlobSize
          if ($bytes.Length -gt 0) { [Runtime.InteropServices.Marshal]::Copy($native.CredentialBlob, $bytes, 0, $bytes.Length) }
          $value = [Text.Encoding]::Unicode.GetString($bytes)
        } finally { [CtrlYokeCredentialManager]::CredFree($credential) }
        if ($value.Length -ge 1279) {
          $countCredential = [IntPtr]::Zero
          if ([CtrlYokeCredentialManager]::CredRead("$targetName#count", 1, 0, [ref]$countCredential)) {
            try {
              $countNative = [Runtime.InteropServices.Marshal]::PtrToStructure($countCredential, [type][CtrlYokeCredentialManager+CREDENTIAL])
              $countBytes = New-Object byte[] $countNative.CredentialBlobSize
              if ($countBytes.Length -gt 0) { [Runtime.InteropServices.Marshal]::Copy($countNative.CredentialBlob, $countBytes, 0, $countBytes.Length) }
              $countRaw = [Text.Encoding]::Unicode.GetString($countBytes)
              $countParts = $countRaw -split ':', 2
              $count = [int]$countParts[0]
              if ($count -gt 1) {
                $parts = @($value)
                for ($index = 1; $index -lt $count; $index++) {
                  $chunkCredential = [IntPtr]::Zero
                  if (-not [CtrlYokeCredentialManager]::CredRead("$targetName#$index", 1, 0, [ref]$chunkCredential)) { throw "CredRead failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())." }
                  try {
                    $chunkNative = [Runtime.InteropServices.Marshal]::PtrToStructure($chunkCredential, [type][CtrlYokeCredentialManager+CREDENTIAL])
                    $chunkBytes = New-Object byte[] $chunkNative.CredentialBlobSize
                    if ($chunkBytes.Length -gt 0) { [Runtime.InteropServices.Marshal]::Copy($chunkNative.CredentialBlob, $chunkBytes, 0, $chunkBytes.Length) }
                    $parts += [Text.Encoding]::Unicode.GetString($chunkBytes)
                  } finally { [CtrlYokeCredentialManager]::CredFree($chunkCredential) }
                }
                $value = $parts -join ''
                if ($countParts.Length -gt 1) {
                  $sha = [Security.Cryptography.SHA256]::Create()
                  try { $actualTag = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value))).Replace('-', '').ToLowerInvariant() }
                  finally { $sha.Dispose() }
                  if ($actualTag -ne $countParts[1]) { throw 'Credential chunk integrity check failed.' }
                }
              }
            } finally { [CtrlYokeCredentialManager]::CredFree($countCredential) }
          } else {
            $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            if ($lastError -ne 1168) { [Console]::Error.Write("CredRead failed with Win32 error $lastError."); return 45 }
          }
        }
        $results[$keyName] = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))
      } else {
        $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if ($lastError -ne 1168) { [Console]::Error.Write("CredRead failed with Win32 error $lastError."); return 45 }
        $results[$keyName] = $null
      }
    }
    $json = ConvertTo-Json -InputObject $results -Compress
    [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)))
    return 0
  }

  if ($operation -eq 'get') {
    if (-not [CtrlYokeCredentialManager]::CredRead($target, 1, 0, [ref]$credential)) {
      $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($lastError -eq 1168) { return 44 }
      [Console]::Error.Write("CredRead failed with Win32 error $lastError.")
      return 45
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
        $value = [Text.Encoding]::Unicode.GetString($bytes)
        $utf8 = [Text.Encoding]::UTF8.GetBytes($value)
        [Console]::Out.Write([Convert]::ToBase64String($utf8))
      }
    } finally {
      [CtrlYokeCredentialManager]::CredFree($credential)
    }
    return 0
  }

  if ($operation -eq 'store') {
    $valueBase64 = [Console]::In.ReadToEnd()
    $value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($valueBase64))
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
        $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        [Console]::Error.Write(
          "CredWrite failed with Win32 error $lastError for a $($bytes.Length)-byte blob."
        )
        return 45
      }
    } finally {
      [Runtime.InteropServices.Marshal]::FreeCoTaskMem($blob)
    }
    return 0
  }

  if ($operation -eq 'delete') {
    if (-not [CtrlYokeCredentialManager]::CredDelete($target, 1, 0)) {
      $lastError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      if ($lastError -eq 1168) { return 44 }
      [Console]::Error.Write("CredDelete failed with Win32 error $lastError.")
      return 45
    }
    return 0
  }

  throw "Unsupported credential operation: $operation"
}
`;

/** One operation per process, used when a test injects `runCommand`. */
const WINDOWS_ONE_SHOT_SCRIPT = `${WINDOWS_CREDENTIAL_FUNCTIONS}
$exitCode = @(Invoke-CtrlYokeCredentialOperation $operation $target)
exit $exitCode[-1]
`;

/**
 * A long-lived host that runs one operation per stdin line. Requests and
 * responses are base64 UTF-8 JSON, so the console's code page never touches
 * a value. Each operation's console streams are swapped for in-memory ones so
 * its output cannot interleave with the protocol.
 */
const WINDOWS_HELPER_SCRIPT = `${WINDOWS_CREDENTIAL_FUNCTIONS}
$hostIn = [Console]::In
$hostOut = [Console]::Out
$hostErr = [Console]::Error
while ($null -ne ($line = $hostIn.ReadLine())) {
  $request = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)))
  $requestOut = New-Object IO.StringWriter
  $requestErr = New-Object IO.StringWriter
  [Console]::SetOut($requestOut)
  [Console]::SetError($requestErr)
  [Console]::SetIn((New-Object IO.StringReader([string]$request.input)))
  try {
    $exitCode = [int](@(Invoke-CtrlYokeCredentialOperation $request.operation $request.target)[-1])
  } catch {
    $requestErr.Write($_.Exception.Message)
    $exitCode = 1
  } finally {
    [Console]::SetOut($hostOut)
    [Console]::SetError($hostErr)
    [Console]::SetIn($hostIn)
  }
  $response = ConvertTo-Json -Compress -InputObject @{ id = $request.id; exitCode = $exitCode; stdout = $requestOut.ToString(); stderr = $requestErr.ToString() }
  $hostOut.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($response)))
  $hostOut.Flush()
}
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
  getMany?(keys: readonly string[]): Promise<Map<string, string | undefined>>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

type WindowsCredentialOperation = "get" | "store" | "delete" | "batch";

/** Runs one CredMan operation; `input` is the base64 value it reads. */
type WindowsCredentialTransport = (
  operation: WindowsCredentialOperation,
  target: string,
  input?: string
) => Promise<CommandResult>;

export interface OsCredentialStoreOptions {
  readonly platform?: NodeJS.Platform;
  /**
   * Replaces every native command. On Windows this also replaces the
   * persistent PowerShell helper with one process per operation, so a fake
   * can see each operation's script.
   */
  readonly runCommand?: CommandRunner;
  /** Waits between retries of a torn key-index read; tests shorten them. */
  readonly indexReadRetryDelaysMs?: readonly number[];
  /** Path guarded by the cross-process index lock; tests use a temp dir. */
  readonly indexLockTarget?: string;
}

/**
 * Every process on this machine (each VS Code window, the CLI, `ctrlyoke
 * server`) rewrites the same key index read-modify-write, so mutations take
 * a file lock beside it. The credential store is per OS user, not per
 * `CTRLYOKE_HOME`, so the lock deliberately ignores that override: an
 * isolated dev host still shares the real index and must share its lock.
 */
function defaultIndexLockTarget(): string {
  return path.join(os.homedir(), ".ctrlyoke", "secret-index");
}

/**
 * Waits before re-reading a key index another process may be mid-way through
 * rewriting. Each Windows chunk write is its own `powershell.exe` spawn, so
 * a multi-chunk rewrite can take the better part of a second.
 */
const INDEX_READ_RETRY_DELAYS_MS: readonly number[] = [250, 500, 1000];

/**
 * A chunked value whose chunks disagree with their recorded count or
 * integrity tag. A concurrent rewrite produces this transiently; a write that
 * died partway leaves it permanently.
 */
class TornCredentialReadError extends Error {}

/**
 * CLI/server SecretStore backed by the native credential store for the host.
 * It has no fallback of its own; `createNodeSecretStore` composes it with
 * `FileSecretStore` for hosts where it is unavailable.
 */
export class OsCredentialStore implements SecretStore {
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: CommandRunner;
  private readonly injectedRunCommand: boolean;
  private readonly backend: CredentialBackend;
  private readonly indexReadRetryDelaysMs: readonly number[];
  private readonly indexLockTarget: string;
  private indexOperationChain: Promise<void> = Promise.resolve();

  constructor(options: OsCredentialStoreOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.runCommand = options.runCommand ?? runCommand;
    this.injectedRunCommand = options.runCommand !== undefined;
    this.indexReadRetryDelaysMs =
      options.indexReadRetryDelaysMs ?? INDEX_READ_RETRY_DELAYS_MS;
    this.indexLockTarget = options.indexLockTarget ?? defaultIndexLockTarget();
    this.backend = this.createBackend();
  }

  async get(key: string): Promise<string | undefined> {
    return this.withAvailability(() => this.backend.get(key));
  }

  async getMany(
    keys: readonly string[]
  ): Promise<Map<string, string | undefined>> {
    return this.withAvailability(async () => {
      if (this.backend.getMany) return this.backend.getMany(keys);
      const values = await Promise.all(
        keys.map((key) => this.backend.get(key))
      );
      return new Map(keys.map((key, index) => [key, values[index]]));
    });
  }

  async store(key: string, value: string): Promise<void> {
    await this.withAvailability(async () => {
      await this.backend.store(key, value);
      await this.enqueueIndexMutation(() => this.addKeyToIndex(key));
    });
  }

  async delete(key: string): Promise<void> {
    await this.withAvailability(async () => {
      await this.backend.delete(key);
      await this.enqueueIndexMutation(() => this.removeKeyFromIndex(key));
    });
  }

  async keys(): Promise<string[]> {
    // Reads share the mutation queue: once the index outgrows one CredMan
    // blob, a rewrite lands as several credentials, and a read interleaved
    // with it pairs the new integrity tag with old chunks. That is what a
    // brand-new workspace hit at startup, when storing its server token
    // raced the dashboard's first secret-registry request.
    return this.withAvailability(() =>
      this.enqueueIndexOperation(() => this.readIndex())
    );
  }

  private async readIndex(): Promise<string[]> {
    const index = await this.readIndexValue();
    if (!index) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(index);
      if (
        !Array.isArray(parsed) ||
        !parsed.every((key) => typeof key === "string")
      ) {
        throw new Error("Credential-store key index is invalid.");
      }
      return parsed;
    } catch (error) {
      throw new Error("Could not read credential-store key index.", {
        cause: error,
      });
    }
  }

  /**
   * The in-process queue cannot see another window, the CLI, or
   * `ctrlyoke server` rewriting the shared index, so a torn read is retried
   * after a short wait. A tear that outlasts every retry is real damage and
   * still surfaces.
   */
  private async readIndexValue(): Promise<string | undefined> {
    for (const delayMs of this.indexReadRetryDelaysMs) {
      try {
        return await this.backend.get(CREDENTIAL_INDEX_KEY);
      } catch (error) {
        if (!(error instanceof TornCredentialReadError)) {
          throw error;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return this.backend.get(CREDENTIAL_INDEX_KEY);
  }

  private createBackend(): CredentialBackend {
    switch (this.platform) {
      case "darwin":
        return new ChunkedCredentialBackend(
          new MacOsCredentialItems(this.runCommand)
        );
      case "linux":
        return new LinuxCredentialBackend(this.runCommand);
      case "win32":
        return new WindowsCredentialBackend(
          this.injectedRunCommand
            ? oneShotWindowsTransport(this.runCommand)
            : sharedWindowsCredentialHelper().execute
        );
      default:
        return new UnavailableCredentialBackend(this.platform);
    }
  }

  private async addKeyToIndex(key: string): Promise<void> {
    if (key === CREDENTIAL_INDEX_KEY) {
      return;
    }
    const keys = new Set(await this.readIndex());
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
    const keys = new Set(await this.readIndex());
    keys.delete(key);
    await this.backend.store(
      CREDENTIAL_INDEX_KEY,
      JSON.stringify([...keys].sort())
    );
  }

  /**
   * Serializes an index rewrite in this process and, through the file lock,
   * against every other process. Reads skip the file lock: a torn read from
   * another process's rewrite is retried in `readIndexValue` instead.
   */
  private enqueueIndexMutation(mutation: () => Promise<void>): Promise<void> {
    return this.enqueueIndexOperation(async () => {
      await fs.mkdir(path.dirname(this.indexLockTarget), { recursive: true });
      await withFileLock(this.indexLockTarget, mutation);
    });
  }

  private enqueueIndexOperation<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.indexOperationChain.then(operation);
    this.indexOperationChain = queued.then(
      () => {},
      () => {}
    );
    return queued;
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

/** macOS keychain items, written through `security -i` (see `MACOS_CHUNK_LENGTH`). */
class MacOsCredentialItems implements CredentialItems {
  readonly chunkLength = MACOS_CHUNK_LENGTH;
  readonly label = "Keychain";

  constructor(private readonly run: CommandRunner) {}

  async read(key: string): Promise<string | undefined> {
    const result = await this.run("security", [
      "find-generic-password",
      "-s",
      CREDENTIAL_SERVICE,
      "-a",
      key,
      "-g",
    ]);
    throwIfBackendUnavailable("darwin", result);
    return result.exitCode === 0
      ? parseKeychainPassword(result.stderr)
      : isMissingCredential(result)
        ? undefined
        : throwCommandFailure("security", result);
  }

  async write(key: string, value: string): Promise<void> {
    // `-X` rejects an empty hex string, and `-w ""` on stdin leaks nothing.
    const password =
      value === ""
        ? '-w ""'
        : `-X ${Buffer.from(value, "utf8").toString("hex")}`;
    const command = `add-generic-password -U -s ${CREDENTIAL_SERVICE} -a ${quoteSecurityArgument(key)} ${password}`;
    if (command.length > MACOS_MAX_COMMAND_LINE_LENGTH) {
      throw new Error(
        `Keychain item "${key}" does not fit in one security command line.`
      );
    }
    await requireSuccessfulCommand(
      this.run("security", ["-i"], `${command}\n`),
      "security",
      "darwin"
    );
  }

  async remove(key: string): Promise<void> {
    const result = await this.run("security", [
      "delete-generic-password",
      "-s",
      CREDENTIAL_SERVICE,
      "-a",
      key,
    ]);
    throwIfBackendUnavailable("darwin", result);
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
    throwIfBackendUnavailable("linux", result);
    return result.exitCode === 0
      ? withoutCommandNewline(result.stdout)
      : result.stderr.trim() === ""
        ? undefined
        : throwCommandFailure("secret-tool", result);
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
      "secret-tool",
      "linux"
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
    throwIfBackendUnavailable("linux", result);
    if (result.exitCode !== 0 && !isMissingCredential(result)) {
      throw commandFailure("secret-tool", result);
    }
  }
}

/** Single native credential items that hold at most `chunkLength` code units. */
interface CredentialItems {
  readonly chunkLength: number;
  /** Names the native store in error messages. */
  readonly label: string;
  read(key: string): Promise<string | undefined>;
  write(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/**
 * Backend for a native store with a per-item size limit. Values longer than
 * one item are split across `<key>`, `<key>#1`, `<key>#2`, … with the chunk
 * count in `<key>#count`; a value that fits stays a single plain item, so
 * items written before chunking existed still read back unchanged.
 */
class ChunkedCredentialBackend<
  TItems extends CredentialItems = CredentialItems,
> implements CredentialBackend {
  constructor(protected readonly items: TItems) {}

  async get(key: string): Promise<string | undefined> {
    const first = await this.items.read(key);
    // Only a value that filled its first chunk can have continuations, so the
    // common case costs no extra subprocess for the count lookup.
    if (first === undefined || !isFullChunk(first, this.items.chunkLength)) {
      return first;
    }

    const chunkMetadata = await this.readChunkMetadata(key);
    const { count } = chunkMetadata;
    if (count <= 1) {
      return first;
    }

    const continuations = await Promise.all(
      Array.from({ length: count - 1 }, (_unused, index) =>
        this.items.read(chunkKey(key, index + 1))
      )
    );
    const missingIndex = continuations.findIndex(
      (chunk) => chunk === undefined
    );
    if (missingIndex >= 0) {
      throw new TornCredentialReadError(
        `${this.items.label} credential "${key}" claims ${count} chunks but chunk ` +
          `${missingIndex + 1} is missing. Re-store the secret to repair it.`
      );
    }
    const value = [first, ...continuations].join("");
    if (
      chunkMetadata.integrityTag !== undefined &&
      createIntegrityTag(value) !== chunkMetadata.integrityTag
    ) {
      throw new TornCredentialReadError(
        `${this.items.label} credential "${key}" failed its integrity check. ` +
          "Re-store the secret to repair it."
      );
    }
    return value;
  }

  async store(key: string, value: string): Promise<void> {
    const chunks = splitIntoCredentialChunks(value, this.items.chunkLength);
    // Read the previous layout first so shrinking a value cannot leave
    // orphaned chunks behind in the user's credential vault.
    const previousCount = await this.readChunkCount(key);

    // Write the chunk count before the chunks it describes. A multi-credential
    // write cannot be atomic, so a failure partway through must leave a state
    // that `get` rejects loudly rather than one it reads as a complete but
    // truncated value — an unnoticed truncated license file or private key is
    // far worse than a failed store the caller can retry.
    if (chunks.length > 1) {
      await this.items.write(
        `${key}${CHUNK_COUNT_SUFFIX}`,
        `${chunks.length}:${createIntegrityTag(value)}`
      );
      for (const [index, chunk] of chunks.entries()) {
        await this.items.write(chunkKey(key, index), chunk);
      }
    } else {
      // Keep a chunked integrity record while replacing chunk 0. Updating its
      // tag first makes a failed write detectable; the old chunks cannot
      // accidentally pass as the requested replacement.
      if (previousCount > 1) {
        await this.items.write(
          `${key}${CHUNK_COUNT_SUFFIX}`,
          `${previousCount}:${createIntegrityTag(value)}`
        );
      }
      await this.items.write(chunkKey(key, 0), chunks[0]);
      if (previousCount > 1) {
        await this.items.remove(`${key}${CHUNK_COUNT_SUFFIX}`);
      }
    }

    for (let index = chunks.length; index < previousCount; index++) {
      await this.items.remove(chunkKey(key, index));
    }
  }

  async delete(key: string): Promise<void> {
    const count = await this.readChunkCount(key);
    for (let index = 0; index < count; index++) {
      await this.items.remove(chunkKey(key, index));
    }
    if (count > 1) {
      await this.items.remove(`${key}${CHUNK_COUNT_SUFFIX}`);
    }
  }

  /** The chunk count, or 1 for a plain single-credential value. */
  private async readChunkCount(key: string): Promise<number> {
    return (await this.readChunkMetadata(key)).count;
  }

  private async readChunkMetadata(
    key: string
  ): Promise<{ count: number; integrityTag?: string }> {
    const raw = await this.items.read(`${key}${CHUNK_COUNT_SUFFIX}`);
    if (raw === undefined) {
      return { count: 1 };
    }
    const [countText, integrityTag] = raw.trim().split(":", 2);
    const parsed = Number.parseInt(countText, 10);
    return Number.isInteger(parsed) && parsed > 1
      ? { count: parsed, ...(integrityTag ? { integrityTag } : {}) }
      : { count: 1 };
  }
}

/** Windows Credential Manager, which also batches reads in one PowerShell run. */
class WindowsCredentialBackend extends ChunkedCredentialBackend<WindowsCredentialItems> {
  constructor(transport: WindowsCredentialTransport) {
    super(new WindowsCredentialItems(transport));
  }

  async getMany(
    keys: readonly string[]
  ): Promise<Map<string, string | undefined>> {
    if (keys.length === 0) return new Map();
    const result = await this.items.execute("batch", "", JSON.stringify(keys));
    throwIfBackendUnavailable("win32", result);
    if (result.exitCode !== 0) return throwCommandFailure("CredMan", result);
    const raw = JSON.parse(
      Buffer.from(result.stdout, "base64").toString("utf8")
    ) as Record<string, string | null>;
    return new Map(
      keys.map((key) => {
        const encoded = raw[key];
        return [
          key,
          encoded == null
            ? undefined
            : Buffer.from(encoded, "base64").toString("utf8"),
        ];
      })
    );
  }
}

class WindowsCredentialItems implements CredentialItems {
  readonly chunkLength = WINDOWS_CHUNK_LENGTH;
  readonly label = "CredMan";

  constructor(private readonly transport: WindowsCredentialTransport) {}

  async read(key: string): Promise<string | undefined> {
    const result = await this.execute("get", key);
    throwIfBackendUnavailable("win32", result);
    if (result.exitCode === 0) {
      return Buffer.from(result.stdout, "base64").toString("utf8");
    }
    if (result.exitCode === 44) {
      return undefined;
    }
    return throwCommandFailure("CredMan", result);
  }

  async write(key: string, value: string): Promise<void> {
    await requireSuccessfulCommand(
      this.execute("store", key, value),
      "CredMan",
      "win32"
    );
  }

  async remove(key: string): Promise<void> {
    const result = await this.execute("delete", key);
    throwIfBackendUnavailable("win32", result);
    if (result.exitCode !== 0 && !isMissingCredential(result)) {
      throw commandFailure("CredMan", result);
    }
  }

  /** Values travel as base64 UTF-8, never through the console code page. */
  execute(
    operation: WindowsCredentialOperation,
    key: string,
    value?: string
  ): Promise<CommandResult> {
    return this.transport(
      operation,
      `${WINDOWS_TARGET_PREFIX}${key}`,
      value === undefined
        ? undefined
        : Buffer.from(value, "utf8").toString("base64")
    );
  }
}

const POWERSHELL_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
] as const;

function encodePowerShellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function powerShellUtf8Literal(text: string): string {
  const base64 = Buffer.from(text, "utf8").toString("base64");
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${base64}'))`;
}

/** A `powershell.exe` per operation, with the operation baked into its script. */
function oneShotWindowsTransport(
  run: CommandRunner
): WindowsCredentialTransport {
  return (operation, target, input) => {
    const script = `$operation = ${powerShellUtf8Literal(operation)}
$target = ${powerShellUtf8Literal(target)}
${WINDOWS_ONE_SHOT_SCRIPT}`;
    return run(
      "powershell.exe",
      [...POWERSHELL_ARGS, encodePowerShellCommand(script)],
      input
    );
  };
}

/**
 * How long the helper outlives its last operation. Startup reads arrive in
 * bursts several seconds apart, and each respawn costs a full process launch.
 */
const WINDOWS_HELPER_IDLE_MS = 60_000;

interface PendingCredentialRequest {
  /** The helper process the request was written to. */
  readonly child: ChildProcessWithoutNullStreams;
  resolve(result: CommandResult): void;
  reject(error: Error): void;
}

interface CredentialHelperResponse {
  readonly id?: unknown;
  readonly exitCode?: unknown;
  readonly stdout?: unknown;
  readonly stderr?: unknown;
}

/**
 * One `powershell.exe` that serves every CredMan operation in this process.
 * On Windows, `spawn` blocks the event loop for the whole `CreateProcess`
 * call (300 ms to over 2 s for PowerShell under antivirus scanning), and the
 * script's C# `Add-Type` compiles again in every new process. A process per
 * read made a few startup secret reads freeze the extension host for seconds.
 * While idle the helper is unreferenced, so it never keeps a CLI run alive,
 * and it exits on its own once its stdin closes.
 */
export class WindowsCredentialHelper {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, PendingCredentialRequest>();
  private nextId = 1;
  private idleTimer: NodeJS.Timeout | undefined;
  /** Helper processes started so far; tests assert reuse with it. */
  spawnCount = 0;

  constructor(private readonly idleMs = WINDOWS_HELPER_IDLE_MS) {}

  readonly execute: WindowsCredentialTransport = (operation, target, input) =>
    new Promise<CommandResult>((resolve, reject) => {
      const child = this.ensureChild();
      const id = this.nextId++;
      this.pending.set(id, { child, resolve, reject });
      this.setActive(true);
      const request = JSON.stringify({ id, operation, target, input });
      child.stdin.write(`${Buffer.from(request, "utf8").toString("base64")}\n`);
    });

  /**
   * Ends the helper once it has answered what it already received. It is
   * detached first, so an operation arriving meanwhile starts a new one
   * instead of writing to a process on its way out.
   */
  close(): void {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    clearTimeout(this.idleTimer);
    child.stdin.end();
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child) return this.child;
    const child = spawn(
      "powershell.exe",
      [...POWERSHELL_ARGS, encodePowerShellCommand(WINDOWS_HELPER_SCRIPT)],
      { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
    );
    this.spawnCount += 1;
    this.child = child;
    let stdoutBuffer = "";
    let stderrTail = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line) this.onResponse(line);
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    // A write to a helper that already died surfaces through "exit" instead.
    child.stdin.on("error", () => {});
    child.once("error", (error) => this.fail(child, error));
    child.once("exit", (code) => {
      const detail = stderrTail.trim();
      this.fail(
        child,
        new Error(
          `CredMan helper exited with code ${code ?? "unknown"}${detail ? `: ${detail}` : "."}`
        )
      );
    });
    return child;
  }

  private onResponse(line: string): void {
    let response: CredentialHelperResponse;
    try {
      response = JSON.parse(
        Buffer.from(line, "base64").toString("utf8")
      ) as CredentialHelperResponse;
    } catch {
      return; // Stray host output, not a protocol line.
    }
    if (typeof response.id !== "number") return;
    const request = this.pending.get(response.id);
    if (!request) return;
    this.pending.delete(response.id);
    request.resolve({
      exitCode: typeof response.exitCode === "number" ? response.exitCode : 1,
      stdout: typeof response.stdout === "string" ? response.stdout : "",
      stderr: typeof response.stderr === "string" ? response.stderr : "",
    });
    if (this.pending.size === 0) this.setActive(false);
  }

  /** Rejects whatever that process still owed; other processes are unaffected. */
  private fail(child: ChildProcessWithoutNullStreams, error: Error): void {
    if (this.child === child) {
      this.child = undefined;
      clearTimeout(this.idleTimer);
    }
    for (const [id, request] of this.pending) {
      if (request.child !== child) continue;
      this.pending.delete(id);
      request.reject(error);
    }
  }

  /** Keeps this process alive only while an operation is outstanding. */
  private setActive(active: boolean): void {
    const child = this.child;
    if (!child) return;
    clearTimeout(this.idleTimer);
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      if (!(stream instanceof Socket)) continue;
      if (active) stream.ref();
      else stream.unref();
    }
    if (active) {
      child.ref();
      return;
    }
    child.unref();
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
    this.idleTimer.unref();
  }
}

let windowsCredentialHelper: WindowsCredentialHelper | undefined;

/** Every store in this process shares one helper. */
function sharedWindowsCredentialHelper(): WindowsCredentialHelper {
  windowsCredentialHelper ??= new WindowsCredentialHelper();
  return windowsCredentialHelper;
}

function createIntegrityTag(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Chunk 0 keeps the plain key so unchunked values stay readable as-is. */
function chunkKey(key: string, index: number): string {
  return index === 0 ? key : `${key}${CHUNK_SEPARATOR}${index}`;
}

function splitIntoCredentialChunks(
  value: string,
  chunkLength: number
): string[] {
  if (value.length <= chunkLength) {
    return [value];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + chunkLength, value.length);
    // Never split a surrogate pair: both .NET's UTF-16 encoder and Node's
    // UTF-8 encoder replace a lone surrogate with U+FFFD, which would silently
    // corrupt the joined value.
    if (end < value.length && isHighSurrogate(value.charCodeAt(end - 1))) {
      end -= 1;
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Whether a stored chunk is at capacity and may therefore be continued. The
 * surrogate guard above can shorten a full chunk by one code unit, so both
 * lengths count as full.
 */
function isFullChunk(chunk: string, chunkLength: number): boolean {
  return chunk.length >= chunkLength - 1;
}

/**
 * `find-generic-password -w` prints a value holding any non-printable byte as
 * bare hex, indistinguishable from a printable value that happens to be hex.
 * `-g` tells them apart on stderr: `password: 0x<HEX>  "<escaped>"`,
 * `password: "<value>"`, or a bare `password: ` for an empty value.
 */
function parseKeychainPassword(output: string): string {
  const line = output
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith("password:"));
  if (line === undefined) {
    throw new Error("security did not report the keychain item's password.");
  }
  const hex = /^password: 0x([0-9A-F]*)/i.exec(line);
  if (hex) {
    return Buffer.from(hex[1], "hex").toString("utf8");
  }
  return /^password: "(.*)"$/.exec(line)?.[1] ?? "";
}

/** Quotes one argument for the `security -i` command-line reader. */
function quoteSecurityArgument(value: string): string {
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
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
  command: string,
  platform: NodeJS.Platform
): Promise<void> {
  const result = await resultPromise;
  if (result.exitCode !== 0) {
    throwIfBackendUnavailable(platform, result);
    throw commandFailure(command, result);
  }
}

function throwIfBackendUnavailable(
  platform: NodeJS.Platform,
  result: CommandResult
): void {
  const patterns = BACKEND_UNAVAILABLE_PATTERNS[platform];
  if (
    result.exitCode !== 0 &&
    patterns?.some((pattern) => pattern.test(result.stderr))
  ) {
    throw new SecretStoreUnavailableError(
      platform,
      commandFailure("credential-store", result)
    );
  }
}

function throwCommandFailure(command: string, result: CommandResult): never {
  throw commandFailure(command, result);
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
