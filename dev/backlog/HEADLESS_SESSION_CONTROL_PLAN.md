# Headless Session Control: Steering and Approvals

**Status:** Stage 1 is implemented: the shared transport and Qwen's headless control channel
are covered by unit tests, and the live Qwen approval case that used to hang now passes. Two SDK
mode side effects (subagent output and subagent discovery, under "Qwen Code" findings) are
being fixed as a Stage 1 follow-up.
Researched 2026-11-15 by live probes and source reading (details under "Findings"). Open
questions resolved 2026-11-15 (see "Decisions").
Deviation from the sketch: the optional provider hook currently receives only prepared prompt
text; `HeadlessControlSpawnShape.args` appends protocol args, and the coordinator ends stdin
before calling `channel.close()` so channel cleanup does not need to own transport EOF.
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

| Harness (version)     | Channel                                                                           | Message while running                                  | Approval requests                                                                                | How verified    |
| --------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | --------------- |
| Claude Code 2.1.325   | `-p --input-format stream-json` + `--permission-prompt-tool stdio` + `initialize` | **steer** (mid-tool, same turn)                        | `control_request` `can_use_tool`; reply allow (+`updatedInput`) / deny (+`message`)              | probed          |
| Qwen Code 0.27.1      | stream-json **SDK mode**: `initialize` first, no positional prompt                | **queue** (next turn)                                  | `can_use_tool` (same shape as Claude); 60 s default timeout, up to 600 s                         | probed + source |
| Codex 0.167.0         | `codex app-server` JSON-RPC v2                                                    | **steer** (`turn/steer`)                               | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/…` | source only     |
| OpenCode 2.2.6        | plugin `permission.hook("evaluate")` + `ctx.session.prompt`, or `opencode serve`  | **steer** (`delivery: "steer"`, default) or queue      | `permission.asked`; reply `once`/`always`/`reject` (+`message`)                                  | source only     |
| Copilot CLI 1.0.112   | `--acp`                                                                           | **cancel-and-replace** (probed)                        | `session/request_permission` (`allow_once`/`allow_always`/`reject_once`)                         | probed          |
|                       | hidden `--server --stdio` (copilot-sdk protocol)                                  | **steer** (`session.send` `mode: "immediate"`, probed) | `permission.request` exists, but routing it to the client was not achieved                       | probed          |
| Antigravity agy 1.5.9 | `--input-format stream-json` (`{"event":"user",…}`)                               | **queue** (probed)                                     | **none** (no control vocabulary in the binary)                                                   | probed          |
|                       | `agy acp`                                                                         | **cancel-and-replace** (probed)                        | `session/request_permission` (`allow`/`deny`)                                                    | probed          |

So **approvals are answerable on every harness** (agy and Copilot only over ACP), and **every
harness accepts more input on a live session**. True mid-turn steering exists on Claude, Codex,
OpenCode and Copilot (server mode). Qwen and agy queue the message as the next turn. ACP's
cancel-and-replace is not a steer; ctrlyoke can turn it into a queue by holding the message
until the current `session/prompt` returns.

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
- **SDK mode side effects found in the Stage 1 review (2026-11-15, Qwen 0.27.4):**
  - Subagent turns are not streamed to stdout. In direct mode a subagent's assistant and
    tool messages arrive as stdout records with `parent_tool_use_id` set; in SDK mode only the
    subagent's first `user` record does (probed with the same prompt in both modes). ctrlyoke's
    headless Qwen output relied on those records, so the live case
    "qwen-cli: attributes parallel foreground subagent commands" fails after Stage 1.
  - `SubagentManager.listSubagents` loads only `session`-level subagents in SDK mode
    (`core\src\subagents\subagent-manager.ts:583`), so user and project subagents may be
    unavailable to headless Qwen steps unless they are passed in `initialize`.
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
  - It needs a ctrlyoke→plugin channel. Whether an async hook may block on a human decision is
    inferred, not verified.
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
- Whether `--assisted-approval` and `--allow-tool` apply under `--acp` is untested.

### Antigravity (agy)

- `--input-format stream-json` expects `{"event":"user","message":{"role":"user","content":"…"}}`
  per line. A line without `event` fails the run ("stream input message is missing the "event"
  field"), and `"type":"user"` is not accepted.
- Messages queue as next turns (probed). The binary has no control vocabulary ("stream input
  message event %q is not supported yet"), so **approvals cannot go over stream-json**.
- **`agy acp`, probed:**
  - `session/request_permission` with `allow`/`deny` options; both worked.
  - Modes: `default`, `accept-edits`, `auto`, `plan`.
  - A second prompt ended the first (`end_turn`) and ran the new one, so it is
    cancel-and-replace.

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

1. **[Done] Control channel + Qwen, `deny` policy.** Writable-stdin spawn, the channel interface,
   turn-end completion, and the Qwen implementation. Qwen drops the positional prompt and sends
   `initialize` first. Every approval request gets ctrlyoke's deny message. This fixes the Qwen
   hang. The bug is in `dev/bugs/implemented/` with the corrected root cause.
   The harness case for the Qwen "unlisted command chained to an allowed one" scenario already
   exists ("an allowed command does not allow an unlisted one chained to it" in
   `src/test/harness/inline-config.harness.test.ts`); it timed out before Stage 1, and its comments
   no longer cite the bug as open. `npm run test:harness` remains unrun; live confirmation is left
   to Nathan.
   - **Qwen's `headlessSource` is `LOG`.** Its stdout chunks go to `HeadlessLogTail.onStdoutChunk`,
     not to `parseStdout`. The channel must see every complete stdout JSONL record whatever the
     source mode, so split stdout into records for the channel independently of the output path.
   - **Claude is not in Stage 1.** Under `deny`, Claude keeps `dontAsk`, which already refuses
     in-band, so the channel gives Claude nothing until steering. Moving it now would also risk
     losing `@path` expansion (see the inline plan's Claude probe) for no gain.
   - Stdin must stay open until the turn's `result`, because approval answers go on stdin. Stdin
     EOF cancels a pending request, so `close()` at turn end (or on Stop) can never hang.
2. **Claude channel + headless steer dispatch** for Claude (inject) and Qwen (queue). Move
   Claude onto the channel here, after the `@path`-in-stream-json probe; if `@path` does not
   expand, ship Claude's inlining from the inline plan in the same commit. Covers the target
   registry, webview message, `useActiveSteerTarget`, tooltips and the synthesized receipt.
3. **`ask` policy.** Settings field, approval card in the output pane, timeout, and the
   CLI-without-dashboard fallback. An MCP tool to list and answer pending approvals is a
   follow-up.
4. **agy steering** over stream-json (queue). This is cheap: the same shape as Qwen with a
   different message envelope. agy approvals stay `deny` until stage 6.
5. **Codex over app-server.** This replaces the `exec` spawn for headless Codex, reusing
   `CodexAppServerClient`. Since 2026-03-08 (#14005), `exec` has been a thin client of an
   in-process app-server, so ctrlyoke would do what exec does, out of process:
   - Spawn `codex app-server` with the same process-level `-c` args ctrlyoke builds today
     (hooks, `hooks.state`, sandbox, approval policy). Then `initialize` with
     `experimentalApi: true`.
   - Send `thread/start` (or `thread/resume` to continue a session) with exec's own
     `historyMode: "paginated"` and `bypass_hook_trust` config, then `turn/start` with the prompt.
   - Answer approval requests, send steers as `turn/steer`, and close at `turn/completed`.
   - Output is unchanged. Codex headless reads the rollout log (`headlessSource = LOG`), not
     stdout, so `CodexLogParser` keeps working if the rollout matches exec's. Verify that with a
     live case, including the `SessionSource` tag (`VSCode` vs `Exec`).
   - Keep the `exec` path for versions below the app-server gate; it is today's code.
6. **Copilot, agy, OpenCode approvals.**
   - Copilot and agy over ACP: needs an ACP `session/update` event mapper per harness. To avoid
     ACP's cancel-and-replace, deliver steers as queue (hold the message until `session/prompt`
     returns).
   - OpenCode through the plugin's `evaluate` hook and `ctx.session.prompt({delivery: "steer"})`.
     Needs a ctrlyoke→plugin channel.
   - Re-evaluate Copilot `--server` mode only if it becomes documented.

Each stage adds its capability to the harness capability declarations, with live-case evidence,
so the compatibility docs and `KNOWN_BROKEN_CLAIMS` stay honest.

## Version requirements

No stage needs a minimum-version bump. Gate each capability on the version that has it, as
`autoModeMinimumVersion` already does; older CLIs keep today's behavior. Dates come from the
vendor repos' commit history (the local clones have no tags):

| Harness     | ctrlyoke minimum    | What the plan needs and when it landed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude      | 2.1.94              | stream-json input, the control protocol and `--permission-prompt-tool stdio` are the Agent SDK's transport and predate 2.1. Whether a mid-turn message is injected or queued was only probed on 2.1.325; it changes the tooltip, not support.                                                                                                                                                                                                                                                                                                                                                                                     |
| Qwen        | 0.15.5              | Stream-json SDK mode and `can_use_tool` date from 2025-11-21 (#926), before the minimum. `initialize.timeout.canUseTool` is honored only from 2026-05-26 (#4491, about 0.16); before that the timeout is a fixed 60 s, so `ask` caps its wait there.                                                                                                                                                                                                                                                                                                                                                                              |
| Codex       | 0.129.0             | v2 approvals (2025-11-18), `turn/steer` (2026-02-06), exec on the in-process app-server (2026-03-08) and the hook-trust bypass (2026-05-13) all landed by about the minimum. `CodexQuotaCollector`'s 0.146 gate (`CODEX_APP_SERVER_MIN_VERSION`, from ~2b39311) is not a protocol limit: its comment says it is "gated to the rechecked CLI line", i.e. the version the quota methods were verified on. 0.146.0 is also the version the inline hooks and pinned harness tests were verified on. **Gate headless app-server at 0.146** and keep `exec` below it; lower the gate only with a passing live case on an older version. |
| OpenCode    | 1.3.16 (OpenCode 1) | The plugin `evaluate` hook (2026-08-25, #45003) and steer delivery (2026-08-12, #42109) are recent OpenCode 2 only. OpenCode 1 and early 2.x keep auto-reject.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Copilot     | 1.0.19              | ACP predates 1.0, but `session/request_permission` was not checked on 1.0.19 (closed source).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Antigravity | 1.4.10              | Not dated: `--input-format stream-json` and `agy acp` were only checked on 1.5.9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

## Decisions

Resolved 2026-11-15. None blocks Stage 1. The ones marked "probe in stage N" are verification
tasks that belong to that stage, not design questions.

- **Claude background tasks after `result`.** v1 closes stdin at the first `result` with no
  queued steer, which is today's behavior, so nothing regresses. Follow-up in Stage 2 (probe):
  if Claude emits a task-notification turn while stdin stays open, hold `close()` while
  `ClaudeLogParser`'s `BackgroundFollowUpState` reports pending tasks, bounded by the prompt
  timeout. That would fix headless background work being lost.
- **Copilot ACP flags and the judge.** Probe in Stage 6. Not needed earlier.
- **Copilot server-mode permission opt-in.** Dropped. The flag is hidden; Stage 6 uses ACP.
- **OpenCode async `evaluate` hook.** Probe in Stage 6. Try the `opencode serve` route first if
  the hook cannot block on a human: it has documented reply and steer endpoints and needs no
  ctrlyoke→plugin channel.
- **Codex rollout parity.** A live case in Stage 5 (already listed there). Gate at 0.146 (see
  "Version requirements").
- **`ask` timeout** (Nathan): deny with a message.
- **"Interrupt turn".** Yes, as a small follow-up after Stage 2. Claude/Qwen `interrupt` and
  Codex `turn/interrupt` keep the process and session, which is gentler than Stop.
