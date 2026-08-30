# MCP-as-Skill: ctrlyoke Queue/Commit Tools Without MCP Configuration

> **Status:** Phases 0-4 implemented; Phase 5 optional. Written 2026-08-24 against current code;
> refined 2026-08-30 against current code — corrected drifted line citations, fixed
> one wrong-file citation (§1.5), resolved Open Questions 1/3/4 by decision, and
> answered Open Question 2 with a traced insertion point (§5).

> **Phase 0 status (2026-08-30):** Implemented. `SkillExpander` now keeps its
> existing pointer block for skills inside the workspace or execution checkout and
> embeds out-of-trust-root skill files verbatim, including frontmatter. The harness
> call site passes the execution checkout root through the shared integration seam.
> No deviation from the Phase 0 design was required.

> **Phase 1 status (2026-08-30):** Implemented. `mcp-server.ts` now accepts the
> `--tool`, `--args`, `--workspace`, and `--working-file` flags and invokes the
> existing tool dispatcher without changing its stdio/MCP transport path.
>
> **Phase 2 status (2026-08-30):** Implemented. Built-in skills are discovered as
> immutable fallbacks, and `ctrlyoke-mcp-tools` embeds static usage prose plus a
> live-generated reference for the queue tools derived from the shared MCP tool
> definitions. The commit-message tool has its own built-in skill for Phase 4.

> **Phase 3 status (2026-08-30):** Implemented. `mcpAvailability` controls whether
> normal workflow execution attaches the native ctrlyoke MCP server or the built-in
> queue-tools skill.

> **Phase 4 status (2026-08-30):** Implemented. Commit-message generation now uses
> the native MCP capture path when available and the built-in
> `ctrlyoke-commit-message-tool` skill plus CLI capture path when MCP is disabled.

**Problem in one line:** many enterprise Copilot/Claude/Codex deployments block MCP
configuration entirely (company policy) but freely allow installable skills, so any
workflow that relies on `ctrlyoke_append_queue`/`ctrlyoke_submit_commit_message` (dynamic
queue extension, structured commit-message capture) silently loses that capability for
those users — with no equivalent path today.

---

## 1. Current state (verified against code)

### 1.1 The MCP tool surface already has a transport-agnostic core

`CtrlYokeMCPServer` (`src/mcp-server.ts`) cleanly separates tool _definitions_ from tool
_dispatch_ from _transport_:

- `getToolDefinitions()` (`mcp-server.ts:185-300`) is the single source of truth for all
  6 tools' names, descriptions, and JSON-Schema `inputSchema`s — already consumed by
  `ListToolsRequestSchema`'s handler (`mcp-server.ts:304-309`) and nothing else. (This
  was 7 tools as of the 2026-08-24 draft; the current set is `ctrlyoke_queue_status`,
  `ctrlyoke_append_queue`, `ctrlyoke_capabilities`, `ctrlyoke_read_output`,
  `ctrlyoke_global_status`, `ctrlyoke_submit_commit_message` — verify the count again at
  implementation time.)
- `invokeTool(name, args)` (`mcp-server.ts:340-357`) is a **public, already-documented**
  dispatch method: _"Dispatch one tool without transport error wrapping; useful to
  embedders and focused tests."_ `CallToolRequestSchema`'s handler is a thin wrapper
  around it (`mcp-server.ts:312-336`), and `src/test/unit/McpServer.test.ts` already
  calls it directly dozens of times, bypassing stdio/JSON-RPC entirely.
- Every tool answers for exactly one workflow run, resolved from
  `process.env.CTRLYOKE_WORKING_FILE` (`requireRunAddress()`, `mcp-server.ts:1013-1027`),
  not from any tool argument. This addressing model is unaffected by anything below.

So a non-MCP invocation path does not need to reimplement any business logic — it only
needs a different way to call `invokeTool` and a different way to print the result.

### 1.2 Skills are pointer-only; agents are always fully embedded — this is a real bug, not just an MCP-as-skill prerequisite

Two parallel systems exist for injecting file-backed content into a prompt, and they
work completely differently:

