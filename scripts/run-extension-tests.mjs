#!/usr/bin/env node
/**
 * `npm run test:extension`: compile the tests, then run the extension-host
 * suite with this script's arguments passed through untouched.
 *
 *   npm run test:extension -- [<file>...] [--grep <pattern>]
 *
 * This is a script rather than `npm run compile-tests && node ./out/test/runTest.js`
 * because npm on Windows caret-escapes arguments it appends to a script that
 * chains commands with `&&`: `--grep "rolls back"` reached the runner as
 * `^rolls^ back^`, matched nothing, and the run selected no tests. A script that
 * is a single command receives its arguments intact, and spawning the runner
 * without a shell keeps them that way. `src/test/suite/testSelection.ts` parses
 * them.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT_DIR,
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

// No arguments of ours ride on this call, so the shell npm needs on Windows
// (it is a .cmd shim) cannot reshape anything.
const compileStatus = run("npm", ["run", "compile-tests"], {
  shell: IS_WINDOWS,
});
if (compileStatus !== 0) {
  process.exitCode = compileStatus;
} else {
  process.exitCode = run(process.execPath, [
    resolve(ROOT_DIR, "out/test/runTest.js"),
    ...process.argv.slice(2),
  ]);
}
