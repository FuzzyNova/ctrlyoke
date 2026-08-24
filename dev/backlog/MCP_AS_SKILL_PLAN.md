# MCP-as-Skill: ctrlyoke Queue/Commit Tools Without MCP Configuration

> **Status:** Proposed — not implemented. Written 2026-08-24 against current code.

**Problem in one line:** many enterprise Copilot/Claude/Codex deployments block MCP
configuration entirely (company policy) but freely allow installable skills, so any
workflow that relies on `ctrlyoke_append_queue`/`ctrlyoke_submit_commit_message` (dynamic
queue extension, structured commit-message capture) silently loses that capability for
those users — with no equivalent path today.

---

## 1. Current state (verified against code)

### 1.1 The MCP tool surface already has a transport-agnostic core

`CtrlYokeMCPServer` (`src/mcp-server.ts`) cleanly separates tool *definitions* from tool
*dispatch* from *transport*:

- `getToolDefinitions()` (`mcp-server.ts:184-299`) is the single source of truth for all
  7 tools' names, descriptions, and JSON-Schema `inputSchema`s — already consumed by
  `ListToolsRequestSchema`'s handler (`mcp-server.ts:303-308`) and nothing else.
- `invokeTool(name, args)` (`mcp-server.ts:339-356`) is a **public, already-documented**
  dispatch method: *"Dispatch one tool without transport error wrapping; useful to
  embedders and focused tests."* `CallToolRequestSchema`'s handler is a thin wrapper
  around it (`mcp-server.ts:311-335`), and `src/test/unit/McpServer.test.ts` already
  calls it directly dozens of times, bypassing stdio/JSON-RPC entirely.
- Every tool answers for exactly one workflow run, resolved from
  `process.env.CTRLYOKE_WORKING_FILE` (`requireRunAddress()`, `mcp-server.ts:1005-1026`),
  not from any tool argument. This addressing model is unaffected by anything below.

So a non-MCP invocation path does not need to reimplement any business logic — it only
needs a different way to call `invokeTool` and a different way to print the result.

### 1.2 Skills are pointer-only; agents are always fully embedded — this is a real bug, not just an MCP-as-skill prerequisite

Two parallel systems exist for injecting file-backed content into a prompt, and they
work completely differently:

- **Agents** — `AgentExpander.expandAgent()` (`src/utils/AgentExpander.ts:44-66`) reads
  the agent file itself and returns its **full body** (minus frontmatter). This becomes
  `agentContent` (`HarnessIntegration.ts:548-550`), which `CliPromptPreparer` chunks and
  writes verbatim into a workspace-local temp file
  (`TEMP_FILE_CATEGORIES.AGENT`, `CliPromptPreparer.ts:667-681`), referenced from the
  prompt as `@agent.md`. One hop: the temp file the harness reads *is* the content.
- **Skills** — `SkillExpander.expandSkills()` (`src/utils/SkillExpander.ts:33-76`) does
  not read the skill body at all. It builds a "progressive disclosure" pointer block per
  skill (`buildSkillBlock`, lines 82-88) containing only `## Skill: name` / `Path:
  <absolute path>` / `Description: ...`, with a header instructing the harness to *"read
  its SKILL.md file directly using your built-in file read tool."* This block becomes
  `skillContent` (`HarnessIntegration.ts:544-546`), which is *also* chunked into a
  workspace-local temp file (`TEMP_FILE_CATEGORIES.SKILLS`,
  `CliPromptPreparer.ts:699-712`) and referenced as `@skills.md`
  (`CliIntegration.ts:492-497`, the categorized-instruction format). Two hops: the
  workspace-local file the harness reads only contains a *second* path to go read.

That second hop is fine when the skill lives inside the workspace (or another directory
the executing harness process can actually reach) — it's real, deliberate token savings
for large skills (reference docs, scripts) per the AgentSkills.io progressive-disclosure
pattern. It silently breaks when the skill's real path is **outside** whatever the
harness's execution environment can read — e.g. a user-level skill at
`~/.claude/skills/foo/SKILL.md` attached while running a `copilot-cli` step in a
container/sandbox that never mounted the user's home directory, or (after this plan) a
**built-in skill that has no on-disk path inside the workspace at all**. `SkillExpander`
does no containment check analogous to `ContextExpander`'s existing
`isPathWithinAnyDirectory` trust-root logic (`src/utils/ContextExpander.ts:158-164`,
used at `1062`) — it just prints whatever absolute path `SkillDiscovery` resolved.