- **Agents** — `AgentExpander.expandAgent()` (`src/utils/AgentExpander.ts:44-66`) reads
  the agent file itself and returns its **full body** (minus frontmatter). This becomes
  `agentContent` (`src/core/HarnessIntegration.ts:549-551`), which `CliPromptPreparer`
  chunks and writes verbatim into a workspace-local temp file
  (`TEMP_FILE_CATEGORIES.AGENT`, `CliPromptPreparer.ts:673-681`), referenced from the
  prompt as `@agent.md`. One hop: the temp file the harness reads _is_ the content.
- **Skills** — `SkillExpander.expandSkills()` (`src/utils/SkillExpander.ts:33-76`) does
  not read the skill body at all. It builds a "progressive disclosure" pointer block per
  skill (`buildSkillBlock`, lines 82-88) containing only `## Skill: name` / `Path:
<absolute path>` / `Description: ...`, with a header instructing the harness to _"read
  its SKILL.md file directly using your built-in file read tool."_ This block becomes
  `skillContent` (`src/core/HarnessIntegration.ts:545-547`), which is _also_ chunked into
  a workspace-local temp file (`TEMP_FILE_CATEGORIES.SKILLS`,
  `CliPromptPreparer.ts:704-712`) and referenced as `@skills.md`
  (`CliIntegration.ts:492-497`, the categorized-instruction format). Two hops: the
  workspace-local file the harness reads only contains a _second_ path to go read.
  (Note: the file is `src/core/HarnessIntegration.ts`, not
  `src/core/harness/HarnessIntegration.ts` — the base class lives one level up from the
  per-harness provider directories.)

That second hop is fine when the skill lives inside the workspace (or another directory
the executing harness process can actually reach) — it's real, deliberate token savings
for large skills (reference docs, scripts) per the AgentSkills.io progressive-disclosure
pattern. It silently breaks when the skill's real path is **outside** whatever the
harness's execution environment can read — e.g. a user-level skill at
`~/.claude/skills/foo/SKILL.md` attached while running a `copilot-cli` step in a
container/sandbox that never mounted the user's home directory, or (after this plan) a
**built-in skill that has no on-disk path inside the workspace at all**. `SkillExpander`
does no containment check analogous to `ContextExpander`'s existing
`isPathWithinAnyDirectory` trust-root logic (`src/utils/ContextExpander.ts:1062`) — it
just prints whatever absolute path `SkillDiscovery` resolved.

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
  (`DashboardConstants.ts:2652`, doc'd _"Immutable agents included with the ctrlyoke
  installation"_) and is **already a permitted value for `SkillInfo["source"]`**
  (`SkillDiscovery.ts:33`: `Exclude<DiscoverySource, typeof
DISCOVERY_SOURCES.WORKSPACE_CTRLYOKE>` — `BUILT_IN` is not excluded). Nothing to add
  to the type system; skills just never populate this source today (confirmed:
  `SkillDiscovery.discoverSkills()`, `SkillDiscovery.ts:67-154`, has no built-in-scanning
  branch yet).
- `discoverAgents()` appends built-ins **after** user/workspace agents and filters out
  any built-in name a real file already claims (`AgentDiscovery.ts:154-158`) — built-in
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

### 1.4 Commit-message generation already has an MCP-first / text-fallback split, but no "MCP unavailable" _detection_

`CommitMessageGenerator.generateMessage()` (`src/git/CommitMessageGenerator.ts:231-571`)
already:

- Prefers a structured tool call: attaches a per-call, queue-tools-denied MCP server
  config (`mcpServerConfig`, lines 320-339, `deniedTools` excludes everything except
  `ctrlyoke_submit_commit_message` by denying the 5 queue tools explicitly) and
  instructs the harness in-prompt to call it (`mcpInstruction`, lines 308-310).
- Falls back to parsing the response text when the tool wasn't called (see
  `mcpToolCalled`/`useMcpCapture` handling around lines 465-501).

But `useMcpCapture` (lines 293-299) is decided purely by _"does `out/mcp-server.js` exist
on disk"_ (`fs.access(mcpServerPath)`) — there is no concept of _"the file exists but the
harness's environment is policy-blocked from using any MCP config at all."_ In that
situation today, ctrlyoke still attaches `mcpServerConfig` to the step, the harness
silently ignores/rejects it (varies by harness/policy), and generation degrades to the
text-extraction fallback with no warning that anything different happened.
`.github/instructions/git.instructions.md` already documents "structured MCP submission
is primary, prose parsing is only a fallback" as a locked-in contract — this plan needs
to preserve that contract while giving MCP-disabled environments a _second_ structured
path (the skill), not just a worse silent one.

