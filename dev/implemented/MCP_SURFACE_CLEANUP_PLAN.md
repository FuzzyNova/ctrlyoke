# MCP Surface Cleanup Plan

> **Status:** Fully implemented across commits `2cd043d5`, `5fb83d44`,
> `feb73f8e` and `4b4c8673`. Every item was a fix to already-implemented code,
> not new capability. The rationale below is kept as the record of why each
> change was made.
>
> **Why now:** ctrlyoke is pre-release, so none of this carries a compatibility
> cost. One item — the `capabilities` → `list_harnesses` rename — is genuinely
> irreversible later, because tool names are the agent-facing contract that skill
> documents, prompt preambles, and user-written prompts all reference. The rest are
> internal and could be done any time, but are worth doing **before** the surface
> grows: [`EXECUTION_ROOT_COORDINATION_PLAN.md`](../backlog/EXECUTION_ROOT_COORDINATION_PLAN.md)
> adds four more tools, and each smell below gets proportionally more expensive
> with every tool added.
>
> **Relationship to the coordination plan:** prerequisite. That plan carries three
> further prerequisites of its own (the disabled-mode preflight hole, placeholder
> substitution in generated skills, and the `global_status` live-filter fix) which
> are documented there, in their design context, and are not duplicated here.

## 1. Rename `capabilities` to `list_harnesses`

**Status: done —** refactor(mcp): rename capabilities tool and complete MCP surface docs

The only change here that cannot be made later.

The tool returns available harnesses and the models each supports
(`handleCapabilities`, `src/mcp-server.ts:724-753`). The name `capabilities`
describes neither, and reads as though it reports the _server's_ capabilities —
a meaning MCP itself already assigns to the word during initialization. Every
other tool in the set is verb-or-noun-precise about what it returns
(`workflow_status`, `read_output`, `global_status`), so this is the one outlier.

Touch points, all verified:

| Site                                                 | Change                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| `src/utils/McpToolDefinitions.ts:33`                 | constant value `"capabilities"` → `"list_harnesses"`                 |
| `src/utils/McpToolDefinitions.ts:219`                | the definition entry's `name`                                        |
| `src/utils/McpToolDefinitions.ts:296`                | membership in `MCP_WORKFLOW_TOOL_NAMES`                              |
| `src/mcp-server.ts:59`, `:278`                       | import and dispatch case                                             |
| `src/mcp-server.ts:724`                              | `handleCapabilities` → `handleListHarnesses` (see item 8)            |
| `McpServersEditor.tsx:8,62`                          | the `CTRLYOKE_USER_TOOLS` entry: `id` and the `"Capabilities"` label |
| `src/templates/agents/spec-orchestrator.agent.md:43` | the prose telling agents to "call `capabilities` first"              |
| `docs/reference/mcp-tools.md`                        | the built-in tool table                                              |

The last two were missing from an earlier draft of this table and are the reason
the rename is irreversible: `CTRLYOKE_USER_TOOLS[].id` is the persisted key for a
user's per-tool disable switch, and the orchestrator agent template is
agent-facing prose that no compiler checks. `McpServersEditor.test.tsx` asserts
`CTRLYOKE_USER_TOOLS` stays exhaustive over `MCP_WORKFLOW_TOOL_NAMES`, so the
editor half fails loudly; the template half does not. Grep the repo for the bare
word rather than trusting the constant — `CommitMessageGenerator.ts:347` and
`McpRegistryFileManager.ts:259` consume the name through constants and need no
edit. Pre-release, a stale persisted `"capabilities"` id in someone's
`.ctrlyoke/settings.json` is acceptable fallout and needs no migration.

Rename the constant `MCP_CAPABILITIES_TOOL_NAME` → `MCP_LIST_HARNESSES_TOOL_NAME`
in the same change so the constant and its value do not disagree. Note that
`.ctrlyoke/capabilities.json` is a separate concept — the file the extension writes
and the MCP server reads — and keeps its name. Only the _tool_ is renamed.

## 2. Enforce `inputSchema` instead of hand-validating every tool

**Status: done —** refactor(mcp): validate tool arguments against their declared input schema

**The smell.** Every tool declares a JSON Schema `inputSchema` in
`MCP_TOOL_DEFINITIONS`, and that schema is used for exactly two things: advertising
the tool through `ListTools` (`mcp-server.ts:230-235`) and generating the built-in
skill's tool reference (`McpToolSkillGenerator.ts:80,88`). It is **never used to
validate an actual call.** Validation is separate, hand-written, per-handler code
built on `asRecord` (`:149`), `parseStepIndex` (`:156`), `parseNumberArray` (`:163`),
and `parseStringArray` (`:175`), plus ad-hoc inline checks.

**Why it matters.** The contract agents are shown and the contract handlers enforce
are two independent sources of truth for the same thing. They can drift silently in
either direction: a schema can advertise an optional argument a handler rejects, or
a handler can quietly accept a shape the schema never described — and the generated
skill documentation, which is derived from the schema, would document the wrong one.
This is the same single-source violation as the tool-name list conflation, one layer
down, and it gets worse with four more tools.

