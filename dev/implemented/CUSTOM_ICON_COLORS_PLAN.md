# Per-Workspace Custom Icon Colors

**Created:** 2026-05-01  
**Status:** Phase 1 DONE — Phase 2 READY  
**Effort:** Phase 1 — Small (half day) ✅; Phase 2 — Medium (1–2 days)

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
- A note that color changes take effect immediately for SVG-capable clients; iOS < 26 PNG clients use default colors until Phase 2 is implemented

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
import { initWasm, Resvg } from "@resvg/resvg-wasm";
// init once at startup, then:
const resvg = new Resvg(colorizedSvg, { fitTo: { mode: "width", value: 512 } });
const png = resvg.render().asPng();
// serve from /app-icon.png, /apple-touch-icon.png
```

**Option B: Pre-generated palette (no runtime dep, limited choices)**  
Extend `generate-app-icons.mjs` to produce 8–16 color combinations at build time (e.g., 8 light backgrounds with white stroke, 8 dark backgrounds with black stroke). Ship all PNG sets with the extension. User picks from a swatch selector instead of a free color picker.

- ~16 combos × 3 sizes × ~15KB ≈ ~720KB additional package weight
- Zero runtime processing; works everywhere without any new dependencies
- Trade-off: limited palette, requires a new build to add colors

**Recommendation:** Option A (WASM PNG gen) — free color pickers already work for SVG clients; replacing with a swatch selector would be a UX regression.

---

#### Phase 2 Implementation Details (Option A)

**Routes to make dynamic:**

- `/apple-touch-icon.png` → dynamic colorized PNG (180×180) — referenced in `<link rel="apple-touch-icon" sizes="180x180">` and manifest `icons[]`
- `/app-icon.png` (a.k.a. `icon.png`) → dynamic colorized PNG (512×512) — referenced in manifest `icons[]`
- `/favicon.png` — **not needed**: Phase 1 removed the `<link rel="icon" type="image/png">` tag; SVG-only favicon covers all modern browsers

Both PNGs are generated from the same source: `flightpath-app-icon.svg` (same SVG served by the dynamic `/app-icon.svg` route). Apply the same color substitution (`#1076ba` → `iconBgColor`, `#ffffff` → `iconFgColor`) before passing to resvg-wasm.

**WASM initialization:**

- Call `initWasm(fs.readFileSync(wasmPath))` once at server startup (or lazily on first PNG request)
- Store generated PNGs as `Buffer` in memory (`cachedPngSmall` / `cachedPngLarge` fields on the server instance)
- Regenerate both buffers whenever `iconBgColor` or `iconFgColor` changes (triggered by settings-change event)
- Serve with `Cache-Control: no-store` (same as SVG routes)

**WASM bundle inclusion:**

- The `@resvg/resvg-wasm` package ships a `.wasm` file that must be copied as a bundled asset
- In `esbuild.js`, add the WASM file to the `copy` assets so it lands in `out/` alongside the extension JS
- At runtime, resolve the WASM path relative to `__dirname` (works in both dev and installed extension)

**Cache-busting for PNG routes:**

- Apply the same `?bg=...&fg=...` query param pattern used for SVG routes in `buildHtml()` and `buildManifest()`
- URL changes when colors change → browser/OS fetches fresh PNG

**`onChange`/`onBlur` split in `ServerSection.tsx`:**  
PNG regeneration is expensive. The color pickers must be split:

- `onChange` → update **local React state only** (instant visual preview; no persistence, no server call)
- `onBlur` → call `onUpdate("server.iconBgColor", value)` (persists to settings, triggers server-side PNG regeneration)

Currently Phase 1 pickers call `onUpdate` on every `onChange`. For Phase 2, refactor to local state with `onBlur` commit.

**UI note update:**  
Replace the current "PNG icon clients (iOS < 26 homescreen) use default colors until a server restart" with "PNG icon clients (iOS < 26) use the colors saved at the last settings update."

---

## Hot-swap vs. Restart

SVG routes can reflect color changes immediately (each request re-reads the setting). PNG routes (Phase 2) require regeneration on change; a reasonable UX is to regenerate on settings save and note in the UI that PNG clients (iOS < 26) need to refresh their cached icons.

---

## Related

- `NATIVE_MOBILE_APP.md` — long-term: native app that aggregates all FlightPath servers and applies workspace colors natively, eliminating the multi-PWA-shortcuts problem entirely
