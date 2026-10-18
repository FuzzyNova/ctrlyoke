# iOS 26 Liquid Glass: PWA top-edge blur, edge tint and clipped selection callout

- **Found:** 2026-10-18 by user (hosted dashboard installed as a PWA on iPhone, right after updating to iOS 26 and choosing the Liquid Glass setting)
- **Area:** `src/ui/webview-react/components/workspace-viewer/WorkspaceViewerModal.tsx`, `src/ui/webview-react/styles/globals.css`, hosted PWA meta tags in `src/server/CtrlYokeHostedServer.ts`
- **Resolution:** fixed in 5d7dd002f (fixed mobile root on iOS; all three symptoms confirmed gone on device)

## Symptom

Three iOS-only glitches in the standalone PWA that started with the iOS 26 Liquid Glass update. They all happen at the top edge of the screen, so they probably share a cause:

1. **Header blur after closing a full-screen view.** The top header row (new-workflow `+`, workflow dropdown, refresh) shows a heavy blur, while the toolbar row directly below it stays sharp. The blur starts just below the status bar and ends at the gap between the two rows. Closing any full-screen view reproduces it every time. That includes the workspace viewer, which slides out, and `UndoChangesDialog` (a `Modal` with `size="full"`), which has no animation. The blur goes away after switching workflows, or as soon as a text field gets focus (for example, the name field opened by "New workflow"). It does not come back on its own.
2. **Blue tint at the screen edges on long-press.** Long-pressing the bottom safe area (below the editor footer) brings up the iOS Copy / Look Up / Translate callout. A translucent blue tint then covers the status bar and the header at the top, and the safe-area strip at the bottom. The header cannot be selected (`cy-no-select`, `Header.tsx:641`), and no web content is drawn under the status bar (there is no `apple-mobile-web-app-status-bar-style` tag), so the tint is not an ordinary selection highlight on page elements.
3. **Selection callout drawn under the status bar.** In the workspace viewer's file editor, selecting text on line 1, which sits just below the viewer's header, puts the Cut / Copy / Paste / AutoFill callout at the very top of the screen. It overlaps the clock, the Dynamic Island and the status icons, so the buttons are hard to reach. Before iOS 26, a callout with no room above the selection would flip below it.

Nothing appears in the ctrlyoke session log: these happen in the iOS compositor, outside the page.

## Steps to Reproduce

1. On an iPhone running iOS 26, add the hosted dashboard to the home screen and open it from there.
2. Open the workspace viewer, then close it. The top header row is now blurred (symptom 1).
3. Long-press the strip below the editor footer. The top and bottom edges turn blue (symptom 2).
4. Open any file in the workspace viewer and select text on line 1. The callout lands under the status bar (symptom 3).

## Root Cause

Not confirmed. The working theory: iOS 26 draws its own Liquid Glass edge layers in the top and bottom insets of a standalone web app. These layers blur or tint according to what is underneath them, and Safari 26 checks `position: fixed` elements that touch the top edge to decide what the top layer shows.

- Symptom 1 is triggered by a full-screen `position: fixed` element that covers the top edge going away. The slide animation is not required: `UndoChangesDialog` reproduces it without one. After that, nothing fixed touches the top edge any more, because the app root is an ordinary block. The theory is that this leaves the top layer stuck in its "content scrolled underneath" blur.
- Two UX snapshots, one taken while blurred and one after the blur cleared, show no difference in page state. Both have a window of 375×762 with the visual viewport at offset (0, 0) and scale 1, `window.scroll` at (0, 0), no inline styles on body or root, and an identical DOM. So nothing in the page causes the blur. The blur is drawn over the page's top rows even though the page starts below the status bar.
- Focusing an input clears the blur. On iOS, `useIosVisualViewportRootStyle` responds to that focus by pinning the body with `position: fixed; top: 0` until the keyboard closes. So the cure is again a fixed element briefly covering the top edge, which suggests iOS re-checks the top layer whenever a fixed element there appears or disappears.
- Symptom 2 shows that both the top and the bottom edge layers exist and take on colour from the page.
- Symptom 3 suggests iOS now counts the status-bar inset as space where it may place the callout, instead of flipping it below the selection.

## Suggested Fix

1. **Keep a fixed element on the top edge at all times (recommended experiment).** On iOS standalone, make the mobile app root `position: fixed; inset: 0` instead of a `relative` `h-dvh` block (`App.tsx`). It would then always cover the top edge, so a full-screen overlay closing never leaves the edge without a fixed element. Check this against `useIosVisualViewportRootStyle`, which already pins the root with `position: fixed; top: 0` while the keyboard is up, and whose scroll-lock behaviour took a lot of debugging to get right.
2. **Fallback.** When a full-screen overlay closes on iOS, briefly pin and unpin the body, the same way focusing an input does, so iOS re-checks the edge. This is a targeted workaround and would have to be added to every full-screen overlay.
3. A `<meta name="theme-color">` alone is unlikely to help, since iOS 26 reportedly samples fixed elements in preference to it.
4. For the callout (symptom 3), check whether `env(safe-area-inset-top)` is non-zero in the PWA on iOS 26. `--safe-area-top` is defined in `globals.css` but nothing uses it. If iOS now treats the status bar as part of the page, padding the top of the app root and the viewer by `--safe-area-top` (as is already done for the bottom) may move the callout back into view.

Already done: the bottom `safe-area-spacer` utility is now `user-select: none` with `-webkit-touch-callout: none`, so a long-press there no longer starts a selection. This removes the trigger in symptom 2, not its cause.
