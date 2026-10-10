# Voice Input & Read-Aloud Plan

**Status:** backlog, not started. Research was verified against current sources on 2026-10-05.
Facts marked _(verify)_ could not be confirmed and need to be checked in the Phase 1 spike.

> **2026-10-10 audit:** Still not started. There is no speech code, the output pane has no
> live region, and xterm `screenReaderMode` is never set. Two updates:
>
> - The standalone server now exists (`ctrlyoke server`), so "once it exists" no longer
>   applies.
> - The hosted server already has a separate, token-gated WebSocket path (`/ws/lsp`, the
>   LSP JSON-RPC proxy in `CtrlYokeHostedServer.ts`). That is the precedent for the proposed
>   speech socket, so name it `/ws/speech` to match.
>
> Note that `package.json` pins `@codemirror/view` `^6.39.12`. The 6.43.13 below is the
> installed version.

## Goal

Run the whole loop by voice:

1. Speak a prompt into the prompt editor.
2. Run or queue it.
3. Hear the response read back.

The loop must work in the **hosted browser dashboard** and the **standalone server**
(`ctrlyoke server`, [`STANDALONE_SERVER_PLAN.md`](../implemented/STANDALONE_SERVER_PLAN.md)). It should also work
in the VS Code webview as far as VS Code allows. The phone case matters most, because the hosted
dashboard is already used from phones (QR code, mobile layout, terminal control bar).

## Short answers to the framing questions

- **Can OS accessibility tools cover this?** Mostly yes for input, partly for output, and
  ctrlyoke should guarantee both no matter what. This is Phase 0. It is cheap, has no new
  dependencies, and is worth doing even if native voice never ships.
  - Input already works: Windows Voice Typing (Win+H), Voice Access, macOS Dictation, and the
    iOS/Android keyboard mic all type into a focused `contenteditable`, which is what CodeMirror
    6 is. We need to verify it, not build it.
  - Output is the weak side. The output pane is virtualized and has no live region, so a screen
    reader cannot follow a streaming response today (see "Current state").
- **Is there a good open-source STT/TTS stack we can ship in a commercial product?** Yes:
  **sherpa-onnx** (Apache-2.0) gives streaming STT, Silero VAD and TTS in one runtime. It runs as
  WASM, in Node, or as a native addon. Paired with **Kokoro-82M** for neural TTS (Apache-2.0 code
  and weights), nothing in the stack is GPL or non-commercial. Avoid Piper, Coqui/XTTS, Vosk and
  the non-English Moonshine models; the license table below says why.
