# Phone session: shooting script

One sitting with the iPhone 13 covers every phone shot still open in
`dev/backlog/SCREENSHOTS_AND_MEDIA_PLAN.md`: #7's prompt editor, #10's iPhone stills and
edit-and-commit clip, D14's terminal control bar and its layout editor, and a retake of the
landing page's "Code from your phone" clip. It takes four screen recordings plus one desktop
recording. After that, `npm run media -- phone` turns each raw recording into framed stills,
WebPs and video, with no Resolve step.

| #   | Recording                    | Spec (`media/phone/`)        | Becomes                                                                                    |
| --- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| 1   | Take control (+ desktop)     | `take-control.json`          | Landing video `take-control-*` (desktop beside phone); D14 stills of the bar and its popup |
| 2   | Control bar layout editor    | `terminal-bar-settings.json` | D14 still and overview WebP for `docs/guide/terminal.md`                                   |
| 3   | Prompt editor with keyboard  | `prompt-editor.json`         | #7 still and overview WebP                                                                 |
| 4   | Workspace viewer tour + edit | `workspace-viewer.json`      | #10's six iPhone stills and the edit-and-commit WebP                                       |

Record them in this order: recording 1's workflow run leaves the uncommitted changes that
recording 4 reviews and commits.

**Rules for every recording.** iOS screen recordings don't show touches. Viewers only see
what a tap changes, so after each tap hold still for about a second, and hold **2 s** on every
frame marked 📸 (each one becomes a still). Start each recording on the Home Screen and hold
2 s there before the first tap, and hold 2 s at the end before stopping. Portrait only. A
fluffed beat costs nothing: carry on and redo it, because the cut points come from the
recording, not from your timing.

## 1. Before the session (PC)

1. **Phone mockup.** The pipeline frames every recording in the iPhone 13 mockup at
   `media/.work/phone/frame.png`. It is already there in the `small-feature` worktree. In
   another checkout:
   `Copy-Item "C:\dev\media\Apple iPhone 13 Mockup PNG - 2500x2500.png" media\.work\phone\frame.png`.
   The mockup isn't committed (third-party art); `--frame <png>` points at another one.
2. **A throwaway demo-app clone.** Recording 4 makes a real commit, so don't use
   `C:\dev\demo-app`. A clone without tags keeps the capture tags (`hero-start` and the others)
   out of the phone's commit graph, and naming its folder `demo-app` keeps the workspace name
   clean:

   ```powershell
   git clone --no-tags --single-branch C:\dev\demo-app C:\dev\phone\demo-app
   cd C:\dev\phone\demo-app
   git switch -c tags-endpoint
   npm ci
   Copy-Item C:\dev\ctrlyoke.worktrees\small-feature\media\fixtures\workflows\phone-take-control.ctrlyoke.yaml .ctrlyoke\workflows\
   Add-Content .git\info\exclude "/.ctrlyoke/workflows/phone-take-control.ctrlyoke.yaml"
   git status   # must be clean
   ```

   Its committed `.ctrlyoke/settings.json` already serves HTTPS on all interfaces, port 4749.

3. **ctrlyoke build.** The point of the retake is the current UI. Run a build from current
   `main`, either a VSIX from `npm run package` installed into your normal VS Code, or a dev host
   opened on `C:\dev\phone\demo-app`. Use your normal VS Code profile, not a `media` capture
   host: the phone needs your Pro license (LAN and HTTPS) and the server certificate your iPhone
   already trusts.
4. **VS Code look** (recording 1 films the desktop too): Windows display scaling 150%, theme
   **Dark 2026**, only `demo-app` open, no other editor tabs, Windows notifications off (Do not
   disturb), and the account avatar showing nothing personal. Give the ctrlyoke dashboard a wide
   area: move it to the secondary side bar and drag it to about half the window, so its
   Terminal tab reads well when cropped.