_(Note: `dev/backlog/COMMIT_MESSAGE_GENERATION_VISIBILITY_PLAN.md` addresses a different,
orthogonal gap — that these one-shot runs aren't persisted/viewable. That plan and this
one don't conflict; cross-reference only.)_

### 1.5 Env-var wiring: `CTRLYOKE_WORKING_FILE`/`CTRLYOKE_WORKSPACE` only reach the MCP subprocess today

`CliMcpConfigGenerator.generateJsonConfig()` (and its TOML sibling) sets
`CTRLYOKE_WORKSPACE`/`CTRLYOKE_WORKING_FILE` **only inside the generated MCP server
entry's own `env` block** (`src/core/harness/shared/CliMcpConfigGenerator.ts:337-341` —
note this is `CliMcpConfigGenerator.ts`, a distinct file from `CliProviderUtils.ts`; the
2026-08-24 draft cited the wrong file here). The harness CLI process's _own_ environment
is built by `CliProviderUtils.buildProcessEnv()`
(`src/core/harness/shared/CliProviderUtils.ts:502-508`), which only spreads
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
  `SkillExpander.expandSkills()`'s call site (`src/core/HarnessIntegration.ts:656-663`,
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
  needs: a built-in skill's path is _never_ inside the execution checkout, so it always
  takes the "embed full body" branch — except its "body" isn't file content, it's
  generated text (see Phase 2).

### Phase 1 — CLI-invocable entrypoint on `mcp-server.ts`

Add a second, non-transport entry path to the same binary, reusing `invokeTool` as-is.

- At the bottom of `mcp-server.ts`'s `if (require.main === module)` block
  (`mcp-server.ts:1114-1124`), branch on argv: if `--tool <name>` is present, skip
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
  working-file address) — this is what makes the CLI form usable from _outside_ an
  MCP-launched subprocess (§1.5).
- Call the same `initializeMcpStorage()` the `start()` path already calls
  (`mcp-server.ts:1116`), then `new CtrlYokeMCPServer({ workspaceRoot
}).invokeTool(name, JSON.parse(argsJson))`; print the result's `content[0].text` to
  stdout; `process.exit(0)`. On a thrown error, print `error.message` to stderr and
  `process.exit(1)` — mirroring the existing transport handler's error shape
  (`mcp-server.ts:319-333`) closely enough that a harness parsing either output sees a
  consistent contract.
- Zero changes to the existing `start()` path, `invokeTool`, or any handler — purely
  additive.

### Phase 2 — built-in skill registry + autogenerated "MCP tools" skill content

Mirror the built-in-agents precedent (§1.3) for skills, but make the _body_ generated
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
- Refactor `getToolDefinitions()`'s literal array (`mcp-server.ts:185-300`) into a
  standalone exported constant (e.g. `MCP_TOOL_DEFINITIONS`, in `mcp-server.ts` or a new
  small shared module) so it can be read without instantiating `CtrlYokeMCPServer`.
  `getToolDefinitions()` becomes a one-line wrapper returning it — no behavior change to
  the real `ListTools` handler.
- Add `McpToolSkillGenerator.generateToolReference(toolNames: string[]): string` (new
  file, e.g. `src/utils/McpToolSkillGenerator.ts`) that renders, per tool: name,
  description, a human-readable parameter list from `inputSchema.properties`/`required`,
  and one concrete example `node "<mcp-server.js path>" --tool <name> --args
'<example-json>' --workspace "<path>" --working-file "<path>"` line.
- Wire generation into _expand time_, not build time (build-time codegen would go stale
  the moment someone edits `getToolDefinitions()` without also running a codegen step —
  defeating the "for free" goal): when Phase 0's "embed full body" branch fires for a
  **built-in** skill specifically, call `McpToolSkillGenerator.generateToolReference()`
  for that skill's associated tool subset instead of `fs.readFile`-ing anything, and
  splice the result into (or after) the bundled `SKILL.md`'s static prose. This is the
  one deliberate special case in the Phase 0 mechanism: a built-in skill's "full body"
  isn't file content, it's `<static prose> + <live-generated tool reference>`.