**This is a real, standalone bug independent of MCP-as-skill**, and it is also a hard
prerequisite for this plan: a built-in "call the MCP tools via node" skill cannot exist
as a `Path:`-pointer to anything, because there is nothing on disk for the harness to
read a second time (see §1.3, §2.2).

### 1.3 Built-in, bundled content already has a working precedent — for agents

`AgentDiscovery` already solves "ship immutable content with the extension/CLI install
and make it selectable like a user/workspace one" for agents:

- `getBuiltInAgentsDirectoryCandidates(moduleDirectory)` (`AgentDiscovery.ts:74-81`)
  returns `templates/agents` relative to `__dirname`, checking both the esbuild-bundled
  layout (`out/templates/agents`, copied from `src/templates/agents` by the
  `copy-templates` esbuild plugin, `esbuild.js:120-146`) and the source/test layout.
- `discoverBuiltInAgents()` (`AgentDiscovery.ts:173-182`) scans that directory with
  `DISCOVERY_SOURCES.BUILT_IN` — a constant that **already exists**
  (`DashboardConstants.ts:2115`, doc'd *"Immutable agents included with the ctrlyoke
  installation"*) and is **already a permitted value for `SkillInfo["source"]`**
  (`SkillDiscovery.ts:33`: `Exclude<DiscoverySource, typeof
  DISCOVERY_SOURCES.WORKSPACE_CTRLYOKE>` — `BUILT_IN` is not excluded). Nothing to add
  to the type system; skills just never populate this source today.
- `discoverAgents()` appends built-ins **after** user/workspace agents and filters out
  any built-in name a real file already claims (`AgentDiscovery.ts:153-158`) — built-in
  is the lowest-precedence, user-overridable fallback.
- Bundled agent files are ordinary `.agent.md` with YAML frontmatter (`name`,
  `description`) — see `src/templates/agents/ctrlyoke-tech-support.agent.md:1-4` for the
  shape. `.github/instructions/templates.instructions.md` documents this as the pattern
  and explicitly calls out `AgentSkillsManagerSection` as the UI that can export built-in
  agents into `.ctrlyoke/agents/` or a harness-native dir for customization.

Because `AgentExpander` always reads full content regardless of source, built-in agents
never hit the "harness can't read this path" problem in the first place. Skills need
both: a `discoverBuiltInSkills()` mirror of this pattern, **and** the §1.2 fix (built-in
skills have no path to point at — they must always take the "embed full content" branch).

### 1.4 Commit-message generation already has an MCP-first / text-fallback split, but no "MCP unavailable" *detection*

`CommitMessageGenerator.generateMessage()` (`src/git/CommitMessageGenerator.ts:144-371`)
already:

- Prefers a structured tool call: attaches a per-call, queue-tools-denied MCP server
  config (`mcpServerConfig`, lines 227-246, `deniedTools` excludes everything except
  `ctrlyoke_submit_commit_message`) and instructs the harness in-prompt to call it
  (lines 212-217).
- Falls back to parsing the response text (lines 339-370) when the tool wasn't called.

But `useMcpCapture` (lines 200-206) is decided purely by *"does `out/mcp-server.js` exist
on disk"* — there is no concept of *"the file exists but the harness's environment is
policy-blocked from using any MCP config at all."* In that situation today, ctrlyoke
still attaches `mcpServerConfig` to the step, the harness silently ignores/rejects it
(varies by harness/policy), and generation degrades to the text-extraction fallback with
no warning that anything different happened. `.github/instructions/git.instructions.md`
already documents "structured MCP submission is primary, prose parsing is only a
fallback" as a locked-in contract — this plan needs to preserve that contract while
giving MCP-disabled environments a *second* structured path (the skill), not just a
worse silent one.

*(Note: `dev/backlog/COMMIT_MESSAGE_GENERATION_VISIBILITY_PLAN.md` addresses a different,
orthogonal gap — that these one-shot runs aren't persisted/viewable. That plan and this
one don't conflict; cross-reference only.)*

### 1.5 Env-var wiring: `CTRLYOKE_WORKING_FILE`/`CTRLYOKE_WORKSPACE` only reach the MCP subprocess today

`CliMcpConfigGenerator.generateJsonConfig()` (and its TOML sibling) sets
`CTRLYOKE_WORKSPACE`/`CTRLYOKE_WORKING_FILE` **only inside the generated MCP server
entry's own `env` block** (`CliProviderUtils.ts` — see `generateJsonConfig` in
`src/core/harness/shared/CliProviderUtils.ts:337-341` and the TOML equivalent). The
harness CLI process's *own* environment is built by
`CliProviderUtils.buildProcessEnv()` (`CliProviderUtils.ts:457-463`), which only spreads
`process.env` plus `CTRLYOKE_DIAGNOSTIC_LOGS` — it never sets `CTRLYOKE_WORKING_FILE`.

This matters because a skill can only tell the harness to run a shell command; it cannot
inject environment variables into that command's process beyond what the harness's own
shell tool inherits (and that inheritance chain is not guaranteed to carry ctrlyoke's
env vars — the harness process never had them). **The generated skill text must
therefore pass `--workspace`/`--working-file` (and, for commit capture,
`--commit-output`) as explicit CLI arguments**, not rely on environment inheritance. This
is free to get right: the skill's body is regenerated at prompt-attach time (§2.2), so
the literal values are always correct for that specific run/step.

---

## 2. Design

### Phase 0 (prerequisite) — fix skill embedding for unreadable paths

Give skill expansion the same "is this actually readable from where the harness is
running" awareness `ContextExpander` already has for `@file` references, and make it
embed full content instead of a pointer whenever the answer is no.

- Thread the same execution-checkout-root concept `ContextExpander` already carries
  (`ContextExpanderOptions.executionCheckoutRoot`, `ContextExpander.ts:89`) into
  `SkillExpander.expandSkills()`'s call site (`HarnessIntegration.ts:656-663`,
  `expandSkillBlock`).
