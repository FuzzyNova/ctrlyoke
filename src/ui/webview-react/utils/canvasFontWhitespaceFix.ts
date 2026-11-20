/**
 * Workaround for a Chromium regression (first shipped to us in VS Code 1.147 /
 * Electron 43.8.9): `CanvasRenderingContext2D.font` rejects a value with
 * leading whitespace and silently keeps `10px sans-serif`.
 *
 * xterm's WebGL glyph atlas builds `${italic} ${weight} ${size}px ${family}`,
 * where `italic` is "" for upright text, so nearly every glyph was rasterized
 * in 10px sans-serif inside cells measured for the real font: tiny, thin,
 * widely spaced text with no bold. VS Code patched its own terminal the same
 * way (microsoft/vscode#348269) but that patch does not reach webviews.
 *
 * Probe-gated: a runtime without the bug is left untouched. Remove once the
 * Chromium fix ships in every runtime we support.
 */

type CanvasFontWindow = Pick<Window, "document"> & {
  CanvasRenderingContext2D?: { prototype: object };
  OffscreenCanvasRenderingContext2D?: { prototype: object };
};

const LEADING_CSS_WHITESPACE = /^[ \t\r\n\f]+/;
const patchedRealms = new WeakSet<object>();

/** True when this realm's canvas drops a font string that starts with whitespace. */
function hasLeadingWhitespaceFontBug(targetWindow: CanvasFontWindow): boolean {
  try {
    const ctx = targetWindow.document.createElement("canvas").getContext("2d");
    if (!ctx) return false;
    ctx.font = " 24px monospace";
    return ctx.font === "10px sans-serif";
  } catch {
    return false;
  }
}

/**
 * Patch the `font` setter of the realm's 2D canvas contexts to strip leading
 * whitespace, if (and only if) the realm has the bug. Idempotent per realm.
 * Returns whether the realm is patched.
 */
export function ensureCanvasFontWhitespaceFix(
  targetWindow: CanvasFontWindow = window
): boolean {
  if (patchedRealms.has(targetWindow)) return true;
  if (!hasLeadingWhitespaceFontBug(targetWindow)) return false;
  patchedRealms.add(targetWindow);

  for (const ctor of [
    targetWindow.CanvasRenderingContext2D,
    targetWindow.OffscreenCanvasRenderingContext2D,
  ]) {
    const proto = ctor?.prototype;
    const descriptor = proto && Object.getOwnPropertyDescriptor(proto, "font");
    const originalSet = descriptor?.set;
    if (!proto || !descriptor || !originalSet) continue;
    Object.defineProperty(proto, "font", {
      ...descriptor,
      set(this: unknown, value: unknown) {
        originalSet.call(
          this,
          typeof value === "string"
            ? value.replace(LEADING_CSS_WHITESPACE, "")
            : value
        );
      },
    });
  }
  return true;
}
