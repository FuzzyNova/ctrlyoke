# Harness SDK, Server and ACP Modes

**Date:** 2026-11-15
**Status:** Research. Nothing implemented. The headless approvals and steering work that uses
these channels is planned in [`HEADLESS_SESSION_CONTROL_PLAN.md`](../implemented/HEADLESS_SESSION_CONTROL_PLAN.md).
**Sources:** that plan's live probes; the local vendor clones (`C:\dev\qwen-code`,
`C:\dev\codex`, `C:\dev\opencode`); `--help` output of the installed CLIs (Claude Code 2.1.325,
Qwen Code 0.27.1, Codex 0.167.0, OpenCode 2.2.6, Copilot CLI 1.0.112, agy 1.5.9). Each claim
below says whether it was probed, read in source, or only seen in `--help`.

## Why this exists

ctrlyoke wraps each harness's main CLI: the TUI in a PTY for interactive steps, `-p`/`exec`/
`run` for headless steps, plus hooks and log-file parsing for events. Every harness also has a
machine-facing mode meant for SDKs, editors and servers. The headless control plan is the
first time ctrlyoke uses one (Qwen's stream-json SDK mode). This document maps those modes
across all six harnesses, explains ACP, and lists what else they could give ctrlyoke.

## What "SDK mode" means

Two different shapes go by that name.

1. **Stdio pipe.** The vendor's SDK library spawns the CLI as a child process with a
   machine-mode flag and exchanges one JSON object per line (or framed JSON-RPC) over
   stdin/stdout. No port. The channel carries:
   - user messages in,
   - events out (assistant text, tool calls, results, usage),
   - control requests both ways: the CLI asks "may I run this tool?" and the host answers; the
     host sends `interrupt`, `set_model`, `set_permission_mode`.
2. **Server / daemon.** A long-lived process serves HTTP+SSE or WebSocket. Clients create
   sessions, send prompts and subscribe to events. Several clients can attach to one session,
   and some harnesses can point their own TUI at the server.

## Per-harness map

| Harness  | Official SDK                                                                                                                                                                                                                                | Server / daemon                                                                                                                                                                                                                                                                                                  | ACP                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Claude   | Agent SDK spawns `claude -p --input-format stream-json --output-format stream-json` with the control protocol (probed in the plan)                                                                                                          | none. `--remote-control` is a separate feature; `claude mcp serve` exposes Claude's tools as an MCP server, not the agent                                                                                                                                                                                        | no native. Zed maintains an adapter built on the Agent SDK |
| Qwen     | `@qwen-code/sdk` (TS, plus Python and Java) spawns `qwen --input-format stream-json --output-format stream-json --channel=SDK` (source: `packages/sdk-typescript/src/transport/ProcessTransport.ts:316-320`). Same control shapes as Claude | `qwen serve`, an HTTP daemon marked "Stage 1 experimental"; `qwen attach --session <id>` attaches a terminal to a daemon session; `qwen daemon` manages them (`--help`). Built on `packages/acp-bridge`, which has multi-client permission policies (`first-responder`, `designated`, `consensus`, `local-only`) | native `--acp`                                             |
| Codex    | `@openai/codex-sdk` only spawns `codex exec --experimental-json` (source: `sdk/typescript/src/exec.ts:95`): one turn per process, no approvals                                                                                              | `codex app-server` (marked experimental): JSON-RPC v2 over stdio or WebSocket, the same server the VS Code extension and `codex exec` use internally. `codex --remote ws://…` connects the TUI to it; `codex remote-control` manages a daemon (`--help`)                                                         | no native. Zed maintains `codex-acp`                       |
| OpenCode | `@opencode-ai/sdk` is an HTTP client for the server                                                                                                                                                                                         | `opencode serve` (REST+SSE, OpenAPI at `/doc`). OpenCode 2 always runs a background service; the TUI's `--server <url>` connects to one, `--standalone` runs a private one (`--help`)                                                                                                                            | native `opencode acp`                                      |
| Copilot  | copilot-sdk drives the hidden `--server --stdio` mode (Content-Length JSON-RPC: `session.create`, `session.send`, `session.abort`, `session.event`; probed in the plan)                                                                     | that hidden mode only                                                                                                                                                                                                                                                                                            | native `--acp`, documented in `copilot help acp`           |
| agy      | none found                                                                                                                                                                                                                                  | `remote-control` daemon (not investigated); `--input-format stream-json` is a queue-only input pipe with no control vocabulary (probed)                                                                                                                                                                          | native `agy acp`                                           |

Notes:

- Qwen's SDK mode is not Qwen-specific. It is the Agent SDK pattern, and Qwen copied Claude's
  message shapes.
- The official Codex SDK is weaker than `codex exec` itself. The rich surface is `app-server`,
  which ctrlyoke already spawns for quota (`src/core/harness/codex/CodexAppServerClient.ts`).
- `copilot help acp` documents that a `session/prompt` response waits for attached background
  work, and offers opt-in foreground-activity events (`assistant.turn_start`,
  `assistant.idle`, `session.idle`). That is a cleaner background-work signal than ctrlyoke
  gets from Copilot today.

## ACP

ACP is the **Agent Client Protocol**, started by Zed in 2025. It is to coding agents what LSP
is to language servers: one editor implements the client once and can drive any agent that
implements the server.

Do not confuse it with IBM's "Agent Communication Protocol", an agent-to-agent protocol that
was also abbreviated ACP and has since merged into A2A. Older ctrlyoke research described ACP
as agent-to-agent; that was this mix-up.

- **Transport:** JSON-RPC 2.0 over the agent's stdio. The editor is the client and starts the
  agent as a subprocess.
- **Client → agent:** `initialize`, `authenticate`, `session/new`, `session/load`,
  `session/prompt` (its response carries a `stopReason` when the turn ends, a clean
  completion signal), `session/cancel`, `session/set_mode`.
- **Agent → client notifications:** `session/update` with message chunks, tool calls and
  their status updates, plans, and available commands.
- **Agent → client requests:** `session/request_permission` (options such as
  `allow_once`/`allow_always`/`reject_once`), and optionally `fs/read_text_file`,
  `fs/write_text_file` and `terminal/*`, so the editor can serve unsaved buffers and host the
  agent's terminals.
- **Extensions:** vendor features ride in `_meta` fields and `_`-prefixed methods, for
  example OpenCode's `_session/steering` and Copilot's foreground-activity events.

### ACP versus native channels

|                   | ACP                                                                                                                                                     | Native SDK / server channel                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Coverage          | Qwen, OpenCode, Copilot, agy natively; Claude and Codex only through third-party adapters                                                               | One harness each                                                                              |
| Vocabulary        | Lowest common denominator, editor-shaped                                                                                                                | Everything the vendor exposes: usage, hook detail, model switching, harness tools             |
| A prompt mid-turn | Copilot and agy cancel the running turn and start the new one (probed); OpenCode refuses a second `session/prompt` and steers only through an extension | True mid-turn steer on Claude, Codex, OpenCode and Copilot server mode; queue on Qwen and agy |
| Output            | ACP `session/update` events replace the vendor log ctrlyoke parses today                                                                                | Claude and Qwen keep the stream-json ctrlyoke already parses                                  |
| Stability         | A public, versioned spec                                                                                                                                | Varies: OpenAPI (OpenCode), generated schema (Codex), experimental or hidden flags            |

ctrlyoke can turn ACP's cancel-and-replace into a queue by holding a message until the
current `session/prompt` returns.

## What these channels could give ctrlyoke

Ranked by value and confidence. Item 1 is the current plan; the rest are candidates.

### 1. Headless approvals and steering (planned)

See the headless control plan. It covers all six harnesses through each one's native channel,
with ACP for Copilot and agy approvals.

### 2. OpenCode server-side reads (high value, high confidence)

OpenCode already is a server. Interactive OpenCode 2 steps poll `opencode session export`
once a second and re-parse the whole transcript, a cost that grows with session length. The
fix through `session.message.list` is already planned in
[`OPENCODE_V2_INCREMENTAL_SESSION_POLLING_PLAN.md`](../backlog/OPENCODE_V2_INCREMENTAL_SESSION_POLLING_PLAN.md).
This is the clearest case where not using the server costs ctrlyoke something today.

### 3. Headless model questions (medium value, high confidence)

Claude `AskUserQuestion`, Qwen `ask_user_question`, Codex `item/tool/requestUserInput` and
OpenCode forms arrive over the same channel as approvals. Today a headless step cancels them.
A dashboard card answering them is a natural follow-up to the plan's `ask` policy.

### 4. Headless background work (medium value, needs a probe)

`claude -p` kills its process tree when the turn ends, so headless background work is lost.
Keeping stdin open past `result` is the only route found for a background-task notification
turn to arrive. The plan already lists this as a Stage 2 probe. Copilot ACP's documented
"`session/prompt` waits for background work" behavior is the equivalent there.

### 5. Gentler control (medium value, high confidence)

- Interrupt a turn but keep the process and session (Claude/Qwen `interrupt`, Codex
  `turn/interrupt`, ACP `session/cancel`). Gentler than Stop and requeue.
- `set_model` / `set_permission_mode` mid-session (Claude, Qwen).

### 6. A structured completion signal and session id for headless steps (medium value)

A `result`, `turn/completed` or `session/prompt` response is unambiguous, and the session id
comes back in the handshake. For headless steps on these channels that could reduce reliance
on Stop hooks and hook-based session-id resolution, where much of the hook-debug-log
troubleshooting happens today.

### 7. Interactive steps through a server with the native TUI attached (speculative)

**Idea.** ctrlyoke starts the harness's server, runs the native TUI in the PTY pointed at it
(`codex --remote`, `opencode --server <url>`, `qwen attach --session`), and also connects to
the same session as a second client. The user sees and types into the real TUI exactly as
today (`TerminalInstance.tsx` is unchanged); ctrlyoke reads events and sends control traffic
over the protocol.

**What it does not add.** Interactive steps already have approvals (the user answers them in
the TUI) and steering (`STEER_MESSAGE_PLAN.md` writes turns into the PTY). This is not a new
capability; it is a sturdier way to do what ctrlyoke already does.

**What it does add:**

- **A published contract instead of private log formats.** Events come from a documented
  protocol (OpenCode's OpenAPI, Codex's generated schema) instead of session-log files and
  hooks whose formats can change in any release. Fewer `KNOWN_BROKEN_CLAIMS`-style breakages.
  Caveat: Codex `app-server` and `qwen serve` are still marked experimental, so "stable" is
  relative.
- **Exact steer attribution.** The PTY steer plan accepts a mid-turn race in which a steered
  answer can be attributed one step late. Protocol events carry turn ids (Codex `turn/steer`
  even takes `expectedTurnId`), so attribution is exact.
- **A plain steer write.** No focus pulses, 256-byte chunking or submit pulses, and no temp
  file for a multi-line draft. The `USER_STEER` receipt would show the real text, which
  closes the steer plan's named follow-up about unreadable temp-file references.
- **Exact completion and session id** for interactive steps, without Stop hooks or log
  discovery.
- **Approvals answerable off the TUI.** A dashboard card could answer the same request the TUI
  shows (for example from the hosted dashboard on a phone, where typing TUI keys is awkward).
  Minor.

**Limits and costs:**

- Codex, OpenCode and Qwen only. Claude has no attach mode, and Copilot and agy have none
  documented. Hooks and log parsing stay for the other three, so this adds a second event path
  rather than replacing the first.
- Ports, tokens and server lifetime to manage (OpenCode's plan history shows the cost of
  ctrlyoke-owned ports).
- Unprobed: whether the attached TUI behaves the same as a standalone one (resume, `/`
  commands, hooks, background work), and whether two clients on one session conflict.

**Verdict.** Worth one probe, not a plan yet. Start with Codex, the best fit: ctrlyoke already
has `CodexAppServerClient`, Codex events come from the rollout log rather than a public
contract, and `--remote` is a documented TUI flag. If the probe passes, the reward is that
Codex interactive steps stop depending on rollout-format parsing and `notify`/hook timing.

### 8. A generic ACP harness (strategic)

One adapter that speaks ACP could run any ACP agent: Gemini CLI, Cline (`cline --acp`, see
[`CLINE_INTEGRATION_PLAN.md`](../backlog/CLINE_INTEGRATION_PLAN.md)), Goose, and the native
ACP modes of Qwen, OpenCode, Copilot and agy.

- **What it gives:** a cheap way to add breadth. Prompt, streamed output, tool calls, file
  changes (from `tool_call` updates and `fs/write_text_file`), approvals, cancel, a clean
  completion signal and session load all come from the spec.
- **What it lacks:** no TUI (headless only), no hooks, no harness-specific usage or quota, no
  true mid-turn steer (queue only), and model and agent selection only where the agent exposes
  them as modes or config options. Capability declarations would mark it as a lower tier.
- **Shape:** a seventh-harness-style adapter would change `HARNESS_IDS` and the compatibility
  docs. The alternative is an "ACP agent" harness whose command line is user-configured,
  like a custom model provider. That is a product decision to make before any plan.
- It also gives the plan's Stage 6 (Copilot and agy approvals) a reusable ACP client, so
  building that client generically there costs little extra.

## Recommendations

- Do not make "SDK mode" a user-facing concept. Use each native channel internally, one
  capability at a time, as the headless control plan does.
- Queue next: the OpenCode server-side reads (item 2) and headless model questions (item 3,
  after the plan's `ask` policy).
- Probe item 7 on Codex once Stage 5 (Codex over app-server) lands, because it reuses that
  client.
- Build the Stage 6 ACP client generically so item 8 stays cheap. Decide the product shape
  of a generic ACP harness before planning it.