- For each resolved `SkillInfo`, if its `path` is not inside the workspace/execution
  trust roots (reuse `isPathWithinAnyDirectory`, `PathSecurity.ts`, the same helper
  `ContextExpander` already imports), read the file and embed its **full body** instead
  of the `Path:`/`Description:` pointer — same shape as `AgentExpander.expandAgent()`,
  modulo the "strip frontmatter" question in §5 Q1. Otherwise, keep today's pointer
  block unchanged — this preserves the existing token-lean behavior for the common case
  (skill lives in the workspace being handed to the harness).
- This is the general fix (also fixes the real, pre-existing "sandboxed harness +
  user-home skill" bug from §1.2) and, as a side effect, is exactly the mechanism Phase 2
  needs: a built-in skill's path is *never* inside the execution checkout, so it always
  takes the "embed full body" branch — except its "body" isn't file content, it's
  generated text (see Phase 2).

### Phase 1 — CLI-invocable entrypoint on `mcp-server.ts`

Add a second, non-transport entry path to the same binary, reusing `invokeTool` as-is.

- At the bottom of `mcp-server.ts`'s `if (require.main === module)` block
  (`mcp-server.ts:1113-1123`), branch on argv: if `--tool <name>` is present, skip
  `start()` (the stdio/MCP transport) entirely.
- Parse `--tool`, `--args <json>`, `--workspace <path>`, `--working-file <path>`, and
  (for Phase 4) `--commit-output <path>` with a small hand-rolled parser — deliberately
  **not** `commander`, even though it's already a project dependency (used by
  `src/cli.ts:1`): `mcp-server.ts` is bundled as its own separate, minified esbuild
  target (`entryPoints: ["src/mcp-server.ts"]`, `outfile: "out/mcp-server.js"`,
  `esbuild.js:345-356`), and pulling a full CLI-parsing library into that bundle for four
  flags is unnecessary weight on a binary that gets spawned per tool call. See §5 Q3 for
  the alternative of a wholly separate binary.