- Exclude `ctrlyoke_submit_commit_message` from this skill's tool subset — it gets its
  own skill in Phase 4, mirroring `CommitMessageGenerator.ts:331-337`'s existing
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
  (`src/core/harness/shared/CliProviderUtils.ts:411-492`) must not resolve the
  **ctrlyoke** server into a real MCP config even when a step declares
  `mcpServers: ["ctrlyoke", ...]` (`hasCtrlYokeServer`, lines 446-448) — short-circuit
  that piece to empty while leaving user-defined `mcpServers` entries (`userServers`,
  lines 449-454) completely unaffected; those are a separate, unrelated concern this plan
  does not touch.
- **Resolved (§5 Q2):** both `resolvedProperties.mcpServers` and `resolvedProperties.skills`
  come from the _same_ single resolver — `PropertyResolver.resolve()`
  (`src/utils/PropertyResolver.ts:90-96`), a thin VS Code/settings adapter that wraps the
  platform-neutral `resolveExecutionProperties()`
  (`src/types/ExecutionPropertyResolver.ts:232-320`). That function builds one
  `ResolvedProperties` object literal (`ExecutionPropertyResolver.ts:301-318`) setting
  `skills: skills.value` and `mcpServers: mcpServers.value` side by side — there is no
  second, separate skills-resolution path to also touch. The auto-swap belongs here, not
  in `CliProviderUtils` or `HarnessIntegration`: add `mcpAvailability` to
  `ExecutionPropertyDefaults` (populated in `PropertyResolver.createDefaults()`,
  `PropertyResolver.ts:35-67`, from `ConfigurationUtils` — mirroring how
  `defaults.skills`/`defaults.mcpServers` are already populated there at lines 52 and 55),
  then splice `"ctrlyoke-mcp-tools"` into the resolved `skills` array inside
  `resolveExecutionProperties()` itself, right after `mcpServers` and `skills` are both
  resolved (after `resolveSkills()`/the `mcpServers` `resolveNullable` call, before the
  `properties` object literal at line 301) — the one place both values are already in
  scope together. `WorkflowExecutor.ts` calls `PropertyResolver.resolve()` at two sites
  (`:562` for the pre-condition gate, `:713` for the real step run) — both automatically
  pick up the swap with zero caller changes. Confirmed by grep: no `mcpAvailability` (or
  equivalent) setting exists anywhere in the codebase yet — this is a new field, not a
  rename.
- Emit a diagnostic when the swap happens (existing pattern:
  `PROMPT_DIAGNOSTIC_CODES.UNKNOWN_SKILL_REFERENCE`-style, see
  `CliPromptPreparer.ts:251-253`) so the swap is visible in the prompt-preview UI instead
  of silently changing what the harness receives.

### Phase 4 — commit-message parity in MCP-disabled mode

- Thread `mcpAvailability` into `CommitMessageGenerator.generateMessage()` — specifically
  the `useMcpCapture` decision (`CommitMessageGenerator.ts:293-299`, currently just
  `fs.access(mcpServerPath)`): when `"disabled"`, skip
  `mcpServerConfig`/`mcpInstruction` (lines 308-339) entirely and instead pass a built-in
  `ctrlyoke-commit-message-tool` skill (generated the same way as Phase 2, scoped to just
  `ctrlyoke_submit_commit_message`) through `buildCommitWorkflowOverrides()`'s `skills`
  field (`CommitMessageGenerator.ts:113-141` — currently hardcoded `skills: null`; make it
  conditional on `mcpAvailability`).
- Capture path: `handleSubmitCommitMessage` (`mcp-server.ts:951-974`) already writes to
  `process.env.CTRLYOKE_COMMIT_OUTPUT` when set. Extend Phase 1's argv parser to also
  accept `--commit-output <path>` (in addition to the env var, for parity with the MCP
  transport path) so the generated skill instruction can pass it as a plain CLI argument
  — per §1.5, relying on env passthrough into a harness-spawned child process is not
  reliable across harnesses/OSes.
