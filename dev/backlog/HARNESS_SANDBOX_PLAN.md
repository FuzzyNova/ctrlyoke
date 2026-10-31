# Harness Sandbox Property

**Status:** Not started. Written 2026-10-30 against current code.
**Priority:** P2. It decides an open question in `dev/implemented/ANTIGRAVITY_PERMISSION_RULES_PLAN.md`
("Sandbox is a separate axis").

## Principle: contain the agent, don't interrogate it

ctrlyoke's goal for unattended agents is **boundaries instead of approvals**. Let the agent
run whatever it needs, and make what a command can _reach_ the safety mechanism, not a stream
of approval prompts nobody is there to answer. Full containment has four parts:

1. **Containment** of files and processes: an OS sandbox, a container, and worktrees for
   repository state.
2. **Scoped credentials:** a deploy key or fine-grained token for the one repo, not the
   user's main identity.
3. **Network policy:** what the agent may reach.
4. **A short deny list** kept only for **irreversible actions outside the boundary**, such
   as `git push`, package publishes and cloud deletes. Containment can't undo those, so they
   still deserve a stop.

Approval prompts are the fallback for when no boundary exists. This plan covers part 1 on
the user's own machine. `DOCKER_SERVER_IMAGE_PLAN.md` covers the server version of the same
principle.

## Problem

ctrlyoke has one control, `toolPermissions.mode`, and it mixes two different things:

- **Approval:** which actions run without asking. `mode`, `allowedTools` and `deniedTools`
  describe this on every harness.
- **Containment:** what a command can touch when it runs (files, network, credentials).

Containment is derived from the approval mode, differently per harness, and the workflow
never shows it:

| Harness                         | How containment is chosen today                                                                                                                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex                           | `CodexToolPermissionMapper`: `allowAll` → `--sandbox workspace-write`; `dangerouslyAllowAll` → `--dangerously-bypass-approvals-and-sandbox` (both controls off in one flag); `custom` → `permissions.codexSandboxMode`, clamped to `read-only` when a write-capable tool is denied. |
| Antigravity                     | `custom` → `--sandbox`; nothing otherwise.                                                                                                                                                                                                                                          |
| Copilot, Claude, Qwen, OpenCode | Never sandboxed.                                                                                                                                                                                                                                                                    |

So the same workflow runs sandboxed on one harness and unsandboxed on the next, and `custom`
means "OS sandbox" only on Antigravity. Users find this surprising.

## Native sandbox support (checked 2026-10-30 from each CLI's `--help`)

| Harness     | Control                                                                                                          | Model                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `-s read-only \| workspace-write \| danger-full-access`; approvals separately via `-a` (interactive only)        | OS sandbox. `workspace-write` writes only the workspace; network off by default.                                                                                                                                                                                                                                                                                                                                                 |
| Antigravity | `--sandbox`, `enableTerminalSandbox`, `toolPermission: proceed-in-sandbox`, `--mode auto`                        | OS sandbox for terminal commands. Permission rules configure its mounts and network allowlist. The docs say a `command` allow rule runs _outside_ it, but on Windows (agy 1.4.12) an allowed command ran inside it and got `EPERM` writing the workspace ([permission rules plan](../implemented/ANTIGRAVITY_PERMISSION_RULES_PLAN.md)). Silently does nothing where unsupported (below Windows 11 24H2, some Linux containers). |
| Copilot     | `--sandbox` (one session), `/sandbox enable` (persisted), org-managed policy                                     | OS sandbox via Microsoft Execution Containers (Seatbelt on macOS, bubblewrap plus a private network namespace on Linux, ProcessContainer on Windows). Policy covers readable/writable paths and network. git/`gh` authenticate through a masking proxy. Built-in file edits follow the policy best-effort only. Other env credentials stay visible unless masked.                                                                |
| Qwen        | `-s true \| false \| docker \| podman \| sandbox-exec`; `qwen sandbox` to inspect                                | Runs the agent's tools in a container or `sandbox-exec`. A different model: it needs Docker or Podman, and an image.                                                                                                                                                                                                                                                                                                             |
| Claude      | No sandbox flag in `--help`. `--settings` takes a JSON object, so a settings-level sandbox would be deliverable. | Unverified. Phase 0.                                                                                                                                                                                                                                                                                                                                                                                                             |
| OpenCode    | None found.                                                                                                      | Unsupported.                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Codex has no other control headless