- Before constructing `CtrlYokeMCPServer`, set `process.env.CTRLYOKE_WORKSPACE` /
  `CTRLYOKE_WORKING_FILE` from the parsed flags (both `requireRunAddress()` and the
  constructor read these from `process.env`, not from constructor options for the
  working-file address) — this is what makes the CLI form usable from *outside* an
  MCP-launched subprocess (§1.5).
- Call the same `initializeMcpStorage()` the `start()` path already calls
  (`mcp-server.ts:1115`), then `new CtrlYokeMCPServer({ workspaceRoot
  }).invokeTool(name, JSON.parse(argsJson))`; print the result's `content[0].text` to
  stdout; `process.exit(0)`. On a thrown error, print `error.message` to stderr and
  `process.exit(1)` — mirroring the existing transport handler's error shape
  (`mcp-server.ts:319-333`) closely enough that a harness parsing either output sees a
  consistent contract.
- Zero changes to the existing `start()` path, `invokeTool`, or any handler — purely
  additive.

### Phase 2 — built-in skill registry + autogenerated "MCP tools" skill content

Mirror the built-in-agents precedent (§1.3) for skills, but make the *body* generated
from live tool definitions instead of a static file, so it updates automatically when
`getToolDefinitions()` changes — the user's explicit design goal.

- Add `getBuiltInSkillsDirectoryCandidates(moduleDirectory)` /
  `SkillDiscovery.discoverBuiltInSkills()`, structurally identical to
  `AgentDiscovery`'s equivalents (§1.3), scanning `templates/skills/<skill-name>/` for a
  `SKILL.md`. Append the results in `discoverSkills()` (`SkillDiscovery.ts:67-154`) after
  user/workspace skills, with the same "a real skill of the same name wins" precedence
  agents already implement.
- Ship a bundled `src/templates/skills/ctrlyoke-mcp-tools/SKILL.md` with hand-written
  frontmatter (`name: ctrlyoke-mcp-tools`, a description covering when to use it — MCP
  disabled by policy) and prose explaining: what ctrlyoke is, the CLI invocation shape
  from Phase 1, and the §1.5 caveat (pass workspace/working-file as flags, don't rely on
  env). Do **not** hand-write the per-tool reference — see next bullet.
- Refactor `getToolDefinitions()`'s literal array (`mcp-server.ts:184-299`) into a
  standalone exported constant (e.g. `MCP_TOOL_DEFINITIONS`, in `mcp-server.ts` or a new
  small shared module) so it can be read without instantiating `CtrlYokeMCPServer`.
  `getToolDefinitions()` becomes a one-line wrapper returning it — no behavior change to
  the real `ListTools` handler.
- Add `McpToolSkillGenerator.generateToolReference(toolNames: string[]): string` (new
  file, e.g. `src/utils/McpToolSkillGenerator.ts`) that renders, per tool: name,
  description, a human-readable parameter list from `inputSchema.properties`/`required`,
  and one concrete example `node "<mcp-server.js path>" --tool <name> --args
  '<example-json>' --workspace "<path>" --working-file "<path>"` line.
- Wire generation into *expand time*, not build time (build-time codegen would go stale
  the moment someone edits `getToolDefinitions()` without also running a codegen step —
  defeating the "for free" goal): when Phase 0's "embed full body" branch fires for a
  **built-in** skill specifically, call `McpToolSkillGenerator.generateToolReference()`
  for that skill's associated tool subset instead of `fs.readFile`-ing anything, and
  splice the result into (or after) the bundled `SKILL.md`'s static prose. This is the
  one deliberate special case in the Phase 0 mechanism: a built-in skill's "full body"
  isn't file content, it's `<static prose> + <live-generated tool reference>`.
- Exclude `ctrlyoke_submit_commit_message` from this skill's tool subset — it gets its
  own skill in Phase 4, mirroring `CommitMessageGenerator.ts:238-244`'s existing
  `deniedTools` split (queue tools vs. commit tool are already treated as separate
  concerns in the MCP config today).

### Phase 3 — MCP-availability setting + auto-swap

Nothing in ctrlyoke can detect "an enterprise policy silently blocks MCP config" — this
has to be a user-set toggle (see §4 non-goals).

