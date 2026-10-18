import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOutputAutoscrollGlide } from "@hooks/useOutputAutoscrollGlide";
import type { OutputScrollTarget } from "@store/uiStore";
import {
  OUTPUT_SCROLL_APPLY_PHASES,
  OUTPUT_SCROLL_TARGET_KINDS,
} from "@root/types/DashboardConstants";
import {
  OUTPUT_AUTOSCROLL_GLIDE_CURVE,
  OUTPUT_AUTOSCROLL_GLIDE_DURATION_MS,
  resolveAutoscrollGlideCurve,
  sampleAutoscrollGlide,
  toCssCubicBezier,
} from "@utils/outputMotion";

const BOTTOM: OutputScrollTarget = { kind: OUTPUT_SCROLL_TARGET_KINDS.BOTTOM };

interface FakeAnimation {
  cancel: ReturnType<typeof vi.fn>;
  currentTime: number;
  easing: string | undefined;
  onfinish: (() => void) | null;
  keyframes: Keyframe[];
}

function buildPane() {
  const scrollElement = document.createElement("div");
  const clip = document.createElement("div");
  clip.setAttribute("data-output-glide-clip", "");
  const container = document.createElement("div");
  container.setAttribute("data-output-row-container", "");
  clip.appendChild(container);
  scrollElement.appendChild(clip);
  document.body.appendChild(scrollElement);
  Object.defineProperty(scrollElement, "clientHeight", {
    configurable: true,
    value: 600,
  });

  const animations: FakeAnimation[] = [];
  // jsdom has no Web Animations API. Tests advance a glide by setting its
  // `currentTime`, which is all the hook reads back.
  container.animate = vi.fn(
    (keyframes: Keyframe[], options?: KeyframeAnimationOptions) => {
      const animation: FakeAnimation = {
        cancel: vi.fn(),
        currentTime: 0,
        easing: options?.easing,
        onfinish: null,
        keyframes,
      };
      animations.push(animation);
      return animation as unknown as Animation;
    }
  ) as unknown as HTMLElement["animate"];

  return { animations, clip, container, scrollElement };
}

function renderGlide(scrollElement: HTMLDivElement) {
  const refs = {
    autoscrollEnabledRef: { current: true },
    isEnabledRef: { current: true },
    pendingNavigationRef: { current: null as unknown },
    scrollSeekPlaceholderRef: { current: false },
  };
  const hook = renderHook(() =>
    useOutputAutoscrollGlide({
      ...refs,
      outputRef: { current: scrollElement },
    })
  );
  return { ...hook, refs };
}

