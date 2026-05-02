# Per-Workspace Custom Icon Colors

**Created:** 2026-05-01  
**Status:** READY  
**Effort:** Phase 1 — Small (half day); Phase 2 — Medium (1–2 days)

---

## Goal

Users with multiple FlightPath workspaces (each on a different port) can't tell them apart when saved to a phone homescreen or pinned as browser tabs — they all show the same icon. Allow each workspace to configure a background and foreground color for its favicon and PWA homescreen icon so workspaces are visually distinct.

---

## Settings to Add

Add to `server` section of `schemas/settings-schema.json`:

```json
"iconBgColor": {
  "type": "string",
  "pattern": "^#[0-9a-fA-F]{6}$",
  "description": "Background color for the workspace icon (hex, e.g. '#1076ba'). Applies to favicon and PWA homescreen icon."
},
"iconFgColor": {
  "type": "string",
  "pattern": "^#[0-9a-fA-F]{6}$",
  "description": "Foreground (path/stroke) color for the workspace icon (hex, e.g. '#ffffff')."
}
```

Default: `#1076ba` / `#ffffff` (current brand colors, matching the generated static files).

---

## UI Changes (ServerSection.tsx)

While the server is running, show an **Icon Colors** subsection with:
- Two `<input type="color">` pickers (background + foreground) — no extra dependencies, built into browsers
- A live inline SVG preview: embed the source SVG directly in JSX with the selected colors applied via inline style overrides (no round-trip to server needed for preview)
- A note that color changes take effect immediately for SVG-capable clients; PNG-capable clients need a server restart

---

## Implementation: Two Phases

### Phase 1 — Dynamic SVG (covers modern browsers + iOS 26+)

**How it works:**  
Add `/favicon.svg` and `/app-icon.svg` routes to `FlightPathHostedServer`. Each request reads the SVG source template, substitutes `currentColor` → `iconFgColor` and adds a background `<rect fill="iconBgColor">`, then serves the result. The existing static files remain as PNG fallbacks.

Update `HOSTED_ICON_PATHS` so the SVG entries point to these dynamic routes (already used in the `<link rel="icon">` and `<link rel="apple-touch-icon">` tags and in the manifest). The PNG paths continue pointing to the static pre-generated files (default colors).

**Coverage:**
| Client | Result |
|---|---|
| Modern browsers (Chrome, Firefox, Safari) | ✅ Colored SVG favicon |
| iOS 26+ homescreen | ✅ Colored SVG apple-touch-icon |
| iOS < 26 homescreen | ⚠️ Static PNG (default colors, no customization) |
| Android PWA | ✅ Manifest SVG icon used |

**Effort:** ~3–4 hours. No new dependencies. Follows the existing pattern of `buildThemeStyleBlock()` and the `/manifest.webmanifest` dynamic route.

---

### Phase 2 — Dynamic PNG generation (complete coverage including iOS < 26)

**Option A: @resvg/resvg-wasm (any color)**  
Add `@resvg/resvg-wasm` (~2.4MB WASM file) as a runtime dependency. At server startup (or when `iconBgColor`/`iconFgColor` settings change), generate the colorized PNGs in memory and serve them from dynamic routes. No native binaries — WASM runs anywhere Node.js runs.

```ts
import { initWasm, Resvg } from '@resvg/resvg-wasm';
// init once at startup, then:
const resvg = new Resvg(colorizedSvg, { fitTo: { mode: 'width', value: 512 } });
const png = resvg.render().asPng();
// serve from /app-icon.png, /favicon.png, /apple-touch-icon.png
```

**Option B: Pre-generated palette (no runtime dep, limited choices)**  
Extend `generate-app-icons.mjs` to produce 8–16 color combinations at build time (e.g., 8 light backgrounds with white stroke, 8 dark backgrounds with black stroke). Ship all PNG sets with the extension. User picks from a swatch selector instead of a free color picker.

- ~16 combos × 3 sizes × ~15KB ≈ ~720KB additional package weight
- Zero runtime processing; works everywhere without any new dependencies
- Trade-off: limited palette, requires a new build to add colors

**Recommendation:** Start with Phase 1 (dynamic SVG). If there's demand from iOS < 26 users, add Option A (WASM PNG gen) — it's ~2.4MB but gives total freedom and completes the feature. Option B (pre-baked palette) is a fallback if WASM adds too much weight.

---

## Hot-swap vs. Restart

SVG routes can reflect color changes immediately (each request re-reads the setting). PNG routes (Phase 2) require regeneration on change; a reasonable UX is to regenerate on settings save and note in the UI that PNG clients (iOS < 26) need to refresh their cached icons.

---

## Related

- `NATIVE_MOBILE_APP.md` — long-term: native app that aggregates all FlightPath servers and applies workspace colors natively, eliminating the multi-PWA-shortcuts problem entirely