- New setting, e.g. `mcpAvailability: "auto" | "disabled"` (default `"auto"` = today's
  behavior byte-for-byte), added to `schemas/settings-schema.json` +
  `src/types/CtrlYokeSettings.ts`, read through `CtrlYokeConfigService`/
  `ConfigurationUtils` per this repo's settings single-source-of-truth rule — **not**
  mirrored into `package.json`'s `contributes.configuration`.
- When `"disabled"`: `CliProviderUtils.planMcpConfigBlock()`
  (`CliProviderUtils.ts:366-447`) must not resolve the **ctrlyoke** server into a real
  MCP config even when a step declares `mcpServers: ["ctrlyoke", ...]`
  (`hasCtrlYokeServer`, lines 401-403) — short-circuit that piece to empty while leaving
  user-defined `mcpServers` entries (`userServers`, lines 404-409) completely unaffected;
  those are a separate, unrelated concern this plan does not touch.
- Whatever resolves `resolvedProperties.skills` alongside `resolvedProperties.mcpServers`
  needs to auto-append `"ctrlyoke-mcp-tools"` when a step asked for the ctrlyoke MCP
  server but availability is `"disabled"` — **the exact resolver function was not traced
  in this research pass; flagged as an implementation-time investigation, see §5 Q2.**
- Emit a diagnostic when the swap happens (existing pattern:
  `PROMPT_DIAGNOSTIC_CODES.UNKNOWN_SKILL_REFERENCE`-style, see
  `CliPromptPreparer.ts:251-253`) so the swap is visible in the prompt-preview UI instead
  of silently changing what the harness receives.

### Phase 4 — commit-message parity in MCP-disabled mode

- Thread `mcpAvailability` into `CommitMessageGenerator.generateMessage()`
  (`CommitMessageGenerator.ts:200-206`): when `"disabled"`, skip
  `mcpServerConfig`/`mcpInstruction` entirely and instead pass a built-in
  `ctrlyoke-commit-message-tool` skill (generated the same way as Phase 2, scoped to just
  `ctrlyoke_submit_commit_message`) through `buildCommitWorkflowOverrides()`'s `skills`
  field (`CommitMessageGenerator.ts:43-59` — currently hardcoded `skills: null`; make it
  conditional on `mcpAvailability`).
- Capture path: `handleSubmitCommitMessage` (`mcp-server.ts:950-974`) already writes to
  `process.env.CTRLYOKE_COMMIT_OUTPUT` when set. Extend Phase 1's argv parser to also
  accept `--commit-output <path>` (in addition to the env var, for parity with the MCP
  transport path) so the generated skill instruction can pass it as a plain CLI argument
  — per §1.5, relying on env passthrough into a harness-spawned child process is not
  reliable across harnesses/OSes.
- Diff, fallback text-extraction, and `CommitMessageGenerationRecord` are all unaffected
  — this phase only changes *how* the structured capture happens when MCP is
  unavailable, not the surrounding contract documented in
  `.github/instructions/git.instructions.md`.

### Phase 5 (optional) — discoverability

`AgentSkillsManagerSection` already lets users export built-in agents into
`.ctrlyoke/agents/` or a harness-native directory for inspection/customization
(`templates.instructions.md:13,38`). Evaluate extending the same export affordance to
built-in skills so a curious user can see the generated tool-reference content outside
of an active run. Not required for the core capability to work.

---

## 3. Non-goals

- **Not** replacing the native MCP integration as the default path. `mcpAvailability:
  "auto"` (default) must produce byte-identical behavior to today.
- **Not** a generic "any MCP server as a skill" system. Scoped specifically to
  ctrlyoke's own `src/mcp-server.ts` surface — the only server ctrlyoke fully controls.
  User-defined `mcpServers` entries in a workflow are unaffected and out of scope.
- **Not** solving `COMMIT_MESSAGE_GENERATION_VISIBILITY_PLAN.md`'s run-persistence gap —
  orthogonal; cross-referenced only.
- **Not** attempting to auto-detect "MCP is actually blocked." Impossible from inside
  ctrlyoke — a blocked MCP config is typically silently ignored or rejected by the
  harness/host, not reported back. This has to stay a manual setting.

