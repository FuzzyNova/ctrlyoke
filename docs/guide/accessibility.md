# Screen readers and dictation

You can run a workflow without looking at the dashboard: dictate a prompt
into the prompt editor, run it, and have a screen reader tell you how the run
is going and what the AI answered. This page covers what ctrlyoke does for
screen readers and how to use your operating system's dictation with it.

## What a screen reader announces {#announcements}

While a run is going, the dashboard tells your screen reader what changes,
wherever your focus is. It doesn't depend on what the output pane is showing,
so scrolling the output never triggers an announcement and nothing is missed
because it was off screen.

**Screen reader announcements** in **Settings → General → Accessibility**
([`ui.accessibility.outputAnnouncements`](/reference/settings#ui-accessibility-outputannouncements))
chooses how much you hear:

| Value                                   | What is announced                                                                                                                                                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Step changes and finished responses** | A step starting, completing, failing or being cancelled; the workflow completing, stopping or pausing; a question the AI asks you; the harness waiting for input; and each response once it finishes. This is the default. |
| **Also read responses as they stream**  | All of the above, plus the response a paragraph at a time while it arrives, at most once every few seconds.                                                                                                                |
| **None**                                | Nothing.                                                                                                                                                                                                                   |

A finished response is read as a short summary of what the step did, such as
"Changed 3 files, ran 2 commands", followed by the AI's last message. Thinking,
tool calls and diffs are never read out. Code blocks are read as "Code block,
12 lines, omitted", tables as "Table with 4 rows", links by their text, web
addresses by their site name, and full file paths by the file name.

Announcements are polite: they wait until your screen reader finishes what it
is saying. Each dashboard you have open announces its own run, so a phone and a
desktop browser watching the same run both speak.

"Waiting for input" is announced only while
[**Waiting for input** notifications](/guide/notifications) are on, which they
are by default.

### Read the last response {#read-last-response}

Press `Alt+L` (`Option+L` on macOS) anywhere in the dashboard to hear the most
recent finished response again. It works in every announcement mode, including
**None**. The output toolbar also has a **Read last response** button, hidden
until it gets keyboard focus.

## Moving through the output {#navigating-output}

The output pane is a region named "Workflow output". Inside it:

- Every step header is a level 3 heading, named for the step, its harness and
  how it went, for example "Step 3, Fix tests, Claude Code, finished". Use your
  screen reader's heading navigation (`H` in NVDA and JAWS, the rotor in
  VoiceOver) to jump from step to step.
- Every message from the AI is an article named for its step, such as
  "Response, Step 3", so you can move between messages past the tool calls in
  between.

In a long run the output pane keeps only the steps near where you are in the
page, so to reach an early step, jump with the minimap or scroll there first.
When a step header is pinned to the top of the pane, the pinned copy is not a
second heading.

## The terminal {#terminal}

Turn on **Terminal screen reader mode** in **Settings → General →
Accessibility**
([`ui.accessibility.terminalScreenReaderMode`](/reference/settings#ui-accessibility-terminalscreenreadermode))
so your screen reader can read the Terminal tab and follow new output.
Browsers can't tell when a screen reader is running, so ctrlyoke can't turn
this on for you.

## Dictating prompts {#dictation}

The prompt editor accepts text from your operating system's dictation like any
other text field, so you don't need anything from ctrlyoke to speak a prompt:

| Platform | How to dictate                                                      |
| -------- | ------------------------------------------------------------------- |
| Windows  | Press `Win+H` for voice typing, or use Voice Access.                |
| macOS    | Press the Dictation shortcut set in **System Settings → Keyboard**. |
| iOS      | Tap the microphone on the keyboard in the browser dashboard.        |
| Android  | Tap the microphone on Gboard in the browser dashboard.              |

Then run the prompt with `Ctrl+Enter`, or queue it with `Ctrl+Shift+Enter`.

## Related

- [The dashboard](/guide/dashboard#keyboard-shortcuts)
- [The output pane](/guide/output)
- [The terminal](/guide/terminal)
- [Notifications](/guide/notifications)
- [Browser dashboard](/guide/remote-dashboard)