describe("useOutputAutoscrollGlide", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false }) as MediaQueryList)
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("translates the row container back by the written delta and clips its overflow", () => {
    const { animations, clip, scrollElement } = buildPane();
    const { result } = renderGlide(scrollElement);

    result.current.glideAfterScrollWrite(
      OUTPUT_SCROLL_APPLY_PHASES.AUTO_SCROLL,
      BOTTOM,
      48
    );

    expect(animations).toHaveLength(1);
    expect(animations[0]?.keyframes).toEqual([
      { transform: "translateY(48px)" },
      { transform: "translateY(0)" },
    ]);
    expect(clip.style.overflowY).toBe("clip");

    animations[0]?.onfinish?.();
    expect(clip.style.overflowY).toBe("");
  });

  it("starts from rest on the ease-in curve", () => {
    const { animations, scrollElement } = buildPane();
    const { result } = renderGlide(scrollElement);

    result.current.glideAfterScrollWrite(
      OUTPUT_SCROLL_APPLY_PHASES.AUTO_SCROLL,
      BOTTOM,
      30
    );

    expect(animations[0]?.easing).toBe(
      toCssCubicBezier(OUTPUT_AUTOSCROLL_GLIDE_CURVE)
    );
  });

  it("continues a running glide from its remaining offset and speed", () => {
    const { animations, scrollElement } = buildPane();
    const { result } = renderGlide(scrollElement);

    result.current.glideAfterScrollWrite(
      OUTPUT_SCROLL_APPLY_PHASES.LAYOUT_EFFECT,
      BOTTOM,
      30
    );
    const first = animations[0];
    if (!first) throw new Error("first glide did not start");
    first.currentTime = OUTPUT_AUTOSCROLL_GLIDE_DURATION_MS / 2;
    const before = sampleAutoscrollGlide(
      30,
      OUTPUT_AUTOSCROLL_GLIDE_CURVE,
      0.5
    );
    result.current.glideAfterScrollWrite(
      OUTPUT_SCROLL_APPLY_PHASES.LAYOUT_EFFECT,
      BOTTOM,
      20
    );

    expect(first.cancel).toHaveBeenCalled();
    const offsetPx = before.remainingOffsetPx + 20;
    expect(animations[1]?.keyframes[0]).toEqual({
      transform: `translateY(${offsetPx}px)`,
    });
    expect(animations[1]?.easing).toBe(
      toCssCubicBezier(resolveAutoscrollGlideCurve(before.speedPx, offsetPx))
    );
  });

  it("settles a running glide when a write is not eligible to glide", () => {
    const { animations, clip, scrollElement } = buildPane();
    const { result } = renderGlide(scrollElement);

    result.current.glideAfterScrollWrite(
      OUTPUT_SCROLL_APPLY_PHASES.AUTO_SCROLL,
      BOTTOM,
      30
    );
    result.current.glideAfterScrollWrite("width-change", BOTTOM, 30);

    expect(animations).toHaveLength(1);
    expect(animations[0]?.cancel).toHaveBeenCalled();
    expect(clip.style.overflowY).toBe("");
  });

  it.each([
    [
      "a row target",
      {
        kind: OUTPUT_SCROLL_TARGET_KINDS.ROW,
        rowKey: "r",
        viewportOffsetPx: 0,
      },
      {},
    ],
    ["released autoscroll", BOTTOM, { autoscrollEnabledRef: false }],
    ["a disabled pane", BOTTOM, { isEnabledRef: false }],
    ["scroll seeking", BOTTOM, { scrollSeekPlaceholderRef: true }],
    ["pending navigation", BOTTOM, { pendingNavigationRef: {} }],
  ] as const)("does not glide for %s", (_label, target, overrides) => {
    const { animations, scrollElement } = buildPane();
    const { result, refs } = renderGlide(scrollElement);
    for (const [name, value] of Object.entries(overrides)) {
      (refs[name as keyof typeof refs] as { current: unknown }).current = value;
    }

    result.current.glideAfterScrollWrite(
      OUTPUT_SCROLL_APPLY_PHASES.AUTO_SCROLL,
      target as OutputScrollTarget,
      30
    );

    expect(animations).toHaveLength(0);
  });

  it("does not glide past the viewport cap or under reduced motion", () => {
    const { animations, scrollElement } = buildPane();
    const { result } = renderGlide(scrollElement);

    result.current.glideAfterScrollWrite(
      OUTPUT_SCROLL_APPLY_PHASES.AUTO_SCROLL,
      BOTTOM,
      400
    );
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true }) as MediaQueryList)
    );
    result.current.glideAfterScrollWrite(
      OUTPUT_SCROLL_APPLY_PHASES.AUTO_SCROLL,
      BOTTOM,
      30
    );

    expect(animations).toHaveLength(0);
  });

  it("settleGlide cancels the glide and clears the clip", () => {
    const { animations, clip, scrollElement } = buildPane();
    const { result } = renderGlide(scrollElement);

    result.current.glideAfterScrollWrite(
      OUTPUT_SCROLL_APPLY_PHASES.AUTO_SCROLL,
      BOTTOM,
      30
    );
    result.current.settleGlide();

    expect(animations[0]?.cancel).toHaveBeenCalledTimes(1);
    expect(clip.style.overflowY).toBe("");
  });
});
