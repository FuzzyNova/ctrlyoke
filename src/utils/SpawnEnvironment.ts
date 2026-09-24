/**
 * Environment for a child process spawned with an explicit `cwd`, with `PWD`
 * pointed at that `cwd`.
 *
 * Node's `spawn({ cwd })` changes the child's real working directory but
 * passes the parent's `PWD` through untouched, and some harnesses trust `PWD`
 * over their actual directory. OpenCode is the confirmed case (1.18.32): run
 * from the ctrlyoke repo with `cwd` set to a workflow directory, it resolved
 * relative paths and its project against the repo — reading the wrong prompt
 * file and running tools in the wrong tree. Under the VS Code extension host
 * the inherited `PWD` is wherever VS Code was launched, so the mismatch is the
 * normal case there, not a test artifact.
 *
 * @param env  The environment the caller would otherwise pass (defaults to
 *   the current process environment).
 * @param cwd  The directory the child is spawned in, as passed to `spawn`.
 */
export function withWorkingDirectoryEnv(
  env: NodeJS.ProcessEnv | undefined,
  cwd: string
): NodeJS.ProcessEnv {
  return { ...(env ?? process.env), PWD: cwd };
}