- **Microphone and audio permissions?**
  - **Browser:** `getUserMedia` works only in a secure context (`https`, `localhost` or
    `127.0.0.1`). A LAN URL like `http://192.168.x.x:4747` has no `navigator.mediaDevices` at
    all. The hosted server already supports TLS (`/cert` download, `tlsConfig`), so this is a
    UX and diagnostics problem, not new infrastructure.
  - **Audio playback:** needs no permission. It only needs one user gesture to unlock the
    `AudioContext`.
  - **VS Code webview:** it **cannot use the microphone at all**. The iframe has no
    `allow="microphone"` and Electron's permission handler denies `media` for
    `vscode-webview://` origins (microsoft/vscode#323602, open in backlog).
- **Build it ourselves rather than plug into VS Code?** Yes. VS Code's speech capability (the
  `ms-vscode.vscode-speech` extension and the `speech` proposed API) is a proposed API that
  marketplace extensions cannot use (microsoft/vscode#242428, open with no response). VS Code
  also wouldn't help the hosted or standalone browser. So we build on off-the-shelf engines,
  behind our own `SpeechService`, and run them **on the ctrlyoke Node host**, not in the
  browser. "Where inference runs" below explains why.

## Current state (audited 2026-10-05)

| Area                                                         | Today                                                                                                                                                                                          | Gap                                                                                                                                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt editor (`CodeMirrorEditor.tsx`)                       | `contentAttributes` sets `aria-label="Prompt editor"`, `autocorrect`, `autocapitalize`. `@codemirror/view` 6.43.13, so **EditContext is active** in Chromium (VS Code Electron, Chrome, Edge). | No one has verified OS dictation or screen readers against EditContext. The research found no reports either way. `EditorView.EDIT_CONTEXT = false` is the documented opt-out.     |
| Output pane (`OutputPane.tsx`, `useOutputVirtualization.ts`) | `@tanstack/react-virtual` list in `#output-content`. Rows carry button labels from the accessibility pass (`dev/implemented/ACCESSIBILITY_AND_TESTABILITY_PLAN.md`).                           | No `aria-live` or `role="log"`. Off-screen rows are not in the DOM. Rows have no landmark or heading structure, so screen-reader browse mode can't jump between steps or messages. |
| Terminal tab (`TerminalInstance.tsx`, xterm 6)               | WebGL renderer.                                                                                                                                                                                | `screenReaderMode` is never set, so xterm's accessibility tree is off.                                                                                                             |
| Hosted server (`CtrlYokeHostedServer.ts`)                    | WebSocket `on("message")` always runs `JSON.parse(raw.toString())`. The CSP has `worker-src 'self'` and no `media-src` or `'wasm-unsafe-eval'`. Optional HTTPS.                                | There's no binary-frame path, the CSP needs widening for audio and WASM, and there's no secure-context guidance.                                                                   |
| Webview CSP (`CtrlYokeWebviewProvider.ts`)                   | `default-src 'none'`, nonce scripts.                                                                                                                                                           | Playback via `<audio>` would need `media-src`. Web Audio does not.                                                                                                                 |
| Speech code                                                  | None anywhere in `src/`.                                                                                                                                                                       | —                                                                                                                                                                                  |

There is already precedent for serving large assets on demand. The spell-check dictionaries are
served by the hosted server (`/dictionaries/...`) and by the webview through `data-aff-uri`, and
model files can follow the same route.

## Phase 0: Make OS tools work well (no new dependencies)

Ship this first, independent of everything below.

### 0.1 Dictation into the prompt editor

- Build a manual test matrix and record the results in this doc:

  | OS tool                     | Hosts to test                 |
  | --------------------------- | ----------------------------- |
  | Win+H Voice Typing          | VS Code webview, Chrome, Edge |
  | Windows Voice Access        | VS Code webview, Chrome, Edge |
  | macOS Dictation             | VS Code, Safari, Chrome       |
  | iOS keyboard mic            | Safari (hosted dashboard)     |
  | Android Gboard voice typing | Chrome (hosted dashboard)     |

  Run every cell twice, with `EditorView.EDIT_CONTEXT` on and off.

- If any cell fails only with EditContext on, set `EditorView.EDIT_CONTEXT = false` once at module
  load, before the first view is created, with a comment that cites the failing cell. Decide on
  evidence, not by default. The cost of turning it off is losing CM's newer IME path.
- Check that dictated text fires the existing `updateListener`, so the draft saves and autosize
  works. Check that spell-check decorations don't fight in-progress dictation composition.

### 0.2 Screen-reader output

- **One announcer, separate from the visual stream.** Add a visually hidden
  `aria-live="polite"` region, created empty at mount, owned by a small `useOutputAnnouncer`
  hook. It is fed from store events, **not** from rendered rows. This means virtualization and
  scroll position can never cause or suppress announcements.
- What it announces, chosen by a setting (see "Settings"):
  - `off`.
  - `completions` (default): step started/finished/failed, AskUserQuestion prompts, awaiting
    input, and the final `TEXT` message of each turn once it settles.
  - `streaming`: also announces paragraph-sized chunks of `TEXT`, throttled to about one
    announcement per 2–3 s.
  - In every mode, `THINKING`, tool calls and diffs are summarized ("Edited 3 files"), never read
    out in full.
- **Browse-mode structure.**
  - Each step group gets a real heading (`h3`, "Step 3 — claude-cli — completed"), so NVDA and
    JAWS can jump between steps with `H` and VoiceOver can use its rotor.
  - Each assistant message row becomes `role="article"` with an accessible name.
  - Do **not** put `role="log"`/`aria-live` on the virtualized container: row mounts during scroll
    would be announced as new content.
- **"Read last response" command.** Add a keyboard shortcut and button that pushes the latest
  completed assistant text into the announcer. This is the screen-reader equivalent of the
  read-aloud button in Phase 2, and both share the text-extraction helper (see Phase 2).
- **Terminal.** Expose xterm `screenReaderMode` behind `ui.accessibility.terminalScreenReaderMode`.
  A browser can't reliably detect a screen reader, so this is an explicit toggle.
- **Tests.**
  - Vitest: the announcer throttles correctly, ignores virtualization remounts, and respects the
    mode setting.
  - Playwright `browser_snapshot`: check that step headings and articles appear in the
    accessibility tree.

## Architecture for native voice (Phases 1–3)

### Where inference runs: on the ctrlyoke Node host, in a child process

|                          | Browser-side (WASM in a Worker)                                                               | **Node host (child process)** ← recommended                                                                                                                                                                                                          |
| ------------------------ | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phone performance        | Weak. Whisper/Moonshine-class models on a phone CPU over WASM are slow and drain the battery. | The desktop machine does the work, and the phone only captures and plays audio.                                                                                                                                                                      |
| Model download           | Per browser and per device (tens to hundreds of MB, cached separately on each).               | Once per machine, under `ctrlyokeStateHome()`.                                                                                                                                                                                                       |
| VS Code webview          | Still no mic. TTS would work.                                                                 | Same mic limit, but TTS and future extension-host capture share one engine.                                                                                                                                                                          |
| Standalone server        | Works.                                                                                        | Works. It's the same Node service, and the standalone plan reuses hosted-server code anyway.                                                                                                                                                         |
| Extension-host heap risk | None.                                                                                         | **Must be isolated.** Run the engine in a `child_process.fork`/`utilityProcess`-style worker, not in the extension host. The extension-host OOM history (see the crash notes in `copilot-instructions.md`) rules out loading ONNX models in-process. |
| CSP / bundle             | Needs `'wasm-unsafe-eval'`, model hosting, and a large webview bundle.                        | The browser bundle stays small: an AudioWorklet plus a WS client.                                                                                                                                                                                    |

Keep the engine interface host-agnostic, so a browser-side engine can be added later for
"offline phone" use without touching callers.

### Engine choices and licensing

ctrlyoke is commercially licensed (`LICENSE.md`), so nothing GPL, AGPL or non-commercial can be
bundled or auto-downloaded.

| Component        | Pick                                                                                                    | License                                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| STT runtime      | **sherpa-onnx**                                                                                         | Apache-2.0                                      | Streaming (Zipformer/Paraformer) and offline ASR, Silero VAD, and TTS in one runtime. WASM and native Node builds. Prefer the **WASM build running in Node** (npm `sherpa-onnx`) _(verify)_. It avoids per-platform native prebuilds and Electron ABI problems, unlike `node-pty`, which is in `bundledDependencies` for exactly that reason. Fall back to `sherpa-onnx-node` only if WASM latency is unacceptable. |
| STT model        | Streaming Zipformer (English) via sherpa-onnx. Optionally Whisper base/small (offline, more languages). | Apache-2.0 / MIT                                | Exact sizes and WER _(verify)_.                                                                                                                                                                                                                                                                                                                                                                                     |
| Alternative STT  | whisper.cpp (`smart-whisper`, `nodejs-whisper`)                                                         | MIT                                             | Better multilingual accuracy, but not truly streaming and needs native bindings. Keep as a second engine behind the same interface if needed.                                                                                                                                                                                                                                                                       |
| Alternative STT  | Moonshine (`@moonshine-ai/moonshine-wasm`)                                                              | MIT for code and English models                 | **Non-English Moonshine models are non-commercial.** Use English only. Package license and sizes _(verify)_.                                                                                                                                                                                                                                                                                                        |
| VAD              | Silero VAD (bundled in sherpa-onnx)                                                                     | MIT                                             | About 2 MB. Used for hands-free endpointing.                                                                                                                                                                                                                                                                                                                                                                        |
| Neural TTS       | **Kokoro-82M** via sherpa-onnx (or `kokoro-js` on Transformers.js)                                      | Apache-2.0 (code and weights)                   | Mostly English, 28+ voices, q8/q4 quantizations.                                                                                                                                                                                                                                                                                                                                                                    |
| Zero-install TTS | Web Speech `speechSynthesis` (client-side)                                                              | Platform                                        | Default provider. `getVoices()` can come back empty in Electron and on Linux Chrome, so wait for `voiceschanged` and fall back to Kokoro when the voice list is empty. Current VS Code Electron behavior _(verify)_.                                                                                                                                                                                                |
| Optional STT     | Web Speech `SpeechRecognition` (client-side)                                                            | Platform                                        | Plain browser only, never the webview (Electron has no Google API key). It sends audio to Google, Apple or Microsoft unless `processLocally` (Chrome 139+) is available. Opt-in, and disclose that it's cloud-based.                                                                                                                                                                                                |
| **Rejected**     | Piper (`OHF-Voice/piper1-gpl`)                                                                          | GPL-3.0, and voices are "personal/research use" | Not usable. This also rules out Piper-format voices in sherpa-onnx.                                                                                                                                                                                                                                                                                                                                                 |
| **Rejected**     | Coqui XTTS-v2                                                                                           | CPML (non-commercial), vendor defunct           | Not usable.                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Rejected**     | Vosk / `vosk-browser`                                                                                   | Apache-2.0                                      | Unmaintained (last publish about 4 years ago).                                                                                                                                                                                                                                                                                                                                                                      |

**Model delivery.** Do not bundle models into the VSIX. Add a "Download voice pack" action that
fetches pinned model URLs with SHA-256 checksums into `ctrlyokeStateHome()/speech/<engine>/<model>/`
and shows progress via the existing toast/progress surfaces. Hosted and standalone both resolve
the same directory. The first-run UX states the download size up front.

### Components

```
Browser / webview (React)                      Node host (extension host or standalone)
──────────────────────────                     ─────────────────────────────────────────
useVoiceInput  ─ getUserMedia → AudioWorklet   SpeechService (platform-agnostic, src/core/speech/)
  (16 kHz mono PCM16 frames)  ──/speech WS──▶     ├─ SpeechEngineHost (child process: sherpa-onnx)
  ◀── partial/final transcript (JSON)              │    ├─ SttSession (streaming, VAD)
                                                   │    └─ TtsSynthesizer (Kokoro)
useReadAloud ─ AudioContext playback           ├─ VoicePackManager (download, verify, locate models)
  ◀── PCM chunks (binary) ───────/speech WS──      └─ text extraction for TTS (shared with announcer)
  or speechSynthesis (client-only provider)
```

- **Separate `/ws/speech` WebSocket path** on the hosted and standalone server, following the
  existing `/ws/lsp` upgrade route. It is gated by the same token check as the dashboard socket and carries binary audio frames plus small JSON
  control frames. This keeps the dashboard protocol JSON-only, so the existing
  `ws.on("message")` → `JSON.parse` path and the shared router are untouched. Audio is 32 KB/s
  upstream, far below `HOSTED_WEBSOCKET_MAX_PAYLOAD_BYTES`.
- **VS Code webview transport.** There's no mic, so only TTS goes over the existing
  `postMessage` bridge, with PCM chunks as transferable `ArrayBuffer`s. Message types go in
  `DashboardConstants.ts` like every other payload.
- **Multi-client fanout.** One run can be watched from the VS Code panel, a desktop tab and a
  phone at once. **Read-aloud is per client and never fans out.** Only the client that turned it
  on speaks. The STT session belongs to the socket that opened it, and transcripts go back only
  to that socket, which inserts them into its own editor.

## Phase 1: Spike (time-boxed, about 2 days)

Measure the following, record the numbers in this doc, and only then commit to Phase 2:

1. **sherpa-onnx WASM-in-Node vs `sherpa-onnx-node`.**
   - Real-time factor for streaming Zipformer and Kokoro on a mid-range Windows laptop and an M-series Mac.
   - Memory of the child process.
   - Cold-start time.
2. **Voice pack.** Exact download sizes for the candidate STT and TTS models (q8/int8 variants),
   and English WER on a short set of ctrlyoke-style prompts. These are full of code identifiers,
   paths and harness names, which is where general models struggle.
3. **Hotwords.** Does sherpa-onnx contextual biasing / hotwords help with identifiers such as
   step names, file names, `claude-cli`?
4. **Latency.** End-to-end latency over `/ws/speech` from an iPhone on LAN (HTTPS with the
   self-signed cert) and over a tunnel.
5. **`speechSynthesis` in the webview.** Does it return voices in the VS Code webview on
   Windows, macOS and Linux? Can the webview play Web Audio without an extra gesture?

## Phase 2: Read-aloud (TTS) first

TTS goes first because it works in **every** host, including the VS Code webview, and needs no
permission.

- **Speaker button** on each completed assistant message row, and **Read last response** (shared
  with the Phase 0 command).
- **Auto-read mode** (per client): reads the final `TEXT` of each finished turn, plus
  AskUserQuestion prompts and "waiting for input". The last two are what make a hands-free loop
  usable.
- **Text extraction** (`src/utils/speechText.ts`, shared by TTS and the Phase 0 announcer):
  - Strip markdown.
  - Replace fenced code blocks with "code block, N lines, omitted".
  - Shorten absolute paths to basenames.
  - Read tables as "table with N rows".
  - Skip `THINKING` and tool payloads.
  - Feed the result through a sentence splitter, so playback starts after the first sentence
    rather than the whole message.
- **Controls.** Stop, pause, rate and voice. Stop runs automatically when the user starts typing
  or speaking (barge-in).
- **Providers.** `system` (`speechSynthesis`, the default) and `neural` (Kokoro on the host, once
  the voice pack is installed).

## Phase 3: Voice input (STT)

- **Mic button** in `EditorFooter.tsx`, next to the properties toggle. It is push-to-talk by
  default, also supports tap-to-toggle, and gets a keyboard shortcut.
  - Partial transcripts render as a CodeMirror decoration (dimmed, not yet in the doc). Final
    segments are inserted with `view.dispatch({ changes })` at the cursor. This keeps undo
    history, draft autosave and `onChange` on their normal path.
- **Availability rules** (single-sourced in one `getVoiceInputAvailability()` helper that returns
  a reason code):
  - **VS Code webview:** hide the mic, or show it disabled. Its tooltip offers "Open in browser"
    (the hosted server) and names the OS dictation shortcut (Win+H / double-Fn).
  - **Insecure origin** (`!window.isSecureContext`): show the mic disabled, with a link to enable
    HTTPS in Server settings, or a hint to use `localhost` or a tunnel.
  - **No voice pack:** the first click starts the download prompt.
- **Hands-free mode** (opt-in):
  - Silero VAD endpointing.
  - After auto-read finishes on a turn that is awaiting input, the mic re-arms automatically.
  - "Send" is never automatic in v1. The user presses Run (or Ctrl/Cmd+Enter), or says an
    explicit phrase if voice commands are added later (deferred).
- **Optional `browser` STT provider** (Web Speech `SpeechRecognition`), for users who don't want
  the voice pack. Opt-in only, with an explicit "audio is sent to your browser vendor" note
  unless `processLocally` is available.

## Deferred

- **Mic capture in VS Code without the browser.** Have the extension host record audio by
  spawning a system recorder (ffmpeg, sox, or a native audio addon) and feed it to the same
  `SpeechService`. This is useful, but it means native dependencies or binaries found on PATH.
  Revisit if microsoft/vscode#323602 stays open or users ask for it.
- **Voice commands** ("run", "queue", "stop", "next step").
- **Browser-side engine** for fully offline phone use.
- **Languages other than English.** The engine choice supports them, but the model licenses must
  be checked per language. Moonshine non-English models are already excluded.

## Settings

A new `voice` root in `schemas/settings-schema.json` + `CtrlYokeSettings.ts`, with defaults only.
Run `npm run schema:update` after the change.

- `voice.input.provider`: `"local" | "browser" | "off"`
- `voice.input.mode`: `"pushToTalk" | "toggle" | "handsFree"`
- `voice.readAloud.provider`: `"system" | "neural"`
- `voice.readAloud.voice`, `voice.readAloud.rate`
- `voice.models.stt`, `voice.models.tts`
- `ui.accessibility.outputAnnouncements`: `"off" | "completions" | "streaming"`
- `ui.accessibility.terminalScreenReaderMode`: boolean

Per-client state is persisted client-side, like other per-device UI state, and is **not** stored
in `.ctrlyoke/settings.json`. That covers whether auto-read is on, the selected mic and output
device, and mid-session mute. A phone and a desktop must be able to differ.

## Security & privacy

- Audio and transcripts are never written to disk, run history or `events.jsonl`. Only the final
  inserted text exists, as part of the prompt the user chose to send.
- `/ws/speech` uses the same token gate as the dashboard socket. Add an Origin check to it from the
  start. The standalone plan already lists that as defense in depth for the main socket.
- Voice-pack downloads come only from pinned URLs and are checksum-verified. No arbitrary model
  URLs come from settings.
- The `local` providers send nothing off the machine. The `browser` STT provider is the only
  path that may send audio to a third party, so update `PRIVACY.md` if it ships.
- Telemetry may count feature usage. It must never include audio or transcript text.

## Files likely touched

- `src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`: EditContext decision, transcript
  insertion, partial-transcript decoration.
- `src/ui/webview-react/components/editor/EditorFooter.tsx`: mic button.
- `src/ui/webview-react/components/layout/output-section/OutputPane.tsx`, `components/output/OutputRow.tsx`:
  headings, articles, speaker button.
- New hooks: `useOutputAnnouncer`, `useVoiceInput`, `useReadAloud`. Add a `public/` AudioWorklet module.
- `src/server/CtrlYokeHostedServer.ts`:
  - `/ws/speech` upgrade route (alongside `/ws/lsp`).
  - CSP: add `media-src 'self' blob:` if `<audio>` is used. `'wasm-unsafe-eval'` is needed only
    if a browser-side engine is ever added.
- `src/ui/CtrlYokeWebviewProvider.ts`: webview CSP for audio playback, and the TTS message bridge.
- New `src/core/speech/`:
  - `SpeechService`
  - `SpeechEngineHost` (child process)
  - `VoicePackManager`
  - engine interfaces
- `src/utils/speechText.ts`.
- `src/types/DashboardConstants.ts`: message types and provider/mode constants.
- `schemas/settings-schema.json`, `src/types/CtrlYokeSettings.ts`, and a new Voice settings
  section under `components/settings/`.
- Tests in `src/test/**` (SpeechService with a fake engine, VoicePackManager checksum handling)
  and `src/ui/webview-react/test/**` (announcer, availability helper, transcript insertion).

## Open questions

1. Should the neural voice pack be a Pro feature, or free? The OS and `system` paths are always free.
2. Should the mic button be hidden in the webview, or shown disabled with the "Open in browser"
   hint? A disabled button that explains itself is likely better for discoverability.
3. Is English-only acceptable for v1 of the `local` provider?
