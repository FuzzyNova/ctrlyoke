import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
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
 * or a PEM private key. macOS keychain items and `secret-tool` have no
 * comparable limit, so `WindowsCredentialBackend` is the only backend that
 * splits a value across several credentials to honour the `SecretStore`
 * contract.
 */
const WINDOWS_MAX_BLOB_BYTES = 2560;
const WINDOWS_CHUNK_LENGTH = WINDOWS_MAX_BLOB_BYTES / 2;
/**
 * Continuation chunks live at `<target>#<index>` and the chunk count at
 * `<target>#count`. `#` cannot appear in a ctrlyoke secret key (see
 * `SecretKey.ts`), so a chunk target can never collide with a real key's own
 * target, and `count` is not a number so it cannot collide with a chunk index.
 */
const WINDOWS_CHUNK_SEPARATOR = "#";
const WINDOWS_CHUNK_COUNT_SUFFIX = `${WINDOWS_CHUNK_SEPARATOR}count`;

const WINDOWS_CREDENTIAL_SCRIPT = `
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
      $value = [Text.Encoding]::Unicode.GetString($bytes)
      $utf8 = [Text.Encoding]::UTF8.GetBytes($value)
      [Console]::Out.Write([Convert]::ToBase64String($utf8))
    }
  } finally {
    [CtrlYokeCredentialManager]::CredFree($credential)
  }
  exit 0
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
      exit 45
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

/**
 * Windows Credential Manager backend. Values longer than one credential blob
 * are split across `<key>`, `<key>#1`, `<key>#2`, … with the chunk count in
 * `<key>#count`; a value that fits stays a single plain credential, so
 * credentials written before chunking existed still read back unchanged.
 */
class WindowsCredentialBackend implements CredentialBackend {
  constructor(private readonly run: CommandRunner) {}

  async get(key: string): Promise<string | undefined> {
    const first = await this.readCredential(key);
    // Only a value that filled its first chunk can have continuations, so the
    // common case costs no extra subprocess for the count lookup.
    if (first === undefined || !isFullChunk(first)) {
      return first;
    }

    const count = await this.readChunkCount(key);
    if (count <= 1) {
      return first;
    }

    const continuations = await Promise.all(
      Array.from({ length: count - 1 }, (_unused, index) =>
        this.readCredential(chunkKey(key, index + 1))
      )
    );
    const missingIndex = continuations.findIndex(
      (chunk) => chunk === undefined
    );
    if (missingIndex >= 0) {
      throw new Error(
        `CredMan credential "${key}" claims ${count} chunks but chunk ` +
          `${missingIndex + 1} is missing. Re-store the secret to repair it.`
      );
    }
    return [first, ...continuations].join("");
  }

  async store(key: string, value: string): Promise<void> {
    const chunks = splitIntoCredentialChunks(value);
    // Read the previous layout first so shrinking a value cannot leave
    // orphaned chunks behind in the user's credential vault.
    const previousCount = await this.readChunkCount(key);

    // Write the chunk count before the chunks it describes. A multi-credential
    // write cannot be atomic, so a failure partway through must leave a state
    // that `get` rejects loudly rather than one it reads as a complete but
    // truncated value — an unnoticed truncated license file or private key is
    // far worse than a failed store the caller can retry.
    if (chunks.length > 1) {
      await this.writeCredential(
        `${key}${WINDOWS_CHUNK_COUNT_SUFFIX}`,
        String(chunks.length)
      );
    } else if (previousCount > 1) {
      await this.deleteCredential(`${key}${WINDOWS_CHUNK_COUNT_SUFFIX}`);
    }

    for (const [index, chunk] of chunks.entries()) {
      await this.writeCredential(chunkKey(key, index), chunk);
    }

    for (let index = chunks.length; index < previousCount; index++) {
      await this.deleteCredential(chunkKey(key, index));
    }
  }

  async delete(key: string): Promise<void> {
    const count = await this.readChunkCount(key);
    for (let index = 0; index < count; index++) {
      await this.deleteCredential(chunkKey(key, index));
    }
    if (count > 1) {
      await this.deleteCredential(`${key}${WINDOWS_CHUNK_COUNT_SUFFIX}`);
    }
  }

  /** The chunk count, or 1 for a plain single-credential value. */
  private async readChunkCount(key: string): Promise<number> {
    const raw = await this.readCredential(
      `${key}${WINDOWS_CHUNK_COUNT_SUFFIX}`
    );
    if (raw === undefined) {
      return 1;
    }
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(parsed) && parsed > 1 ? parsed : 1;
  }

  private async readCredential(key: string): Promise<string | undefined> {
    const result = await this.execute("get", key);
    return result.exitCode === 0
      ? Buffer.from(result.stdout, "base64").toString("utf8")
      : undefined;
  }

  private async writeCredential(key: string, value: string): Promise<void> {
    await requireSuccessfulCommand(
      this.execute("store", key, value),
      "CredMan"
    );
  }

  private async deleteCredential(key: string): Promise<void> {
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
      value === undefined
        ? undefined
        : Buffer.from(value, "utf8").toString("base64")
    );
  }
}

/** Chunk 0 keeps the plain key so unchunked values stay readable as-is. */
function chunkKey(key: string, index: number): string {
  return index === 0 ? key : `${key}${WINDOWS_CHUNK_SEPARATOR}${index}`;
}

function splitIntoCredentialChunks(value: string): string[] {
  if (value.length <= WINDOWS_CHUNK_LENGTH) {
    return [value];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + WINDOWS_CHUNK_LENGTH, value.length);
    // Never split a surrogate pair: .NET's UTF-16 encoder replaces a lone
    // surrogate with U+FFFD, which would silently corrupt the joined value.
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
function isFullChunk(chunk: string): boolean {
  return chunk.length >= WINDOWS_CHUNK_LENGTH - 1;
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