- Diff, fallback text-extraction, and `CommitMessageGenerationRecord` are all unaffected
  — this phase only changes _how_ the structured capture happens when MCP is
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
- `buildCommitWorkflowOverrides()` return shape (`CommitMessageGenerator.ts:113-141`) —
  `skills` becomes conditionally non-null; confirm nothing downstream assumes it's always
  `null` for commit-gen runs.

---

## 5. Open questions

All four questions from the 2026-08-24 draft are now resolved; kept here (not deleted)
as the decision record, since the reasoning matters for anyone revisiting this later.

1. **Frontmatter stripping for embedded skill bodies (Phase 0). Decided: embed
   verbatim, no stripping.** Skills' frontmatter today is just `name`/`description`
   (`SkillDiscovery.ts:296-301` only ever reads `description`) — unlike agents, there's
   no `model`/`tools` override field to warn about and strip
   (`AgentExpander.stripFrontmatter`, `AgentExpander.ts:77-104`). Embed the body verbatim,
   frontmatter included; still worth a smoke test at implementation time that no harness
   chokes on a leading `---` block inside an XML-wrapped attachment, but that's an
   implementation check, not an open design question.
2. **Phase 3's exact resolver insertion point. Resolved — one resolver, not two.**
   `PropertyResolver.resolve()` (`src/utils/PropertyResolver.ts:90-96`) is the single
   place both `resolvedProperties.mcpServers` and `resolvedProperties.skills` are
   produced, via the platform-neutral `resolveExecutionProperties()`
   (`src/types/ExecutionPropertyResolver.ts:232-320`), which builds one
   `ResolvedProperties` object literal (lines 301-318) setting both fields together.
   `CliProviderUtils.planMcpConfigBlock()` and `HarnessIntegration.buildPromptSections()`
   are two independent _consumers_ of that one object — not two independent resolvers.
   See the full insertion-point writeup already folded into Phase 3 above (§2, Phase 3,
   second bullet); no further tracing needed before implementation.
3. **Same-binary vs. sibling binary for the CLI entrypoint (Phase 1). Decided:
   same-file.** Add `--tool`/`--args` argv handling directly to `mcp-server.ts` rather
   than a new `src/mcp-cli.ts`/`out/mcp-cli.js` sibling binary — one source of truth for
   `invokeTool`, one less esbuild target to maintain. Phase 1's description above already
   reflects this.
4. **Skill granularity. Decided: two built-in skills.** Exactly two — a
   queue-management-tools skill (Phase 2) and a commit-message-tool skill (Phase 4) —
   rather than one skill per individual tool or one giant skill. Mirrors the
   `deniedTools` split `CommitMessageGenerator.ts:331-337` already draws between queue
   tools and the commit tool. The plan's Phase 2/Phase 4 split already implements this
   decision; revisit only if a workflow author later wants just one specific queue tool's
   worth of instructions (unlikely — queue status/append/capabilities/read-output are
   normally used together).

---

## 6. Phasing

| Phase | Content                                                                         | Ships value alone?                                                                         |
| ----- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 0     | Fix skill expansion to embed full content for unreadable paths (implemented)    | Yes — fixes a real, pre-existing sandboxed-harness bug independent of everything else here |
| 1     | `--tool`/`--args` CLI entrypoint on `mcp-server.ts`, reusing `invokeTool`       | Partial — testable in isolation, not yet reachable from a real prompt                      |
| 2     | Built-in skill registry + autogenerated queue-tools skill content (implemented) | Yes — the core "MCP as skill" capability, usable once a user manually attaches the skill   |
| 3     | `mcpAvailability` setting + auto-swap wiring (implemented)                      | Yes — completes the "just works when MCP is policy-disabled" loop for queue tools          |
| 4     | Commit-message skill parity (implemented)                                       | Yes — completes the loop for the commit-message button specifically                        |
| 5     | Built-in skill export/discoverability in the Agent & Skills Manager (optional)  | Nice-to-have; independent of 0-4                                                           |

Phase 0 should land first regardless of the rest of this plan's priority — it is a
correctness fix on its own. Phases 1-2 can land and be manually useful (a user attaches
`ctrlyoke-mcp-tools` by hand via the existing `skills: []` field) before Phase 3 makes the
swap automatic.
