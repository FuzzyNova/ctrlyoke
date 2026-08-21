/**
 * Rectangle the autocomplete dropdown is allowed to occupy.
 *
 * CodeMirror's default (`windowSpace`) uses `documentElement.clientHeight` — the
 * layout viewport, which on iOS keeps its full height while the on-screen
 * keyboard is up. Clamping the bottom to the visual viewport makes CodeMirror
 * flip the dropdown above the caret when it no longer fits below it.
 *
 * Tooltip positions come from `coordsAtPos`, which reports client rects in
 * layout-viewport coordinates. The visual viewport therefore needs to be
 * expressed as `offsetTop` .. `offsetTop + height`, rather than `0` .. `height`.
 */
export interface KeyboardTooltipSpace {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export function keyboardTooltipSpace(): KeyboardTooltipSpace {
  const docElt = document.documentElement;
  const vv = window.visualViewport;
  if (!vv) {
    return {
      top: 0,
      left: 0,
      bottom: docElt.clientHeight,
      right: docElt.clientWidth,
    };
  }

  return {
    top: Math.max(0, vv.offsetTop),
    left: Math.max(0, vv.offsetLeft),
    bottom: Math.min(docElt.clientHeight, vv.offsetTop + vv.height),
    right: Math.min(docElt.clientWidth, vv.offsetLeft + vv.width),
  };
}
