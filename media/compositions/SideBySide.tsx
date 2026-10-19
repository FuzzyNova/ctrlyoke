import type React from "react";
import {
  AbsoluteFill,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Edit } from "./Edit.tsx";
import { sequencePanes, type Pane, type Size } from "./edit.ts";

/** The line between panes, in CSS pixels; drawn over their edges, so it costs no width. */
const DIVIDER_WIDTH = 1;
const DIVIDER_COLOR = "#6b6b6b";
/** How dark a pane gets while the other one plays. */
const IDLE_DIM = 0.55;
const DIM_FADE_SECONDS = 0.4;

function paneSize(pane: Pane): Size {
  return pane.spec.frame ?? pane.timeline.viewport;
}

/**
 * Size and length of a side-by-side of `panes`, at the takes' recording scale.
 * The panes play in turn, so the length is the sum of their edits.
 */
export function sideBySideMetadata(panes: readonly Pane[], fps: number) {
  const scale = panes[0].timeline.scale;
  const sizes = panes.map(paneSize);
  return {
    fps,
    width: sizes.reduce((sum, size) => sum + size.width, 0) * scale,
    height: Math.max(...sizes.map((size) => size.height)) * scale,
    durationInFrames: sequencePanes(panes, fps).frames,
  };
}

/**
 * Panes side by side, left to right, taking turns: each plays its own edit
 * while the others hold a frame, dimmed, so the eye knows where to look.
 */
export const SideBySide: React.FC<{ panes: readonly Pane[] }> = ({ panes }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { specs, active } = sequencePanes(panes, fps);
  const scale = panes[0].timeline.scale;
  const fade = DIM_FADE_SECONDS * fps;
  let left = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {panes.map((pane, index) => {
        const size = paneSize(pane);
        const x = left;
        left += size.width;
        const { from, to } = active[index];
        // 1 inside the pane's turn, easing to 0 either side of it.
        const turn = Math.min(
          interpolate(frame, [from - fade, from], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          interpolate(frame, [to - 1, to - 1 + fade], [1, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          })
        );
        return (
          <div
            key={index}
            style={{
              position: "absolute",
              left: x * scale,
              top: 0,
              width: size.width * scale,
              height: size.height * scale,
              overflow: "hidden",
            }}
          >
            <Edit
              spec={specs[index]}
              timeline={pane.timeline}
              width={size.width * scale}
            />
            <AbsoluteFill
              style={{
                backgroundColor: "#000",
                opacity: (1 - turn) * IDLE_DIM,
              }}
            />
            {index > 0 ? (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: DIVIDER_WIDTH * scale,
                  backgroundColor: DIVIDER_COLOR,
                }}
              />
            ) : null}
          </div>
        );
      })}
    </AbsoluteFill>
  );
};
