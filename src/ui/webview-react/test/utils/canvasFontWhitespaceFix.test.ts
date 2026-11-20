import { describe, expect, it } from "vitest";
import { ensureCanvasFontWhitespaceFix } from "@utils/canvasFontWhitespaceFix";

const DEFAULT_FONT = "10px sans-serif";

/** A 2D context whose `font` setter mimics Chromium: invalid values are ignored. */
function makeContextClass(rejectLeadingWhitespace: boolean) {
  class FakeContext2D {
    _font = DEFAULT_FONT;
  }
  Object.defineProperty(FakeContext2D.prototype, "font", {
    configurable: true,
    enumerable: true,
    get(this: { _font: string }) {
      return this._font;
    },
    set(this: { _font: string }, value: string) {
      if (rejectLeadingWhitespace && /^\s/.test(value)) return;
      this._font = value;
    },
  });
  return FakeContext2D;
}

function makeWindow(rejectLeadingWhitespace: boolean) {
  const CanvasRenderingContext2D = makeContextClass(rejectLeadingWhitespace);
  const OffscreenCanvasRenderingContext2D = makeContextClass(
    rejectLeadingWhitespace
  );
  const fakeWindow = {
    CanvasRenderingContext2D,
    OffscreenCanvasRenderingContext2D,
    document: {
      createElement: () => ({
        getContext: () => new CanvasRenderingContext2D(),
      }),
    } as unknown as Document,
  };
  return fakeWindow;
}

type FontCtx = { font: string };

describe("ensureCanvasFontWhitespaceFix", () => {
  it("strips leading whitespace on both 2D context types when the runtime has the bug", () => {
    const win = makeWindow(true);
    const before = new win.CanvasRenderingContext2D() as unknown as FontCtx;
    before.font = " bold 28px Consolas, monospace";
    expect(before.font).toBe(DEFAULT_FONT);

    expect(ensureCanvasFontWhitespaceFix(win)).toBe(true);

    const ctx = new win.CanvasRenderingContext2D() as unknown as FontCtx;
    ctx.font = " bold 28px Consolas, monospace";
    expect(ctx.font).toBe("bold 28px Consolas, monospace");

    const offscreen =
      new win.OffscreenCanvasRenderingContext2D() as unknown as FontCtx;
    offscreen.font = "\t 14px Consolas";
    expect(offscreen.font).toBe("14px Consolas");
  });

  it("leaves a runtime without the bug untouched", () => {
    const win = makeWindow(false);
    const originalSetter = Object.getOwnPropertyDescriptor(
      win.CanvasRenderingContext2D.prototype,
      "font"
    )?.set;

    expect(ensureCanvasFontWhitespaceFix(win)).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(
        win.CanvasRenderingContext2D.prototype,
        "font"
      )?.set
    ).toBe(originalSetter);
  });

  it("patches a realm only once", () => {
    const win = makeWindow(true);
    expect(ensureCanvasFontWhitespaceFix(win)).toBe(true);
    const patchedSetter = Object.getOwnPropertyDescriptor(
      win.CanvasRenderingContext2D.prototype,
      "font"
    )?.set;
    expect(ensureCanvasFontWhitespaceFix(win)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(
        win.CanvasRenderingContext2D.prototype,
        "font"
      )?.set
    ).toBe(patchedSetter);
  });

  it("returns false when the canvas probe is unavailable", () => {
    const win = {
      document: {
        createElement: () => ({ getContext: () => null }),
      } as unknown as Document,
    };
    expect(ensureCanvasFontWhitespaceFix(win)).toBe(false);
  });
});