**The fix.** Validate `args` against the tool's `inputSchema` once, at the dispatch
boundary in `invokeTool`, before the switch. Handlers then receive already-validated,
typed arguments and most of the parse helpers disappear.

**Do not reach for ajv or another schema library.** `src/mcp-server.ts` is its own
minified esbuild target spawned per tool call in CLI mode, and
`MCP_AS_SKILL_PLAN.md` already set the precedent of rejecting a dependency
(`commander`) for exactly this reason. The schema subset actually in use is tiny —
`object`, `string`, `number`, `boolean`, `array`, `enum`, `oneOf`, `properties`,
`required` — and `McpToolSkillGenerator` **already walks precisely that shape** in
`exampleValue` and `renderParameters`. Write one small schema-walking module against
the existing `McpToolInputSchema` type and have both the validator and the generator
consume it, so the documented shape and the enforced shape cannot diverge by
construction.

Keep the error text at least as specific as today's hand-written messages; a
validator that reports "invalid arguments" where the old code said which field and
why would be a regression for the calling agent.

## 3. Remove `any` from the tool boundary

**Status: done —** refactor(mcp): type validated MCP tool arguments and transport errors

The deliberate variadic logger and the capabilities-file casts remain for item 4.

15 occurrences in `src/mcp-server.ts`. The ones that matter are at the untrusted
input boundary, where they defeat strict mode precisely where it is load-bearing:

- `handleQueueAppend(args: any)` (`:390`), `handleReadOutput(args: any)` (`:762`),
  `handleSubmitCommitMessage(args: any)` (`:1073`) — while `handleStepEdit` (`:562`),
  `handleStepRemove` (`:601`), and `handleStepsReorder` (`:628`) all take `unknown`.
  Same boundary, two conventions.
- `request: any` in the `CallTool` handler (`:240`), `error: any` (`:248`, `:1043`).
- `operationQueue: Promise<any>` (`:186`).
- `(h: any)`, `(m: any)`, `capabilities.harnesses as any[]` (`:456`, `:460`, `:461`,
  `:468`, `:734`, `:740`) — see item 4.

Item 2 resolves most of this by handing handlers typed arguments. The remainder is
mechanical. `log(...args: any[])` (`:108`) is a reasonable exception for a variadic
logger and can stay.

## 4. Give `capabilities.json` a shared type

**Status: done —** shared capabilities contract now types both the extension writer and MCP reader.

**The smell.** The file is written by `WebviewSettingsSync.writeCapabilities`
(`src/ui/WebviewSettingsSync.ts:339,355`) and read by
`readCapabilities(): Promise<any | null>` (`src/mcp-server.ts:706`), whose consumer
then casts twice — `capabilities.harnesses as any[]` and `h.models as any[]`
(`:734`, `:740`). A cross-process file contract with no type on either end, plus a
second reader doing harness/model validation during append (`:448-470`).

**Why it matters.** This is exactly the case the repo's "make structural
relationships nominal" principle exists for: writer and reader agree only by
convention, and nothing in the language service connects them. A field renamed on
the writing side fails at runtime in a different process.

**The fix.** Declare the shape once in `src/types/` and have both ends import it.
The writer already builds the object; the reader stops casting.

## 5. De-duplicate the path constants

**Status: done —** shared path names now live in `DashboardConstants` and feed the existing `PATH_CONSTANTS` surface.

`src/mcp-server.ts:72-75` reads:

```typescript
// Path constants (must match ConfigurationUtils.PATH_CONSTANTS)
const CTRLYOKE_DIR = ".ctrlyoke";
const LOGS_DIR = "logs";
const CAPABILITIES_FILE = "capabilities.json";
```

A comment admitting a manual-sync duplication is the definition of this smell, and
`PATH_CONSTANTS.CAPABILITIES_FILE` (`src/utils/ConfigurationUtils.ts:227`) even
documents itself as _"written by extension, read by MCP server"_ — it is already
intended as the shared constant.

The usual justification does not hold here: **neither `ConfigurationUtils.ts` nor
`CtrlYokeConfigService.ts` imports `vscode`**, and `mcp-server.ts` already imports
`DashboardConstants` (for `BOOLEAN_STRING_VALUES`). Move these names to a
platform-neutral module both sides already depend on — `DashboardConstants` is the
obvious home — and delete the local copies. Pulling `ConfigurationUtils` itself into
the MCP bundle is the option to avoid, since it drags in `configService` and
`ExternalRootsTrustStore` for three strings.

`PATH_CONSTANTS` must then consume the moved names from `DashboardConstants`
rather than keeping its own copies, or the duplication has simply moved rather
than gone. Verified: neither `ConfigurationUtils.ts` nor `DashboardConstants.ts`
imports `vscode`, so the move is safe in both directions.

## 6. Single-source the max-queue default

**Status: done —** the queue setting and MCP fallback now consume the shared dashboard default.

`getMaxQueueSize()` (`src/mcp-server.ts:134-144`) falls back to `100` with the
comment _"Default, matches package.json default"_. That comment cites a surface the
project explicitly declares non-authoritative — per `copilot-instructions.md`,
`package.json`'s `contributes.configuration` is not a settings surface and any
property there is a do-nothing duplicate. The real default is
`CtrlYokeSettings.ts:472` (`queue.maxSize: 100`).

