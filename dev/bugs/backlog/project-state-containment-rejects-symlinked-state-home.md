# User-scoped project state fails when the ctrlyoke state home path goes through a symlink or junction

- **Found:** 2026-10-02 by bug-hunt final step (claude-cli subagent), reproduced with `CTRLYOKE_HOME` pointing at a junction
- **Area:** `src/utils/ProjectStateRegistry.ts` (`assertContainedByRealRoot`, `withUserProjectRegistryLock`)
- **Severity:** high

## Symptom

With the default `storage.runHistoryLocation: "user"`, `ProjectStateRegistry.initialize`
throws `Project state path escapes the projects root: <...>\projects\<slug>-<hash>`
whenever any segment of the state home path is a symlink or junction. Some
examples:

- `CTRLYOKE_HOME` set to a symlinked or junctioned folder.
- A Windows profile folder redirected by a junction.
- `CTRLYOKE_HOME=/tmp/...` on macOS, where `/tmp` → `/private/tmp`.

`extension.ts` awaits this during activation, so the extension fails to
activate. The MCP server (`mcp-server.ts`) and the CLI bootstrap
(`CliWorkspaceBootstrap.bootstrapCliWorkspace`) fail the same way.
`withUserProjectRegistryLock` makes the same comparison against itself
(`assertContainedByRealRoot(projectsRoot, projectsRoot)`), so it fails too.

## Steps to Reproduce

1. Create a junction or symlink `linkhome` → `realhome` and set `CTRLYOKE_HOME=<path>/linkhome`.
2. Call `new ProjectStateRegistry("user").initialize(<workspace>)`, or activate the extension, run the CLI, or start the MCP server.
3. It throws "Project state path escapes the projects root". The same call made through `realhome` succeeds.

## Root Cause

`assertContainedByRealRoot` (`ProjectStateRegistry.ts` ~375-391) compares
`fs.realpath(projectsRoot)` against `path.resolve(candidate)`. That's a real path
on one side and a lexical path on the other. Once the root path contains a link,
`path.relative(realRoot, lexicalCandidate)` starts with `..`, so every candidate
"escapes", including `projectsRoot` itself.

## Suggested Fix

Compare like with like, and keep the containment guarantee:

- Resolve the candidate's real location before comparing. For a project dir
  that may not exist yet, use `realpath` of its parent (which `initialize`
  creates with `ensurePrivateDirectory`) and append the basename.
- Or compare the lexical candidate with the lexical root. A link *inside* the
  projects root (the real escape vector) is already rejected separately by
  `rejectSymlinkProjectDirectory`.

The check must still reject a project directory that is itself a link out of the
root. Add Mocha coverage with a junction (Windows) or symlink (POSIX) state home,
and a regression case that still rejects a symlinked project directory.