`codex exec` takes no `-a`: its sandbox is the only enforcement in headless runs (see the
`includeApprovalFlag` comment in `CodexToolPermissionMapper.buildCodexSpecificArgs`). That is
why `allowAll` maps to `workspace-write` there: the sandbox stands in for the deny list Codex
can't enforce. On Codex, removing containment from `allowAll` removes its only protection,
not just a redundant one. Separating the two controls has to keep that.

## Proposal

### Schema: a `sandbox` property

```yaml
sandbox: true # terminal commands run in the harness's OS sandbox
toolPermissions:
  mode: allowAll
```

- Allowed at workflow and step level, like `toolPermissions`, and resolved through
  `PropertyResolver` with the same precedence. The user default goes in `defaults.sandbox`
  in `schemas/settings-schema.json` (`$ref` the same definition).
- Values: `true`, `false`, or absent. Absent means **inherit**: the setting's default, then
  each harness's current derived behavior (below). A tri-state keeps every existing workflow
  behaving exactly as today until someone sets it.
- Start boolean. The semantics of `true`: terminal commands may write only the workspace (and
  any approved external roots), temp dirs and build caches, and have no network unless the
  harness's own policy allows it. This is the common denominator of Codex `workspace-write`,
  agy `--sandbox` and Copilot `--sandbox`. A later object form
  (`sandbox: { network: [...], writable: [...] }`) can come once there's a cross-harness way
  to express it. Don't design it now.
- An additive optional property: no `schema:bump`. Run `npm run schema:update`. The
  `description` must state that it contains terminal commands only, and that harness file
  tools and MCP servers are not necessarily covered.

### Per-harness mapping

