# Headless Session Control: Steering and Approvals

**Status:** Implemented 2026-11-16/17. Stages 1–5, the Interrupt Turn follow-up, 6a (Copilot ACP)
and 6c (OpenCode 2.3.0+ plugin) shipped with unit tests and live harness cases; per-stage
results and the probe evidence behind each decision are under "Implementation stages" and
"Findings". **6b (Antigravity ACP approvals) is deferred**: agy's ACP mode ignored ctrlyoke's
per-run deny rules and did not ask before file edits, so agy keeps Stage 4's stream-json queue
steering with `deny` approvals. Its unblock criteria are under 6b.
Deviations from the design sketch: the optional provider hook receives only prepared prompt
text; `HeadlessControlSpawnShape.args` appends protocol args, except Copilot ACP, which
replaces the provider-built args; the coordinator ends stdin before `channel.close()`. Claude
sends user records without `initialize` or `--permission-prompt-tool stdio` and opts into that
handshake only under `ask`. Codex and Copilot ACP denials cannot carry a custom message to the
model. Follow-ups not built: an MCP tool to list and answer pending approvals, and model-question
tools (currently denied).
**Priority:** P1 (Stage 1 fixes a high-severity hang)
**Order:** implement this plan's Stage 1 before the stdin inline plan. It fixes the P1 hang and
builds the transport the inline plan reuses.

**Fixes:** [`qwen-headless-approval-request-hangs.md`](../bugs/implemented/qwen-headless-approval-request-hangs.md)
(Stage 1).
**Extends:** [`STEER_MESSAGE_PLAN.md`](../implemented/STEER_MESSAGE_PLAN.md), which scoped
headless steering out because "there is no PTY".
**Overlaps:** [`HEADLESS_STDIN_INLINE_PROMPT_PLAN.md`](HEADLESS_STDIN_INLINE_PROMPT_PLAN.md).
Both plans move the headless prompt onto stdin. Build them on one transport (see
"Relationship to the stdin inline plan").

## Problem

ctrlyoke treats a headless run as atomic. It spawns the CLI with the prompt in argv (or, for
OpenCode, as stdin text that is written and closed at once; `CliTransportCoordinator.spawnProcess`
`stdinText`). It reads output, and the step ends when the process exits. Nothing is ever sent to
the process after it starts. That causes three problems:

1. **A tool that needs approval cannot be answered.** Most harnesses refuse it in-band, so the
   step carries on without the action. Qwen instead **hangs until the prompt timeout** (the bug
   above).
2. **A running headless step cannot be steered.** The dispatch menu's "Send Steer Message" is
   disabled for headless steps. The only option is to stop the step and requeue it.
3. **`custom` headless means "deny anything unlisted".** There is no way to say "ask me", as
   there is in the TUI.

Every harness turns out to have a long-lived headless channel. That channel carries approval
requests that a host answers, and it accepts more user messages while the run is live. This plan
uses those channels.

## Findings

Probes ran on 2026-11-15 from a scratch directory, with a `mark.js` that writes a file. Each
probe:

- ran a command that needed approval (allowed once, denied once with a message),
- then started `sleep 15` and sent "The secret word is PINEAPPLE." about 7 s in.

A **steer** puts the message into the running turn: the model answers PINEAPPLE in that same
turn. A **queue** runs it as the next turn. **Cancel-and-replace** aborts the running turn.