5. **Desktop recorder.** OBS (or ShareX's screen recording) on the whole 2560×1440 screen at
   30 or 60 fps, H.264 MP4, no audio. Do one 5-second test file and check it plays.
6. **Check the phone can reach the PC** before you start filming: on the iPhone, open
   `https://<PC LAN IP>:4749` in Safari. The page should load with no certificate warning. If
   the warning appears, the PC's IP has changed since the certificate was made: regenerate it in
   Settings → Server, then trust it again as in `docs/pro/mobile-setup.md`.
7. **Reset the control bar**: Settings → Terminal → Mobile Control Bar → **Reset to default**,
   so recordings 1 and 2 start from the built-in layout.
8. **Haiku credit.** Recording 1 runs one real Claude Code turn on Haiku (a few cents). It's
   the only paid step in the session.

## 2. Before the session (iPhone 13)

- **Focus → Do Not Disturb** on, and notification previews off, so no banner drops in.
- **Settings → Display & Brightness**: **Dark** appearance (the browser dashboard picks its
  theme from it when it loads), **Display Zoom → Default**, Auto-Lock **Never** (recording 1
  waits on the PC).
- **Text size** at the default; Bold Text off.
- Battery charged or on the charger, so the status bar doesn't show a low-battery icon. Wi-Fi
  on the same network as the PC.
- **Control Center**: add **Screen Recording** if it isn't there. The red recording pill in the
  status bar can't be hidden. That's fine: it sits beside the mockup's notch, as on a real
  phone.
- In Safari, close every open tab, and clear any open ctrlyoke tab, so the dashboard opens
  fresh from the QR code.
- Keep the keyboard as it is (predictive text on): recording 3 shows a real keyboard.

## 3. Recording 1: take control from the phone

**What it shows:** Claude Code is running on the PC and waiting at its own approval prompt. You
scan the QR code, open the dashboard on the phone, take control of the terminal, and approve
the edit with the control bar. Landing copy: "Scan the QR code, open the dashboard in your
phone's browser, and take control of a workflow that's running on your PC, even mid-step."
Final clip: 25-35 s.

**Set up (not filmed):**

1. In VS Code, load **phone-take-control** and click **Run**. Claude Code starts in the
   dashboard's Terminal tab, reads the files, then stops at an approval prompt such as **Do you
   want to make this edit to notesStore.ts?** with `1. Yes` highlighted. It waits there as long
   as you need. Its permissions allow only reads and `npm test`, so it has to ask.
2. Open **Settings → Server** in the ctrlyoke dashboard, so the QR code is on screen.
3. **Start the desktop recording.**

**Beats (phone recording):**

| Beat | Phone                                                                                                                                                                                | Desktop (other hand)                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 1    | Start the screen recording from Control Center. Home Screen, hold 2 s. ✂️ **clip in** around here.                                                                                   | QR code showing.                                           |
| 2    | Open **Camera**, point it at the QR code on the monitor, and tap the yellow link that appears.                                                                                       |                                                            |
| 3    | Safari opens the dashboard. If it shows another workflow, pick **phone-take-control** from the workflow list.                                                                        | Close Settings, so the Terminal tab with the prompt shows. |
| 4    | Tap the **Terminal** tab (the `>_` icon beside the output icon). Claude's approval prompt shows with **View Only** and **Take Control** under it. Hold 2 s.                          |                                                            |
| 5    | Tap **Take Control**. ⏱️ **Sync point**: note it. The desktop terminal switches to **View Only** at that moment, which lines the two recordings up.                                  | Badge flips to View Only.                                  |
| 6    | The control bar appears under the terminal (**Esc**, **Tab**, arrows, **Enter**, **...**). 📸 `phone-terminal-control-bar`.                                                          |                                                            |
| 7    | Tap **↓** once: the highlight moves to `2. Yes, allow all edits during this session`. Hold 1 s. Tap **↵** (Enter).                                                                   | Edits start streaming in both.                             |
| 8    | Let Claude write for 4-5 s. ✂️ **clip out** after this beat.                                                                                                                         |                                                            |
| 9    | Tap **...** (More shortcuts): the popup with `Shift+Tab`, `Ctrl+C`, `Ctrl+Z`, `Ctrl+L`, `Ctrl+R`, `Ctrl+A` opens. 📸 `phone-terminal-more-shortcuts`. Tap **...** again to close it. |                                                            |
| 10   | If Claude asks again (to run `npx` or similar), tap **↵** to accept `1. Yes`. Hold 2 s, then stop the screen recording.                                                              | Stop the desktop recording.                                |

**After:** leave the run going until the step completes and its end condition (`npm test`)
passes. Then check in a terminal: `git -C C:\dev\phone\demo-app status` should list
`README.md`, `src/server.ts`, `src/store/notesStore.ts` and `tests/notes.test.ts` (Claude may
also touch `src/routes/`). If the run failed, reset (section 7) and do the take again.

## 4. Recording 2: the control bar's layout editor

**What it shows:** D14's other half, the layout editor under **Settings → Terminal → Mobile
Control Bar**. Final overview: 8-12 s.

| Beat | Phone                                                                                                                                                                                                                                    |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Start recording on the Home Screen, 2 s. Switch to Safari, which still shows the dashboard from recording 1.                                                                                                                             |
| 2    | Tap the **Settings** gear in the header, then the **Terminal** tab. Scroll down until **Mobile Control Bar** with its bar and shortcut lists fills the screen. 📸 `phone-terminal-bar-layout`. ✂️ **clip in** just before the next beat. |
| 3    | Touch and hold **Ctrl+C** in the shortcut list, drag it into the bar after **Enter**, and let go. Hold 2 s.                                                                                                                              |
| 4    | Optional: close Settings and show the terminal with **Ctrl+C** now in the bar, 2 s. ✂️ **clip out**. Stop recording.                                                                                                                     |

**After:** Settings → Terminal → Mobile Control Bar → **Reset to default**.

## 5. Recording 3: prompt editor with the keyboard open

**What it shows:** #7, typing a prompt on a phone: the on-screen keyboard up, completions
listed above it, picks turning into chips. Final overview: 12-18 s. Type at a relaxed pace.

| Beat | Phone                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Start recording on the Home Screen, 2 s. Switch to Safari (dashboard, **phone-take-control** loaded).                                                   |
| 2    | Open the prompt editor (tap **EDITOR** at the bottom if it is collapsed) and tap inside it. The keyboard opens. ✂️ **clip in** here.                    |
| 3    | Type `List the notes for one tag with GET /tags/:tag. Reuse ` (ending in a space).                                                                      |
| 4    | Type `@notesS`. The file list opens above the keyboard with `src/store/notesStore.ts`. 📸 `phone-prompt-editor-completions`. Tap it: it becomes a chip. |
| 5    | Type `and follow` then `$prev`. Tap `$previous` in the list. Type `.`                                                                                   |
| 6    | Hold 2 s with the keyboard still open. ✂️ **clip out**. Stop recording. Don't send the prompt.                                                          |

**After:** long-press in the editor → **Select All**, then Backspace, so the prompt doesn't
stay in the editor.

## 6. Recording 4: workspace viewer, then edit and commit

**What it shows:** #10, the workspace viewer as a real IDE on the phone. Part A is a still tour.
Part B is the edit-and-commit clip: review the agent's work, fix one word, commit. Final
overview: 15-25 s (part B only).

**Part A: stills tour (not in the clip)**

| Beat | Phone                                                                                                                                          |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | Start recording on the Home Screen, 2 s. Switch to Safari.                                                                                     |
| 2    | Tap **Explore files and changes** (the files icon in the header). **Explorer** tab: expand `src`, then `store`. 📸 `phone-workspace-explorer`. |
| 3    | Tap `notesStore.ts` and scroll to the tag-count function Claude added. 📸 `phone-workspace-file`. Tap **Back to file list**.                   |
| 4    | **Search** tab: type `tags`, then tap away so the keyboard closes and the results fill the screen. 📸 `phone-workspace-search`.                |

**Part B: edit and commit (the clip)**

| Beat | Phone                                                                                                                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5    | **Explorer** tab. ✂️ **clip in**. Open `README.md` and scroll to the `/tags` row Claude added to the endpoint table.                                                                                              |
| 6    | Change one word of its description so the diff is small and readable (for example "Tag counts, most used first"). Tap **Save file** (the disk icon), hold 1 s.                                                    |
| 7    | **Source Control** tab: README plus Claude's files listed as changes. 📸 `phone-workspace-source-control`.                                                                                                        |
| 8    | Tap `README.md`: its diff opens full screen with your one-word change. 📸 `phone-workspace-diff`. Tap **Back**.                                                                                                   |
| 9    | Tap **Stage All** (or **+** on each file). Tap the **Commit message** box and type `feat: add GET /tags endpoint`. Tap **Commit**.                                                                                |
| 10   | The new commit appears at the top of the history graph. 📸 `phone-workspace-commit-graph`. ✂️ **clip out**. Stop recording. Don't push: there is no remote worth showing, and the commit already makes the point. |

## 7. Retakes and cleanup

- **Reset between takes** (only in the throwaway clone):
  `git -C C:\dev\phone\demo-app reset --hard origin/main; git -C C:\dev\phone\demo-app clean -fd`.
  This also undoes recording 4's commit. Recording 4 needs recording 1's changes, so after a
  reset rerun the workflow on the PC (no need to film it again).
- **When you're done:**
  - Settings → Server → **Regenerate** the access token. It's visible in the desktop recording
    and inside the QR code.
  - Settings → Terminal → Mobile Control Bar → **Reset to default**.
  - Turn Auto-Lock and Do Not Disturb back to how you like them.
  - The clone can stay for retakes or be deleted.

## 8. From recordings to assets

AirDrop the four recordings to the PC (they arrive as `.MOV` or `.MP4`) and keep them, with the
desktop recording, outside the repo, e.g. `C:\dev\media\phone-2026-10\`. Then, from the repo
root:

1. **Contact sheets**, one image per recording, one frame a second (`--sheet-fps 4` for
   finer picking):

   ```powershell
   npm run media -- phone take-control C:\dev\media\phone-2026-10\rec1.MOV --sheet
   npm run media -- phone take-control C:\dev\media\phone-2026-10\desktop.mp4 --sheet
   ```

   The sheet lands in `media/.work/phone/<recording name>/` and its tile n is at n seconds
   (n / fps).

2. **Fill in the times** in each `media/phone/<shot>.json`: `clip.from`/`clip.to` at the ✂️
   marks, each still's `at` on its 📸 hold, and for `take-control` the ⏱️ sync point in both
   recordings (`video.sync.phone`, `video.sync.desktop`). Set `video.desktopCrop` to the
   ctrlyoke panel's box in desktop pixels (`{ "x", "y", "width", "height" }`), so the desktop
   side shows the dashboard large rather than the whole screen. An agent can do this step: give
   it the recording paths and this file, and it can read the contact sheets.
3. **Render** (preview with `--out ..\preview` first; `--only <file>` redoes one output):

   ```powershell
   npm run media -- phone take-control rec1.MOV --desktop desktop.mp4
   npm run media -- phone terminal-bar-settings rec2.MOV
   npm run media -- phone prompt-editor rec3.MOV
   npm run media -- phone workspace-viewer rec4.MOV
   ```

   Stills come out 750×1520 (the mockup's device crop at 750 wide), overviews 390×790 animated
   WebP with alpha, and the take-control video as AV1 2560×1440, H.264 1280×720 and a WebP
   poster, colour-checked like the other videos.

4. **Review before committing:** device name, notifications, account rows and anything personal
   in every frame. The LAN IP is fine, and so is a token that has since been regenerated.
5. **Slot them:** the take-control video replaces `ctrlyoke-take-control-1080p.mp4` in
   `landing/src/pages/index.astro` as a `DemoVideo` (1280×720); the D14 stills and overview go
   in place of the `<!-- SHOT D14 -->` marker in `docs/guide/terminal.md`; #10's stills go in
   `docs/guide/workspace-viewer.md#on-a-phone` and `docs/pro/mobile-setup.md`. Show stills at
   `width="375"` like the iOS setup stills.
