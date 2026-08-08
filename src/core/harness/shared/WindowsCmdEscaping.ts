import * as path from "path";
import {
  escapeCmdArgument,
  escapeCmdMetaChars,
} from "../../../types/CommandDisplayFormatter";

/**
 * Escaping for arguments that must survive a mandatory `cmd.exe` hop on Windows.
 *
 * `CreateProcess` cannot launch a `.cmd`/`.bat` file directly — only `cmd.exe`
 * can interpret one. `CliLauncherResolver` prefers bypassing the shim entirely
 * (`resolveNodeCliShimTarget`, for npm's standard `.cmd` template) so no shell
 * is ever in the process tree; this module exists for the `cmd-file` fallback
 * used when a `.cmd`/`.bat` file does *not* match that template. Once cmd.exe
 * is in the process tree, it re-parses the *entire* command line using its own
 * metacharacter grammar (`< > & | ^ " ( ) %`, among others) before anything
 * reaches the target program's argv parser. Quoting an argument only for the
 * target program (the standard Win32/CRT convention `child_process` and
 * `node-pty` both apply per argv element) does not protect it from that
 * second, cmd.exe-specific pass — a literal `<` or `>` gets reinterpreted as
 * redirection and the spawn fails with a misleading "The system cannot find
 * the file specified."
 *
 * This is the two-layer algorithm from https://qntm.org/cmd, ported from
 * cross-spawn's `lib/util/escape.js` (MIT) — the standard, well-tested fix
 * for exactly this class of bug (see also Node's CVE-2024-27980 advisory).
 * The caller must pair the result with `windowsVerbatimArguments: true`
 * (`child_process`) or pass it as a joined string rather than an array
 * (`node-pty`) — both suppress a further layer of quoting that would
 * double-escape this already-escaped payload.
 *
 * KNOWN LIMITATION, verified empirically against real cmd.exe: this algorithm
 * is not sufficient when an argument combines a caret-escaped `<`/`>` with an
 * embedded, caret-escaped double quote in close proximity (e.g. a TOML value
 * like `"C:\<session-flags>\config.toml"`, which is exactly the shape of
 * Codex's inline-hooks trust key) — cmd.exe's undocumented quote-toggle
 * bookkeeping still misparses it even though every individual metacharacter
 * is correctly caret-escaped per the standard algorithm. That is precisely
 * why the node-shim bypass is the *primary* defense for npm-style shims, and
 * this module is a best-effort fallback, not a complete solution, for
 * `.cmd`/`.bat` files that don't match the bypassable template.
 */

/** cmd.exe-shim located under `node_modules/.bin/`: its own template re-invokes
 * cmd.exe a second time internally, so metacharacters must be escaped twice. */
const CMD_SHIM_IN_NODE_MODULES_BIN_REGEXP =
  /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/i;

export { escapeCmdArgument, escapeCmdMetaChars };

/**
 * Build the `/d /s /c "..."` payload for launching `resolvedFilePath` (a
 * `.cmd`/`.bat` file) with `args` safely through cmd.exe. The returned array
 * is `["/d", "/s", "/c", <escaped payload>]` — join with spaces, or pass as
 * `["/d","/s","/c", payload]` with `windowsVerbatimArguments: true`.
 */
export function buildCmdExeVerbatimArgs(
  resolvedFilePath: string,
  args: string[]
): string[] {
  const doubleEscapeMetaChars =
    CMD_SHIM_IN_NODE_MODULES_BIN_REGEXP.test(resolvedFilePath);
  const escapedCommand = escapeCmdMetaChars(path.normalize(resolvedFilePath));
  const escapedArgs = args.map((arg) =>
    escapeCmdArgument(arg, doubleEscapeMetaChars)
  );
  const shellCommand = [escapedCommand, ...escapedArgs].join(" ");
  return ["/d", "/s", "/c", `"${shellCommand}"`];
}