| Harness (version)     | Channel                                                                                        | Message while running                                  | Approval requests                                                                                 | How verified                                |
| --------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Claude Code 2.1.325   | `-p --input-format stream-json`; approvals add `--permission-prompt-tool stdio` + `initialize` | **steer** (mid-tool, same turn)                        | `control_request` `can_use_tool`; reply allow (+`updatedInput`) / deny (+`message`)               | probed                                      |
| Qwen Code 0.27.1      | stream-json **SDK mode**: `initialize` first, no positional prompt                             | **queue** (next turn)                                  | `can_use_tool` (same shape as Claude); 60 s default timeout, up to 600 s                          | probed + source                             |
| Codex 0.169.0         | `codex app-server` JSON-RPC v2                                                                 | **steer** (`turn/steer`)                               | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/…`  | probed                                      |
| OpenCode 2.3.0        | plugin `permission.hook("evaluate")` + `ctx.session.prompt`, or `opencode serve`               | **steer** (`delivery: "steer"`, default) or queue      | plugin `evaluate` effect `allow`/`deny`; server `permission.asked` reply `once`/`always`/`reject` | async hook probed; steer/server source only |
| Copilot CLI 1.0.112   | `--acp`                                                                                        | **cancel-and-replace** (probed)                        | `session/request_permission` (`allow_once`/`allow_always`/`reject_once`)                          | probed                                      |
|                       | hidden `--server --stdio` (copilot-sdk protocol)                                               | **steer** (`session.send` `mode: "immediate"`, probed) | `permission.request` exists, but routing it to the client was not achieved                        | probed                                      |
| Antigravity agy 1.5.9 | `--input-format stream-json` (`{"event":"user",…}`)                                            | **queue** (probed)                                     | **none** (no control vocabulary in the binary)                                                    | probed                                      |
|                       | `agy acp`                                                                                      | **cancel-and-replace** (probed)                        | `session/request_permission` (`allow`/`deny`)                                                     | probed                                      |

Every harness has a channel that can answer the approval requests it actually emits (agy and
Copilot only over ACP), and every harness accepts more input on a live session. True mid-turn
steering exists on Claude, Codex, OpenCode and Copilot (server mode). Qwen and agy queue the
message as the next turn. ACP's cancel-and-replace is not a steer; ctrlyoke can turn it into a
queue by holding the message until the current `session/prompt` returns. The Stage 6
Antigravity probe below found that ACP did not request approval for direct file edits and did
not enforce ctrlyoke's per-run permission settings, so that sub-stage is deferred rather than
widening permissions.

### Claude Code

- Plain `-p --input-format stream-json` with no host handshake auto-rejects anything that needs
  approval ("This command requires approval", `permission_decision.source: "config"`).
  `--permission-prompts host` is the default, but the request only reaches stdout after
  `--permission-prompt-tool stdio` plus an `{"type":"control_request","request":{"subtype":"initialize"}}`.
  That is the Agent SDK's own handshake.
- Request: `{"type":"control_request","request_id","request":{"subtype":"can_use_tool","tool_name","input","permission_suggestions","decision_reason","tool_use_id"}}`.
- Reply: `{"type":"control_response","response":{"subtype":"success","request_id","response":{"behavior":"allow","updatedInput":{…}}}}`.
  Deny with `{"behavior":"deny","message":"…"}`; the message reaches the model verbatim as the
  tool result.
- A `user` line written while a tool was running was injected into that turn. The model answered
  from it, and only one `result` was emitted.
- Host mode also adds `AskUserQuestion`, `EnterPlanMode` and `ExitPlanMode` to the tool list.
  Model questions therefore come over the same channel.
- Stdout is the stream-json ctrlyoke already parses. The process exits when stdin closes.
- A probe that needs an approval must pass `--setting-sources project`. Otherwise the user's own
  allow rules approve the command before any request is sent; the first probe here did exactly
  that.
- **Stage 2a probes (Claude Code 2.1.325, 2026-11-16):** A `user` message containing
  `@somefile` did not expand the file even without `initialize`; Claude reported that no file was
  attached. Claude is now opted into generated-section inlining for headless stdin, while direct
  workspace references remain paths the model can read on demand.
- Two stream-json `user` records without an `initialize` handshake produced two results, so
  Stage 2a omits both `initialize` and `--permission-prompt-tool stdio`. Custom headless
  `--permission-mode dontAsk` remains unchanged; the shared coordinator answers any
  `can_use_tool` request that nevertheless appears with ctrlyoke's deny response.
- A background Agent emitted `system.task_notification` after the first `result` while stdin
  remained open, followed by its resumed user/assistant turn and another `result`. Stage 2a
  reproduced this without `initialize` too, matching its production launch. It holds channel
  closure while `ClaudeLogParser` reports pending background work, bounded by the configured
  prompt timeout.

### Qwen Code

Source paths are relative to `C:\dev\qwen-code\packages\cli\src\`.

- **The bug's root cause is wrong in detail.** In ctrlyoke's launch (positional prompt +
  `--input-format stream-json`), the positional prompt becomes the first message, which selects
  "direct mode" and turns the control system off (`nonInteractive\session.ts:380-412`,
  `:478-481`). **No `can_use_tool` is ever written** (probed: the stdout ends at the `tool_use`).
  The tool waits in `awaiting_approval` with no confirm handler
  (`core\src\core\nonInteractiveToolExecutor.ts:76-98`), and at EOF the session waits for it
  forever (`session.ts:931-938`).
- **SDK mode works.** Drop the positional prompt and write `initialize` first; Qwen rejects a
  second `initialize` while one is pending, so wait for its `control_response` before sending
  `user` messages. Probed: `can_use_tool` arrived, allow ran the command, and deny-with-message
  reached the model as `[Operation Cancelled] Reason: …`.
- Each request times out after 60 s by default and then counts as Cancel. `initialize.timeout.canUseTool`
  raises it to at most 600,000 ms (`control\controllers\permissionController.ts:42`,
  `systemController.ts:206-214`). Stdin EOF cancels any pending request, so SDK mode cannot hang
  this way (`ControlDispatcher.ts:216-239`).
- Messages sent mid-turn are queued as full turns (`session.ts:759-819`). Probed: PINEAPPLE came
  back as a separate fourth `result`.
- The stream-json exemption from the non-interactive auto-deny gate depends on input format
  only, not on direct vs SDK mode (`config\config.ts:2188-2235`), so SDK mode keeps it.
- Also available: `interrupt` (aborts the turn, keeps the process), `set_permission_mode`,
  `set_model`.
- Caveat: `initialize` sets SDK mode, which slightly changes plan-mode wording
  (`systemController.ts:193`).
- **SDK mode side effects found in the Stage 1 review (2026-11-15, Qwen 0.27.4), resolved:**
  - The review's "subagent turns are not streamed in SDK mode" was a probe artifact: that run's
    model omitted `run_in_background: false`, so the agent ran in the background, and only a
    background agent's turns stay off stdout. A foreground subagent streams its records with
    `parent_tool_use_id` in SDK mode too (re-probed). Headless Qwen does not read them anyway
    (`headlessSource = LOG`); it follows `<project>/subagents/<session>/*.jsonl`, which both
    modes write.
  - The live case failure had two causes. (1) The agent list below made the model pick `fork`,
    which Qwen always backgrounds in headless mode and which inherits the parent conversation
    (one fork ran nothing). (2) A ctrlyoke race: Qwen writes a turn's thought and its tool call
    as two assistant records 0-8 ms apart, and the child follower treated "assistant record
    without a functionCall" as the end, so a 150 ms poll between them dropped the child's
    command. `QwenLogParser` now completes a child when the parent stream reports it (the
    foreground spawn's own result, or the background agent's terminal task notification) or
    when its `<agent>.meta.json` `status` turns terminal, and keeps the old rule only for a
    child with no sidecar. Meta alone is not enough: with two parallel foreground agents, Qwen
    0.27.4 left one finished agent's status at `running`.
  - The live case now names `subagent_type "general-purpose"` for Qwen (see the next bullet);
    it passes, as do both Codex escalation cases.
  - `SubagentManager.listSubagents` returns only `session`-level subagents in SDK mode
    (`core\src\subagents\subagent-manager.ts:583`), so the agent tool says "No subagents are
    currently configured". Dispatch still resolves every level (`loadSubagent`): a live probe
    ran a project agent and the builtin `general-purpose` by name, both foreground. Passing
    `initialize.agents` would restore the list only by shadowing each agent with a session copy
    (session wins in `loadSubagent`), which for builtins means copying Qwen's internal system
    prompts. Not done; documented instead. Revisit if Qwen adds an SDK option to list all levels.
  - A turn's `result` is held until its background agents finish (`nonInteractiveCli.ts`
    holdback loop around `:4039`), and stdin EOF aborts every background registry
    (`session.ts` `drainAndShutdown`), so closing at `result` loses nothing that ran in the turn.
  - The Qwen `can_use_tool` reply must be
    `{"type":"control_response","response":{"subtype":"success","request_id","response":{"behavior","message"}}}`
    (`ControlDispatcher.handleControlResponse`); a flat reply is ignored and times out after 60 s.

### Codex

Source paths are relative to `C:\dev\codex\codex-rs\`.

- `codex exec` reads input once. It forces the approval policy to `Never` and answers any
  approval that still arrives with an error, which marks the run as errored
  (`exec/src/lib.rs:630-632`, `:2230-2362`).
- `codex exec` is itself an in-process app-server client (`exec/src/lib.rs:790-815`), so
  app-server emits the same notifications exec's `--json` output is built from.
- App-server v2 provides:
  - `thread/start`, `thread/resume`, `turn/start`.
  - `turn/steer {threadId, input, expectedTurnId}`, which adds to the running turn.
  - `turn/interrupt`.
  - The approval requests in the table. Command decisions are `accept`, `acceptForSession`,
    `decline` (the turn continues) and `cancel` (the turn is interrupted).
- No client-side timeout was found: an unanswered request waits.
- `-c` overrides apply per process (`codex app-server -c …`) or per thread (`config: {…}`), and
  hooks work through the same path.
- Open point: app-server threads are tagged `SessionSource::VSCode` and exec threads `Exec`.
  `exec resume <id>` calls `thread/resume`, so it should accept either. The tag changes which
  threads `codex resume`'s picker shows.
- ctrlyoke already spawns `codex app-server` for quota (`src/core/harness/codex/CodexAppServerClient.ts`).

### OpenCode

Source paths are relative to `C:\dev\opencode\packages\`.

- `opencode run --standalone` (ctrlyoke's launch) reads stdin once. It answers every
  `permission.asked` with `reject` (or `once` under `--auto`) itself (`cli\src\run\noninteractive.ts:97-112`),
  and its private server's URL and password cannot be discovered from outside.
- **The plugin route keeps today's launch.**
  - `ctx.permission.hook("evaluate", ev => { ev.effect = "allow"|"deny"|"ask"; ev.message })`
    runs before an ask is created (`plugin\src\promise\permission.ts:8-23`,
    `core\src\permission.ts:190-201`), so it decides before `run` can auto-reject.
  - `ctx.session.prompt({…, delivery: "steer"})` injects at the next step boundary.
  - ctrlyoke's plugin (`src/scripts/ctrlyoke-opencode-plugin-v2/index.ts`) uses neither today.
  - It needs a ctrlyoke→plugin channel. The Stage 6 probe verified that an async hook can await
    a host decision for over 30 s; a per-process loopback HTTP bridge is the proposed channel.
- **Stage 6 probe (OpenCode 2.3.0, 2026-11-16):** a V2 plugin loaded through
  `OPENCODE_CONFIG_CONTENT` with `plugins:[<directory>]` registered
  `ctx.permission.hook("evaluate", async ...)`. Its event included `sessionID`, `agent`,
  `action`, `resources`, `source`, and `effect`. The plugin posted the event to a host loopback
  endpoint and awaited the response; the host replied with a denial after 32 s, the hook
  completed after 32.022 s, and `opencode run --standalone --format json` returned the denial
  reason to the model without running the command. This proves the permission half of the
  proposed bridge; host-to-plugin steering delivery still needs its live case in Stage 6c.
- **Server route:**
  - `opencode serve` with `OPENCODE_PASSWORD`.
  - `POST /api/session/:id/prompt {text, delivery}` sends a message.
  - `POST /api/session/:sid/permission/:rid/reply {decision, message?}` answers a permission.
  - `GET /api/experimental/session/:id/log?follow=true` replays and follows the session.
  - `POST /api/session/:id/interrupt` interrupts.
  - Sessions land in the same `opencode.db`.
- `opencode acp` also exists. It steers through the extension `_session/steering`; a second
  `session/prompt` is refused.

### Copilot CLI

- `-p` closes after one prompt. With `COPILOT_PROMPT_TURN_DELIMITER` set it splits stdin into
  several turns, but only up front.
- **ACP (`--acp`), probed:**
  - `session/request_permission` arrives with `allow_once`/`allow_always`/`reject_once`, and
    both answers worked.
  - A second `session/prompt` during a turn ended the first with `stopReason: "cancelled"`. The
    output said "Operation cancelled by user", the running `sleep` was killed, and then the new
    prompt ran with the conversation intact.
  - Opt-in foreground events: `assistant.turn_start`, `assistant.idle` and `session.idle`
    (`copilot help acp`).
- **Hidden server mode (`--server --stdio`), probed:**
  - It speaks the copilot-sdk protocol: Content-Length framed JSON-RPC with `session.create`,
    `session.send {sessionId, prompt, mode}`, `session.abort` and `session.resume`, and
    `session.event` notifications.
  - `mode: "immediate"` is a real steer. The running `sleep` was moved to the background, not
    killed, and the message was injected and answered in the same run. The TUI sends this mode
    too.
  - Permission requests were not routed to the client in the probe. Copilot answered "could not
    request permission from user" itself. The `session.create` handler does not forward a
    `requestPermission` option, so the opt-in is somewhere else; this is unresolved.
  - The flag is hidden and undocumented, so treat it as unstable.
- **Stage 6 ACP probe (Copilot CLI 1.0.112, 2026-11-16):** `--allow-tool shell(echo)` ran the
  command without a permission request; `--deny-tool shell(echo)` returned a failed tool call
  with the matching rule; `--allow-all-tools` and `--yolo` also launched and allowed the
  harmless echo case. `--assisted-approval` fails before ACP initialization with
  "`--assisted-approval` is only supported in non-interactive prompt mode or direct workflow
  mode." The ACP Autopilot mode is not a replacement: its advertised behavior is allow-all,
  not the assisted-approval judge.
- ACP `session/new` returns the session ID used for
  `~/.copilot/session-state/<sessionId>/events.jsonl`; ACP runs wrote the same native event
  types (`session.start`, `user.message`, `assistant.message`, `tool.execution_start`,
  `tool.execution_complete`, and others) consumed by `CopilotLogParser`. A second process
  successfully used `session/load` with that ID and continued the same history. Thus output
  can stay on the existing log parser; no ACP output-event mapper is needed. The observed
  `session/update` values were `user_message_chunk`, `agent_message_chunk`,
  `agent_thought_chunk`, `tool_call`, `tool_call_update`, `available_commands_update`,
  `session_info_update`, and `usage_update`. Opting into
  `github.com/copilot/sessionEvent` also produced `assistant.turn_start`, `assistant.idle`,
  and `session.idle`.
- The existing ACP probe confirmed that a second `session/prompt` cancels the active one.
  Stage 6 must therefore queue steers in ctrlyoke and send them only after the outstanding
  prompt request resolves.

### Antigravity (agy)

- `--input-format stream-json` expects `{"event":"user","message":{"role":"user","content":"…"}}`
  per line. A line without `event` fails the run ("stream input message is missing the "event"
  field"), and `"type":"user"` is not accepted.
- On agy 1.5.9, a second user record written 250 ms after the first queued behind the running
  turn. Each turn emitted its own terminal `result` event, and closing stdin after the second
  `result` exited with code 0. No older version was probed, so Stage 4 does not add a version
  gate.
- Messages queue as next turns (probed). The binary has no control vocabulary ("stream input
  message event %q is not supported yet"), so **approvals cannot go over stream-json**.
- **`agy acp`, probed:**
  - `session/request_permission` with `allow`/`deny` options; both worked.
  - Modes: `default`, `accept-edits`, `auto`, `plan`.
  - A second prompt ended the first (`end_turn`) and ran the new one, so it is
    cancel-and-replace.
- **Stage 6 ACP probe (agy 1.5.9, 2026-11-16):** `agy --model gemini-3.8-flash-low acp`
  started successfully (the model flag must precede `acp`). `session/new` and `session/load`
  worked, and `session/prompt` emitted `user_message_chunk`, `agent_message_chunk`,
  `tool_call`, `tool_call_update`, `usage_update`, and `session_info_update`. For a terminal
  command, `session/request_permission` offered `{optionId:"allow", kind:"allow_once"}` and
  `{optionId:"deny", kind:"reject_once"}`; selecting either worked. Its prompt result was
  `stopReason:"end_turn"`.
- ACP does not emit Antigravity's stream-json records, but it writes the ordinary
  `transcript_full.jsonl` under the ACP session ID. The probe's transcript contained the
  existing `USER_INPUT`, `PLANNER_RESPONSE`, `GENERIC`, and `SYSTEM_MESSAGE` entry types, so
  `AntigravityLogParser` can remain the output source if the ACP session ID is supplied
  directly. However, the ACP run created a file through `write_to_file` without any
  `session/request_permission`, even with `toolPermission:"request-review"`. A run with
  `--settings` containing `permissions.deny:["command(*)"]` also executed the denied echo
  command. ACP therefore does not currently preserve ctrlyoke's per-run permission rules or
  approval coverage; Stage 6b is deferred until both are fixed or proven to have an equivalent
  host-side enforcement path.

## Is it worth doing?

Yes:

- Stage 1 alone fixes a hang that costs an hour of wall time per occurrence.
- For Claude and Qwen it is cheap: same binary, same stdout format, only a different stdin.
- Headless steering is cleaner than PTY steering. A headless process belongs to exactly one
  step, so a steered turn's output can't be attributed to the wrong step (the PTY plan's
  accepted mid-turn race does not exist here).
- "Ask me" headless approvals are a real new capability. Today `custom` headless can only
  refuse.

The cost is that each harness's channel is different. ACP looks like a unifier, but Claude and
Codex have no native ACP. On the harnesses that have it, ACP replaces today's stdout or log
parsing with ACP `session/update` events, and two of the four only offer cancel-and-replace. So
this plan uses each harness's native channel and keeps today's output parsing wherever it can.

## Design

### The control channel

Add an optional provider hook, `createHeadlessControlChannel(...)`, returning an
`IHeadlessControlChannel` (in `src/core/harness/shared/`):

```ts
interface IHeadlessControlChannel {
  /** Extra args / env for the spawn; may replace the prompt-in-argv form. */
  readonly spawnShape: HeadlessControlSpawnShape;
  /** Handshake written before the first user message (Claude/Qwen `initialize`). */
  start(writer: ControlWriter): Promise<void>;
  sendUserMessage(text: string): Promise<void>;
  /** Parse one stdout record; returns approval requests and turn boundaries it saw. */
  observe(record: unknown): ControlObservation[];
  answerApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  /** How a message sent mid-turn is delivered. */
  readonly steerDelivery: HeadlessSteerDelivery; // INJECT | QUEUE
  close(): void; // ends stdin; the process then exits as today
}
```

- `CliTransportCoordinator` gains a spawn path that keeps stdin open. `processManager.spawn`
  today takes only a one-shot `stdinText`, so it must hand back a writable stdin. Output keeps
  flowing through the existing `parseStdout`/log-tail path; the channel only _observes_ records
  for control traffic.
- **Turn end replaces process exit as the completion signal.** The channel reports a turn
  boundary (Claude/Qwen `result`, Codex `turn/completed`, ACP `session/prompt` response). When
  no steer is still queued, the coordinator calls `close()`. The process exits and the existing
  exit, `responseText` and failure handling runs unchanged. A queued steer keeps stdin open for
  one more turn, so its output stays inside the same step.
- Stdin carries both the handshake and later messages, so writes are serialized with an
  `AsyncMutex` per channel, as the PTY writer does.
- Vocabulary (`HEADLESS_STEER_DELIVERIES`, `APPROVAL_DECISIONS`, control message types) goes in
  `DashboardConstants.ts`. Wire-format literals stay in each harness's protocol constants file.

### Approval policy

One host-side policy answers every request:

- **`deny`** (default, today's behavior): answer at once with a deny whose message tells the
  model why. For example: "ctrlyoke: this headless step cannot ask for approval. Add an allow
  rule to `toolPermissions` or run the step interactively." This is an answer, not silence, so
  it can never hang.
- **`ask`**: show the request in the step's output with Allow once / Deny buttons and an
  optional deny message. Any dashboard client may answer, by the same reasoning as the steer
  plan's viewer decision. If nobody answers within a timeout, deny with a message saying so
  (decided 2026-11-15: deny, not pause, so unattended runs keep moving).
  Clamp the timeout to the harness's own limit (Qwen at most 600 s). With no dashboard attached
  (plain CLI runs), `ask` behaves like `deny`.
- Applies to `custom` (unlisted tools) and to `auto` escalations the judge hands to a human.
  `allowAll` and `dangerouslyAllowAll` never produce requests.
- Settings surface: an additive `toolPermissions.headlessApprovals: "deny" | "ask"` plus a
  timeout. Confirm with `CONTRIBUTING.md` that a new optional field needs no `schema:bump`, and
  record it under **Changed** when `ask` ships.
- Allow-always / accept-for-session options are not offered in v1. They would quietly widen the
  step's permissions beyond what the workflow file says.
- For Claude, `ask` means switching headless `custom` from `--permission-mode dontAsk` to
  `default` + `--permission-prompt-tool stdio` (`ClaudeToolPermissionMapper.ts:135-141`).
  Under `deny`, keep `dontAsk`, so refusals stay in-band and unchanged.

Model questions (Claude `AskUserQuestion`, Qwen `ask_user_question`, Codex
`item/tool/requestUserInput`, OpenCode forms) use the same channel. They are out of scope for v1
and get cancelled, as OpenCode `run` does today. That is a natural follow-up.

### Headless steering (extends STEER_MESSAGE_PLAN)

- **Host.** `WorkflowInstance.sendSteerMessage` today requires a live PTY session. Add a
  headless branch: resolve the running integration whose channel is open and send through
  `IHeadlessControlChannel.sendUserMessage`. Keep the host-side liveness re-check and the
  human-readable errors.
- **Target identity.**
  - A headless step has no PTY session id. Give each open channel a `controlSessionId` and
    publish `{workflowId, controlSessionId, stepIndex, harnessId, steerDelivery}` to the webview
    when the channel opens and closes. Use a new message type in the steer block of
    `DashboardConstants.ts`.
  - `SEND_STEER_MESSAGE` keeps its payload; `sessionId` may now name either kind.
- **Gate.** Replace `useActiveInteractiveSession` in `useRunDispatchTargets` with a
  `useActiveSteerTarget` hook. It returns the rail-active AI-CLI PTY session or the running
  headless channel, with the PTY session taking priority. The enabled tooltip states the
  delivery:
  - `Sends to the live Claude session (step N). Prompt overrides are ignored.`
  - `Queues for the live Qwen session after its current turn (step N). Prompt overrides are ignored.`
- **Preparation.**
  - The text is JSON-encoded, so control characters are safe. Prepare it with
    `injectMode = false`: a multi-line draft goes inline instead of through a temp file, which
    also removes the deferred temp-file cleanup the PTY path needs.
  - References still go through `formatDirectFileRef`, so behavior matches a normal prompt.
- **Receipt.**
  - Headless stdout does not reliably echo user messages (Claude only does with
    `--replay-user-messages`). So the channel itself emits the `CLI_EVENT_TYPES.USER_STEER`
    event once the write succeeds, into the step's own event stream.
  - Don't turn on harness echo too, or the receipt appears twice.
  - This is the opposite of the PTY plan's decision, for the stated reason.
- **No between-runs steering.** A headless process ends with its step. Steering a finished
  headless session means resuming it, which is a new step (Run).

### Relationship to the stdin inline plan

With a control channel, the first prompt is just the first user message on stdin. That is the
inline plan's transport for Claude and Qwen. Ship the transport once, here, and let the inline
plan decide only _what text_ goes in that first message:

- inlined generated sections, or
- today's `follow the instructions in @…` sentence.

The inline plan's per-harness notes still apply. For Qwen, escape `@` and avoid a leading `/`.
The inline plan's old "do not add `--input-format stream-json`" note for Claude is superseded,
because stream-json input is required for the control channel. Before moving Claude (Stage 2),
probe whether `@path` still expands inside a stream-json `user` message; if not, Claude's
inlining ships with its channel.

Recommended order: this plan's Stage 1 (Qwen), then the inline plan's prompt-text work for Qwen
and the plain-stdin harnesses (Copilot, plus Codex and agy as interim arg changes), then Stage 2
(Claude channel, with inlining if the probe needs it), then Stages 3–6.

## Implementation stages

### Stage 1 [Done]: control channel + Qwen, `deny` policy

Writable-stdin spawn, the channel interface,
turn-end completion, and the Qwen implementation. Qwen drops the positional prompt and sends
`initialize` first. Every approval request gets ctrlyoke's deny message. This fixes the Qwen
hang. The bug is in `dev/bugs/implemented/` with the corrected root cause.
The harness case for the Qwen "unlisted command chained to an allowed one" scenario already
exists ("an allowed command does not allow an unlisted one chained to it" in
`src/test/harness/inline-config.harness.test.ts`); it timed out before Stage 1, and its comments
no longer cite the bug as open. Confirmed live on 2026-11-15 (full `npm run test:harness`,
then the whole `qwen-cli` set after the follow-up): the case passes in about 18 s. The only
Qwen failure left is skill-mode commit generation, filed as
`dev/bugs/backlog/qwen-skill-commit-allow-rule-does-not-match.md` (it hung before Stage 1).

- **Qwen's `headlessSource` is `LOG`.** Its stdout chunks go to `HeadlessLogTail.onStdoutChunk`,
  not to `parseStdout`. The channel must see every complete stdout JSONL record whatever the
  source mode, so split stdout into records for the channel independently of the output path.
- **Claude was deferred from Stage 1.** Under `deny`, Claude keeps `dontAsk`, which already
  refuses in-band. Stage 2a later moved its prompt transport to stream-json and enabled
  generated-section inlining after the `@path` probe below.
- Stdin must stay open until the turn's `result`, because approval answers go on stdin. Stdin
  EOF cancels a pending request, so `close()` at turn end (or on Stop) can never hang.

### Stage 2a [Done]: Claude channel + prompt transport

Move Claude headless onto stream-json stdin,
send the first prompt as a `user` message, and inline generated sections because the
`@path` probe showed they are not expanded. Do not initialize host permission prompting:
custom stays `dontAsk`, and any `can_use_tool` request is answered with deny. When the
parser reports pending background work after `result`, hold stdin open until it clears or
the prompt timeout expires. `npm run test:harness -- --grep "claude-cli"` passed (20 tests),
including headless image input and resume.

### Stage 2b [Done]: headless steer dispatch for Claude (inject) and Qwen (queue)

The
coordinator keeps stdin open for the appropriate result boundary, publishes a uniquely
identified control target on open/close, prepares steer text inline, and adds one `USER_STEER`
receipt to the running step after the write succeeds. The existing log pump suppresses an
echoed copy of a message sent by ctrlyoke.

The webview stores open targets by workflow, clears them on channel close, workflow end and
reconnect, and uses the selected PTY ahead of a headless channel. The editor sends the control
session id through the existing `SEND_STEER_MESSAGE` payload. Claude and Qwen tooltips describe
their different delivery behavior.

### Stage 3 [Done]: `ask` policy with output-pane approvals

Added the optional
`toolPermissions.headlessApprovals` (`deny`/`ask`) and `headlessApprovalTimeoutSec` fields to
settings and workflow schemas; no schema bump is needed for optional fields. The host policy
service registers request metadata and deadlines, broadcasts pending/removal messages, accepts
allow-once or deny (with an optional message) from any dashboard client, and denies on timeout,
missing dashboard, Stop, abort or close. Claude uses `default`, `--permission-prompt-tool stdio`,
and `initialize` only for `ask` custom requests and auto-judge escalations; Qwen sets
`initialize.timeout.canUseTool` with its version-specific cap. Model-question tools are
explicitly denied as out of scope. The dashboard stores pending requests by workflow and signed
step index and renders an approval card in that step's output, with a deny countdown, Allow once,
Deny and an optional denial message. Removal, terminal step status and reconnect clear stale
cards; READY replays pending requests, so no additional snapshot is needed. Vitest coverage
exercises the store, output-row projection and card. Live Claude/Qwen cases exercise `ask` with
the no-dashboard fallback because the real-harness runner cannot attach a dashboard approver.
An MCP tool to list and answer pending approvals remains a follow-up.

### Stage 4 [Done]: agy steering over stream-json (queue)

agy approvals stay `deny`; its stream-json
protocol has no approval vocabulary. Since the inline plan shipped, agy receives generated
prompt sections in the first `{"event":"user",…}` record sent on stdin. The adapter now opts
into `--input-format stream-json`, observes terminal `result` events, and leaves failure and
usage parsing on their existing stream-json paths. The 1.5.9 probe confirmed a second message
queues as a distinct turn/result and EOF after the last result exits cleanly; older versions
are not gated without evidence they lack the protocol. The shared compatibility matrix declares
steering support for Claude, Qwen and Antigravity, backed by the live steering suite.

### Stage 5 [Done]: Codex over app-server, steering, interrupt and `ask` approvals

Live-verified on Codex 0.169.0.
Headless Codex 0.146.0 and later uses `codex app-server`; older versions retain the `codex exec` path.
The implementation reuses `CodexAppServerClient`'s version gate:

- Spawn `codex app-server` with the process-level `-c` args for hooks, `hooks.state`, model,
  sandbox and approval policy, then `initialize` with `experimentalApi: true`. Exec-only
  arguments are translated; `--add-dir` roots are merged with configured writable roots through
  `config/read` and the thread config override.
- Send `thread/start` or `thread/resume`, followed by `turn/start` with the same inlined prompt.
  Start uses `historyMode: "paginated"` and `bypass_hook_trust`; no explicit `cwd` is sent because
  Codex treats a requested thread cwd as a project-trust grant. Resume uses the exact session ID;
  a live `codex exec resume <app-server-thread-id>` probe confirmed compatibility.
- Handle command, file-change and permission approval requests. Custom uses Deny by default;
  `headlessApprovals: ask` routes requests to the dashboard. The configured policy timeout
  applies directly because Codex has no client-side approval timeout. Allow once for
  permissions is scoped to the turn. App-server denials cannot carry a custom message, so the
  optional denial message remains in the dashboard approval card and is not sent to Codex.
- Expose in-turn steering through `turn/steer` with the active `expectedTurnId` and `INJECT`
  delivery, and interruption through `turn/interrupt`. If the turn completes before a steer is
  accepted, report a clear error that the message was not queued; do not silently start a
  follow-up turn.
- Output remains sourced from the Codex rollout log (`headlessSource = LOG`), not app-server
  stdout. The parser promotes rollout `task_complete.error` for failure classification and
  records app-server `SubAgentActivity`; the shared follower remains alive through the response
  collector's final drain.

### Stage 6: Copilot, agy and OpenCode approvals and steering

Split into these sub-stages:

- **Shared ACP transport:** put JSONL framing, request correlation, notification dispatch,
  and replies to server-initiated requests in
  `src/core/harness/shared/AcpJsonRpcClient.ts`. Copilot and a future agy channel reuse
  this transport; each provider owns its session parameters, approval-option mapping, and
  output-source choice. Do not treat ACP as a passive `observe(record)` stream: the client
  must answer `session/request_permission` while a `session/prompt` request is outstanding.

#### 6a [Done]: Copilot ACP, except `auto` mode

- **Gate:** `copilot` >= 1.0.112, the first version probed for the permission requests and
  session-load path used here. Older versions keep today's headless launch.
- **Launch:** `copilot --acp` plus the existing model, workspace, hook, MCP, and permission
  arguments. Do not pass `-p`, `--output-format json`, or the prompt as an argument; send the
  prompt through ACP. Use `session/load` instead of `--resume`.
- **Wire:** send JSON-RPC `initialize` with
  `protocolVersion: 1`, then `session/new {cwd, mcpServers}` or
  `session/load {sessionId, cwd, mcpServers}`, then
  `session/prompt {sessionId, prompt:[{type:"text", text}, …]}`; the first prompt also sends
  ACP image blocks for prepared image attachments. `session/new` returns the session ID;
  `session/load` may omit it, in which case retain the requested ID. Answer
  `session/request_permission` by selecting `allow_once` or `reject_once` from the request's
  `options` and returning its `optionId`. To receive
  background/foreground state, opt into `github.com/copilot/sessionEvent` events
  `assistant.turn_start`, `assistant.idle`, and `session.idle` in
  `initialize.clientCapabilities._meta`.
- **Output:** keep `CopilotLogParser` as the output parser, not an ACP output mapper. ACP
  creates the normal `~/.copilot/session-state/<sessionId>/events.jsonl` with the native
  events the parser already consumes. Select `LOG` for ACP runs and seed the tail from
  `session/new`/`session/load` before the first prompt; `auto` and older versions retain
  `STDOUT`. Use `session/prompt`'s response as the
  completion boundary; ACP `session/update` is control/notification input, not a second
  source of output events.
- **Steering:** ACP cancels an active prompt if another `session/prompt` is sent. Keep one
  prompt request in flight and hold queued steer messages until its response arrives; then
  send each as the next `session/prompt` on the same session.
- **Permission-mode exception:** `--allow-tool`, `--deny-tool`, `--allow-all-tools`, and
  `--yolo` work under ACP. `--assisted-approval` is rejected by ACP, and ACP Autopilot is
  allow-all rather than judge-based. Keep ctrlyoke `auto` on today's non-ACP JSONL/stdin path
  with `--assisted-approval`; do not claim ACP approvals or steering in that mode. ACP's
  selected-option response cannot carry a custom denial message to the model.
- **Live cases (Copilot CLI 1.0.112):** the Copilot subset passed with 35 tests and one pending
  interrupt case (ACP has no interrupt request in this stage). Existing capability cases cover
  `--allow-tool`, `--deny-tool`, `--allow-all-tools`, and `--yolo`; the no-dashboard ask case
  rejects the request, and a dashboard-backed case approves one tool call once. The image-and-
  resume case creates a session and resumes it in a fresh process with `session/load`; MCP,
  hooks, and text/tool output remain on the native Copilot log parser, with session IDs seeded
  from ACP. The live steering case confirms a queued steer is delivered after the first
  `session/prompt` resolves. Adapter gate tests verify that `--assisted-approval` stays on the
  legacy JSONL/stdin path and is not launched with ACP.

#### 6b [Deferred]: Antigravity ACP

- **Proposed launch if unblocked:** `agy --model <model> --settings <managed-settings.json>
acp`. Put `--model` before `acp`; `agy acp --model ...` is rejected. Use the same
  run-scoped permission settings as the current adapter, plus other supported top-level
  arguments.
- **Wire:** use `initialize`, `session/new`/`session/load`, and
  `session/prompt {sessionId, prompt:[{type:"text", text}]}`. For
  `session/request_permission`, map option ID `allow` / kind `allow_once` to allow and
  option ID `deny` / kind `reject_once` to deny. The reply is
  `{outcome:{outcome:"selected", optionId}}`; ACP exposes no custom denial-message field.
- **Output:** ACP itself is not stream-json, but the ACP session writes the usual
  `transcript_full.jsonl` under the session ID. Reuse `AntigravityLogParser` and its
  transcript reader, seeded with the ACP session ID; do not add a competing ACP output
  mapper. The ACP `session/update` stream remains useful for control and turn progress.
- **Steering:** use QUEUE. A second `session/prompt` cancels the active one, so retain steer
  text in ctrlyoke until the current `session/prompt` returns, then submit it as the next
  prompt.
- **Gate if reopened:** >= 1.5.9, the first ACP version probed. Keep the existing Stage 4
  stream-json queue steering unchanged while this sub-stage is deferred.
- **Reason and unblock criteria:** live ACP runs executed a terminal command despite
  `--settings` containing `toolPermission:"request-review"` and
  `permissions.deny:["command(*)"]`; a direct `write_to_file` also completed without
  `session/request_permission`, even with `toolPermission:"request-review"`. Do not switch
  production launches to ACP or advertise approvals until either ACP is proven to enforce
  the existing per-run allow/deny rules and requests file-edit approval, or a host-side
  equivalent preserves those rules without widening access.
- **Live cases required to unblock:** the deny rule must prevent the command from executing;
  `request-review` must produce an answerable file-edit request; allow and deny must each
  produce the expected result; `session/load` must continue the same session; queued steering
  must follow the first prompt response; and the existing transcript parser must produce
  tool, diff, and completion events.

#### 6c [Done]: OpenCode 2 plugin

Live verified on OpenCode 2.3.0.

- **Gate:** OpenCode >= 2.3.0, the first version live-probed for both the V2 plugin path and
  the blocking `evaluate` hook. OpenCode 1 and earlier 2.x retain today's path.
- **Launch:** keep `opencode run --standalone --format json -m <model>` and stdin prompt
  delivery. Inject the V2 plugin directory through `OPENCODE_CONFIG_CONTENT` as
  `plugins:[<directory>]` and pass a per-process loopback control URL and random token in
  the spawn environment. `--standalone` is required so the plugin, environment, and session
  belong only to this run.
- **Approval wire/channel:** register
  `ctx.permission.hook("evaluate", async event => ...)`. The event includes `sessionID`,
  `agent`, `action`, `resources`, `source`, and the current `effect`. The plugin posts the
  request to the host's loopback endpoint and awaits its decision. The bridge replies with
  the one-request decision `once` or `reject` (never `always`); the plugin maps that to
  `event.effect: "allow"` or `"deny"` and forwards the host's denial message. It also emits
  the existing `permissionRequest` notification before resolving the hook. The same bridge
  long-polls for host-queued steer messages; it binds only to `127.0.0.1` and authenticates
  each request with the per-process token, which the plugin removes from its environment
  before any tool can inherit it.
- **Output:** leave `headlessSource = STDOUT` and `OpenCodeLogParser` unchanged. The plugin
  owns control traffic; the existing `opencode run --format json` stream remains the only
  output source.
- **Steering:** for a message returned by the bridge, the plugin calls
  `ctx.session.prompt({sessionID, text, delivery:"steer"})`; this is true OpenCode steering,
  not an ACP cancel-and-replace queue. Keep the current session ID from plugin events and
  report a clear error if the session has already ended.
- **Why not `opencode serve`:** the V2 `evaluate` hook awaited a host response for 32 s and
  then returned the denial to the model, so the plugin path works without a second
  server lifecycle, `OPENCODE_PASSWORD`, or the `/api/session/.../permission/.../reply`
  route. Reconsider `serve` only if a supported V2 version stops awaiting this hook.
- **Live cases (passed 2026-11-17 on OpenCode 2.3.0):** dashboard allow after 32 s, dashboard
  deny with a message, timeout denial, and steering during a long tool. The cases verify that
  the allowed command ran, denied/timed-out commands did not, the denial message reached the
  model, and the steer reached the active turn. The live cases also retain the streamed command
  event; `OpenCodeV2.test.ts` continues to cover text, tool, write and edit-diff parsing.
  `npm run test:harness -- --grep "opencode-cli"` finished with 34 passing, one pending
  unsupported interrupt case, and one foreground-subagent attribution failure. That same
  attribution case failed in the 2026-11-16 OpenCode report before 6c; it is unrelated to the
  control bridge. It started with OpenCode 2.3.0 (it passed on 2.2.6) and is filed as
  [`opencode-2-3-subagent-commands-missing-from-headless-output.md`](../bugs/backlog/opencode-2-3-subagent-commands-missing-from-headless-output.md).

**Final review (2026-11-17):** `npm test` passed (extension 8178, UI 4801, packaging 141), and so
did lint and `check:docs`. A full `npm run test:harness` run finished with 186 passing, 3 pending
and 6 failing. Two failures already have bug files (Qwen skill-mode commit; agy `auto` chained
command EPERM). Three model-nondeterministic cases (Claude custom allowed pattern, Qwen inline
MCP marker, Qwen parallel subagents) passed when rerun on their own. The OpenCode attribution
failure above reproduced.

Each shipped sub-stage must add its capability declaration and passing live-case evidence, so
the compatibility docs and `KNOWN_BROKEN_CLAIMS` stay honest. Current headless steering is
available for Claude Code, Codex CLI, Qwen Code, Antigravity, and OpenCode 2.3.0+. Copilot
supports steering on 1.0.112 and later except in `auto` mode; OpenCode 1 and OpenCode 2 before
2.3.0 keep the existing path, and 6b adds no capability until its permission parity gap is closed.

## Version requirements

No stage needs a global minimum-version bump. Gate each capability on the version that has it,
as `autoModeMinimumVersion` already does; older CLIs keep today's behavior. Stage 6's
conservative first-probed gates are Copilot 1.0.112, Antigravity 1.5.9 (deferred), and OpenCode
2.3.0. Dates come from the vendor repos' commit history (the local clones have no tags):

| Harness     | ctrlyoke minimum    | What the plan needs and when it landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude      | 2.1.94              | stream-json input, the control protocol and `--permission-prompt-tool stdio` are the Agent SDK's transport and predate 2.1. Whether a mid-turn message is injected or queued was only probed on 2.1.325; it changes the tooltip, not support.                                                                                                                                                                                                                                                                                                                                                                                     |
| Qwen        | 0.15.5              | Stream-json SDK mode and `can_use_tool` date from 2025-11-21 (#926), before the minimum. `initialize.timeout.canUseTool` is honored only from 2026-05-26 (#4491, about 0.16); before that the timeout is a fixed 60 s, so `ask` caps its wait there.                                                                                                                                                                                                                                                                                                                                                                              |
| Codex       | 0.129.0             | v2 approvals (2025-11-18), `turn/steer` (2026-02-06), exec on the in-process app-server (2026-03-08) and the hook-trust bypass (2026-05-13) all landed by about the minimum. `CodexQuotaCollector`'s 0.146 gate (`CODEX_APP_SERVER_MIN_VERSION`, from ~2b39311) is not a protocol limit: its comment says it is "gated to the rechecked CLI line", i.e. the version the quota methods were verified on. 0.146.0 is also the version the inline hooks and pinned harness tests were verified on. **Gate headless app-server at 0.146** and keep `exec` below it; lower the gate only with a passing live case on an older version. |
| OpenCode    | 1.3.16 (OpenCode 1) | The plugin `evaluate` hook (2026-08-25, #45003) and steer delivery (2026-08-12, #42109) are recent OpenCode 2 only. Gate headless control at 2.3.0; OpenCode 1 and OpenCode 2 before 2.3.0 keep auto-reject.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Copilot     | 1.0.19              | ACP predates 1.0, but `session/request_permission` was not checked on 1.0.19 (closed source).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Antigravity | 1.4.10              | Not dated: `--input-format stream-json` and `agy acp` were only checked on 1.5.9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Decisions

Resolved 2026-11-15, with the Claude Stage 2a and Stage 6 probes resolved on 2026-11-16. The
ones marked "probe in stage N" are verification tasks that belong to that stage, not design
questions.

- **Claude background tasks after `result` (Stage 2a, probed 2026-11-16).** The probe confirmed
  task-notification turns arrive after the first `result` while stdin is open, including without
  `initialize`. Stage 2a now holds channel closure while `ClaudeLogParser` reports pending work,
  bounded by the prompt timeout.
- **Copilot ACP flags and the judge (Stage 6, probed 2026-11-16).** `--allow-tool`,
  `--deny-tool`, `--allow-all-tools`, and `--yolo` work under ACP. `--assisted-approval` is
  rejected, and ACP Autopilot is allow-all, not judge-based. Stage 6a uses ACP except for
  ctrlyoke `auto`, which stays on the existing assisted-approval launch.
- **Copilot server-mode permission opt-in.** Dropped. The flag is hidden; Stage 6 uses ACP.
- **Antigravity ACP permission parity (Stage 6, probed 2026-11-16).** Deferred: `--settings`
  did not enforce the tested deny rule, and a direct file edit did not raise an ACP permission
  request. Keep Stage 4's stream-json path until ACP or a host-side policy preserves these
  restrictions.
- **OpenCode async `evaluate` hook (Stage 6, probed 2026-11-16 and implemented in 6c).** V2.3.0
  awaited a loopback-host decision for 32 s and returned its denial message to the model. The
  plugin hook and per-process loopback HTTP bridge are live verified; `opencode serve` is
  unnecessary unless this await behavior changes in a supported version.
- **Codex rollout parity.** Resolved in Stage 5: rollout output and session errors are read from
  Codex's log, and resuming by the app-server thread ID was live-verified. Gate at 0.146 (see
  "Version requirements").
- **Codex steer/completion race (Stage 5).** If the active turn completes before `turn/steer` is
  accepted, report that the message was not queued; do not fall back to a later `turn/start`.
- **`ask` timeout** (Nathan): deny with a message.
- **"Interrupt turn".** Yes, as a small follow-up after Stage 2. Claude/Qwen `interrupt` and
  Codex `turn/interrupt` keep the process and session, which is gentler than Stop.
- **Interrupt-turn outcome (probed and implemented 2026-11-16).** Both stream-json CLIs accept
  `{"type":"control_request","request_id":"…","request":{"subtype":"interrupt"}}`. Claude
  acknowledges with `control_response.response.subtype: "success"` and
  `control_response.response.response.still_queued: []`; Qwen acknowledges with the same outer
  success and `control_response.response.response.subtype: "interrupt"`. Both then emit a `result`
  marking the cancelled tool as an error; Claude exits 1 and Qwen exits 0 after stdin closes.
  ctrlyoke treats that result as a successful partial step (retaining the cancellation
  event/output) because the user ended the turn, not the workflow. The normal turn-end path closes
  stdin and lets the queue continue. Live harness cases interrupt the same 25-second Node sleep
  and both complete the step/workflow well before it ends (Claude 2.1.325, Qwen 0.27.4).