| Harness     | `sandbox: true`                                                                        | `sandbox: false`                                                      | absent (inherit)                 |
| ----------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------- |
| Codex       | `-s workspace-write`; `read-only` when a write-capable tool is denied (keep the clamp) | `-s danger-full-access`                                               | today's derivation from the mode |
| Antigravity | `--sandbox`                                                                            | no flag                                                               | today's: `--sandbox` in `custom` |
| Copilot     | `--sandbox`                                                                            | no flag (the user's `/sandbox` setting still applies; say so in docs) | no flag                          |
| Qwen        | `-s true` (Qwen's automatic backend)                                                   | `-s false`                                                            | no flag                          |
| Claude      | phase 0                                                                                | phase 0                                                               | no flag                          |
| OpenCode    | unsupported: compatibility diagnostic                                                  | nothing                                                               | nothing                          |

Decouple the Codex bypass: `dangerouslyAllowAll` with `sandbox: true` must become `-s
workspace-write` plus no-approval behavior, not `--dangerously-bypass-approvals-and-sandbox`.
Only `dangerouslyAllowAll` with `sandbox: false` (or inherit) keeps the bypass flag.
Interactive runs use `-a never -s <mode>`. Headless runs have no `-a`, so the sandbox flag
alone is right.

### Ownership in code

- A new `ISandboxMapper` beside `IToolPermissionMapper`, or a `sandboxArgs()` method on the
  mapper. Prefer a separate small interface so permissions and containment stay separate in
  code too. `ExecutionPlanBuilder` applies both, and Codex's mapper reads the resolved
  sandbox instead of deriving it from the mode.
- A capability domain `sandbox: { terminal: CapabilityDeclaration }` in
  `CapabilityDomainDescriptorMap` (`src/types/CompatibilityTypes.ts`). OpenCode declares it
  `unsupported`, so `CompatibilityAnalyzer` reports a workflow that asks for `sandbox: true`
  on OpenCode, and on Claude until phase 0 says otherwise.
- **"Silently no effect" hosts.** agy ignores `--sandbox` where the sandbox can't run, and
  Copilot's host check can fail (missing `bwrap`). When `sandbox: true` was requested
  explicitly, a run must not quietly go unsandboxed:
  - Detect it cheaply where possible (agy's stream-json init event reports the permission
    mode; check whether it also reports sandbox state).
  - Otherwise emit a runtime diagnostic from the harness's own warning output.
  - An open question is whether an explicit `sandbox: true` that can't be honored should fail
    the step rather than warn. Recommendation: fail. An explicit containment request that
    silently doesn't apply is the worst outcome.

### `codexSandboxMode` compatibility

`permissions.codexSandboxMode` is a released setting key, so it can't just disappear.

- Keep it as the Codex-specific value used when `sandbox: true` (it can pick `read-only`).
  When `sandbox` is absent, keep today's behavior, including reading it in `custom`.
- Update its settings description to say it applies when containment is on.
- Make no breaking change, so no bump is needed. If it is ever folded into an object-form
  `sandbox`, that is the bump, with a `FormatMigrations.ts` migration.

### UI

- Properties panel (`WorkflowPropertiesPanel.tsx`): a **Sandbox** row next to Tool
  Permissions, with Inherit / On / Off, and per-harness support shown the way permission
  fidelity is shown.
- Settings: `defaults.sandbox` in the Defaults page. Move `codexSandboxMode` under it as the
  Codex detail.
- Run header / Dry Run: show the effective containment per step ("Sandboxed (Codex
  workspace-write)" or "Not sandboxed"), since today it can't be seen anywhere.

## Phases

0. **Research** (help output and short probes):
   - Claude's sandbox settings key, if any, and whether `--settings` accepts it.
   - Copilot `--sandbox` in headless `-p` runs, and what a blocked command returns.
   - agy and Copilot behavior on an unsupported host, and how each reports it.
   - Qwen `-s true` with no Docker or Podman installed.
   - Whether each sandbox also contains the harness's MCP server processes. ctrlyoke's own
     MCP server writes the run state, so a sandbox that blocks it breaks the run.
1. **Schema and resolution:** property, settings default, `PropertyResolver`,
   `schema:update`, unit tests.
2. **Mappers:** sandbox mapping per harness, the Codex decoupling (bypass flag only when not
   sandboxed), the capability domain, compatibility diagnostics, and the fail-or-warn on
   unhonored requests. Unit tests per harness, including "absent keeps today's args"
   snapshots for every mode, so inherit really is unchanged.
3. **Antigravity:** remove `custom` → `--sandbox` from `AntigravityToolPermissionMapper`, and
   derive it from `sandbox` instead. `custom` with `sandbox` absent keeps `--sandbox` for
   compatibility, so the derived behavior still matches today. Document that inherit carries
   this legacy mapping, and that new workflows should state `sandbox`.
4. **Harness tests** (opt-in): for each supporting harness, `sandbox: true` blocks a write
   outside the workspace and a network fetch, `sandbox: false` allows them, and ctrlyoke's
   MCP server still works inside the sandbox.
5. **UI, docs, changelog:**
   - `docs/workflows/permissions.md` gets a "Sandboxing" section explaining the two axes.
   - Each `docs/harnesses/<harness>.md` gets its mapping.
   - Regenerate the compatibility docs.
   - `CHANGELOG.md`: **Added** for the property, and **Changed** for the Codex bypass split
     once a sandboxed `dangerouslyAllowAll` is possible.

## Open questions

- **Should inherit ever change?** Long term, "absent" could mean "not sandboxed" everywhere,
  so `custom` no longer implies a sandbox on agy and `allowAll` no longer implies one on
  Codex. That is a behavior change for released workflows: **Changed**, plus a release where
  the dashboard flags workflows relying on the derived sandbox. Decide after the property has
  shipped for a release.
- **Default for new users.** `defaults.sandbox: true` where the host supports it fits the
  principle above, but it breaks workflows that need the network (npm install, API calls)
  until a network allowlist exists. Recommendation: default to inherit now, and revisit when
  the object form exists.
- **Credentials and network** (parts 2 and 3 of the principle) are out of scope here.
  Copilot's credential-masking proxy is the most complete native model so far; watch for the
  others to converge before designing a cross-harness version.