Fix the comment, and single-source the constant — but **not by importing
`DEFAULT_SETTINGS` from `CtrlYokeSettings.ts`.** That module pulls in
`IconColorDefaults`, `CtrlYokeTypes`, `StatuslineFormat` and
`TerminalControlBarFormat`, which is the same bundle-weight objection item 5
raises against pulling in `ConfigurationUtils` — and `mcp-server.ts` is a
per-tool-call spawned bundle. Declare the number in `DashboardConstants` (which
`CtrlYokeSettings.ts` already imports, and which `mcp-server.ts` already depends
on) and have **both** `CtrlYokeSettings.ts:472` and `getMaxQueueSize()` read it
from there. The env var (`CTRLYOKE_MAX_QUEUE_SIZE`) remains the primary source;
this is only about where the fallback constant comes from.

## 7. Single-source the ctrlyoke MCP server env block

**Status: done —** refactor(harness): single-source the ctrlyoke MCP server env block

The same env block is constructed independently in three places:

| Site                                                  | Format                    |
| ----------------------------------------------------- | ------------------------- |
| `CliMcpConfigGenerator.generateJsonConfig` `:338`     | `--mcp-config` JSON       |
| `CliMcpConfigGenerator` TOML sibling `:515`           | Codex TOML                |
| `CliProviderUtils.buildSettingsJsonMcpEntries` `:623` | workspace `settings.json` |

Each one independently normalizes `(stateRoot ?? workspaceRoot)` to forward slashes,
sets `CTRLYOKE_WORKSPACE`, conditionally sets `CTRLYOKE_WORKING_FILE`, and merges
`additionalEnv` — then builds the same `{ command: "node", args: [serverPath], env }`
entry.

**Why it matters beyond tidiness:** the coordination plan's Decision 7 contemplates
adding `CTRLYOKE_EXECUTION_ROOT` to this block as the fallback for harnesses that
sanitise the process environment. Adding a field today means editing three sites, and
missing one breaks a single harness family silently — the failure mode is a harness
that still works but attributes board entries to the wrong scope. Extract one builder
returning the env record (and ideally the whole stdio entry), and have all three
formats serialise the same object.

## 8. Rename handlers to match their tools

**Status: done —** refactor(mcp): rename capabilities tool and complete MCP surface docs

`handleQueueStatus` (`:325`) serves `workflow_status`; `handleQueueAppend` (`:390`)
serves `append_step`. The tools were renamed from `queue_status`/`append_queue` in an
earlier pass and the handlers were not, so grepping a tool name does not find the
code that implements it. Mechanical, and worth doing in the same pass as item 1 so
the dispatch table reads uniformly.

## 9. Fill the two gaps in the public tool docs

**Status: done —** refactor(mcp): rename capabilities tool and complete MCP surface docs

`docs/reference/mcp-tools.md` lists 7 tools. `global_status` and
`submit_commit_message` are missing. `global_status` matters most: agents are told it
exists, the coordination plan is fixing its behaviour, and its correct use (a
cross-worktree radar, not a collision check) is exactly the kind of thing that needs
documenting rather than inferring.

## Suggested grouping

Four commits, ordered so the irreversible one lands first and nothing depends on
work not yet done:

1. **The rename** — item 1 plus item 8, including the docs table. One agent-facing
   change, easy to review and to revert as a unit.
2. **Schema enforcement** — item 2, which carries most of item 3 with it.
3. **Single-sourcing** — items 4, 5, 6. Small, independent, mechanical.
4. **Env-block extraction** — item 7. Touches harness plumbing rather than the
   server, so it is worth isolating; it is also the one the coordination work builds
   directly on.

Item 9 can ride along with whichever commit lands first.

## Deliberately not changing

Flagged here so a later reader does not re-litigate them:

- **`queueOperation`** (`mcp-server.ts:295-318`) — correctly serialises mutations,
  and its gate promise deliberately never rejects so one failure cannot block the
  queue or raise an unhandled rejection. The reasoning is already commented.
- **The `invokeTool` / transport split** — `invokeTool` throws and the transport
  handler wraps errors into `isError` content. That separation is what makes the
  CLI entry point and focused tests possible; keep it.
- **`requireRunAddress()`** — refusing a caller-supplied run address is correct for
  tools that act on a run. The coordination plan explains why scope-addressed tools
  are a different case; that is not a reason to weaken this one.
- **Switch-based dispatch in `invokeTool`** — a typed `switch` over name constants is
  what the coding principles ask for over string-keyed dynamic dispatch, not a smell.

## Verification

- The schema-driven validator (item 2) needs a test per tool asserting that a
  known-good argument object validates and that each required field's absence is
  reported by name — this is what replaces the deleted hand-written checks.
- Item 1 needs a test pinning the full tool-name set, so a future rename is a
  deliberate, visible change rather than a silent one.
- Item 7 needs one test asserting the three config formats emit the same env keys
  for the same input; that is the regression the extraction exists to prevent.
