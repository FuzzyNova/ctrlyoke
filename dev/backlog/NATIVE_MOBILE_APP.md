# Native Mobile App (iOS + Android)

> **Status: REJECTED (2026-07-28).** The responsive hosted dashboard already
> supplies the mobile control surface. Native apps would duplicate the client
> and distribution stack without improving workflow orchestration.

**Created:** 2026-05-01  
**Status:** LONG-TERM / NOT STARTED  
**Effort:** Large (separate project)

---

## Problem

The ctrlyoke hosted server is a PWA — any workspace can be saved to a phone homescreen with one tap after scanning the QR code. This is frictionless and great for single-workspace users.

The problem surfaces with multiple workspaces: five projects means five PWA shortcuts, all with the same ctrlyoke icon. There's no way to tell them apart at a glance, and managing five separate saved PWAs gets messy.

---

## Long-Term Vision: Native ctrlyoke App

A native iOS/Android app that acts as a hub for all ctrlyoke servers:

- **Server list**: scan a QR code to add a server; saved servers persist locally
- **Per-server coloring**: each server entry styled with its workspace accent color (pulled from the server's theme config at connect time)
- **Single app, many workspaces**: instead of 5 homescreen PWA icons, one app with a list of servers to tap into
- **Push notifications**: native push instead of relying on browser notification permissions
- **Offline awareness**: detect when a workspace server is unreachable vs. idle

Stack options to evaluate: React Native (code-share with the existing React webview), Flutter, or native Swift/Kotlin.

---

## Shorter-Term: Dynamic Per-Workspace Icon Coloring (PWA Path)

Before investing in a native app, we can meaningfully improve the PWA experience by serving workspace-colored icons dynamically from `CtrlYokeHostedServer`. This gives homescreen PWA users distinct icons per workspace without any native app.

### How it works

1. Add an optional `accentColor` field to the workspace/user config (e.g., `ctrlyoke.accentColor: "#e85c2e"`).
2. The server reads this color at startup and generates colored SVG icons on-the-fly by substituting the color into the source SVG template (same logic as `generate-app-icons.mjs` but runtime, not build-time).
3. Serve the colored SVGs from dynamic routes (e.g., `/icon.svg?v=<hash>`) instead of static files.
4. The `<link rel="icon">` and PWA manifest entries point to the dynamic routes.
5. The manifest `theme_color` and `background_color` fields also reflect the accent color.

Result: user saves two ctrlyoke workspaces to homescreen → two distinct colored icons → immediately recognizable.

The server already builds a theme block (`buildThemeStyleBlock`) and injects it into HTML, so the plumbing for per-workspace color config is largely there. The main additions are:

- Config field for `accentColor`
- SVG colorization utility (reuse the logic from `generate-app-icons.mjs`)
- Dynamic icon routes in `CtrlYokeHostedServer`
- Updated manifest generation to include the accent color

This is a self-contained feature with high UX payoff and no dependency on a native app.