---

## 4. Cross-file contracts touched

- `SkillInfo`/`DiscoverySource` (`SkillDiscovery.ts`) — no type changes needed;
  `DISCOVERY_SOURCES.BUILT_IN` is already a permitted value.
- `getToolDefinitions()` (`mcp-server.ts`) — refactor to wrap a standalone exported
  constant; `ListToolsRequestSchema`'s handler and all existing MCP transport behavior
  must remain byte-identical.
- `schemas/settings-schema.json` + `CtrlYokeSettings.ts` — new `mcpAvailability` field,
  read only through `CtrlYokeConfigService`/`ConfigurationUtils` per this repo's
  single-settings-surface rule.
- `buildCommitWorkflowOverrides()` return shape (`CommitMessageGenerator.ts:43-59`) —
  `skills` becomes conditionally non-null; confirm nothing downstream assumes it's always
  `null` for commit-gen runs.

---

## 5. Open questions

1. **Frontmatter stripping for embedded skill bodies (Phase 0).** Skills' frontmatter
   today is just `name`/`description` (`SkillDiscovery.ts:296-301` only ever reads
   `description`) — unlike agents, there's no `model`/`tools` override field to warn
   about and strip (`AgentExpander.stripFrontmatter`, `AgentExpander.ts:77-104`).
   Probably safe to embed the body verbatim, frontmatter included — confirm at
   implementation time that no harness chokes on a leading `---` block in an XML-wrapped
   attachment.
2. **Phase 3's exact resolver insertion point.** This research pass confirmed *where*
   `resolvedProperties.mcpServers` is consumed (`CliProviderUtils.planMcpConfigBlock`)
   but did not trace the property-resolution layer that would need to also touch
   `resolvedProperties.skills` in the same pass. Needs a focused look at whatever
   resolves step properties (likely a `PropertyResolver`-named class) before
   implementation starts.
3. **Same-binary vs. sibling binary for the CLI entrypoint (Phase 1).** This plan adds
   `--tool`/`--args` argv handling directly to `mcp-server.ts`. The alternative — a new
   `src/mcp-cli.ts` bundled to its own `out/mcp-cli.js` — keeps the stdio-transport
   binary's argv space uncluttered and gives the skill a name that says "CLI tool," not
   "MCP server," which might read better in generated skill prose. Leaning toward
   same-file (single source of truth for `invokeTool`, one less esbuild target to
   maintain) but worth a second opinion before implementing.
4. **Skill granularity.** Recommend exactly two built-in skills (queue-management tools,
   commit-message tool — Phase 2/4 split) rather than one skill per individual tool or
   one giant skill. Mirrors the `deniedTools` split `CommitMessageGenerator.ts:238-244`
   already draws between queue tools and the commit tool. Revisit if a workflow author
   wants to attach only one specific queue tool's worth of instructions (unlikely; queue
   status/append/capabilities/read-output are normally used together).

---

## 6. Phasing

| Phase | Content                                                                 | Ships value alone? |
| ----- | ------------------------------------------------------------------------ | ------------------- |
| 0     | Fix skill expansion to embed full content for unreadable paths           | Yes — fixes a real, pre-existing sandboxed-harness bug independent of everything else here |
| 1     | `--tool`/`--args` CLI entrypoint on `mcp-server.ts`, reusing `invokeTool` | Partial — testable in isolation, not yet reachable from a real prompt |
| 2     | Built-in skill registry + autogenerated queue-tools skill content        | Yes — the core "MCP as skill" capability, usable once a user manually attaches the skill |
| 3     | `mcpAvailability` setting + auto-swap wiring                             | Yes — completes the "just works when MCP is policy-disabled" loop for queue tools |
| 4     | Commit-message skill parity                                              | Yes — completes the loop for the commit-message button specifically |
| 5     | Built-in skill export/discoverability in the Agent & Skills Manager      | Nice-to-have; independent of 0-4 |

Phase 0 should land first regardless of the rest of this plan's priority — it is a
correctness fix on its own. Phases 1-2 can land and be manually useful (a user attaches
`ctrlyoke-mcp-tools` by hand via the existing `skills: []` field) before Phase 3 makes the
swap automatic.
