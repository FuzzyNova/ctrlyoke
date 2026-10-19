import type React from "react";
import {
  AbsoluteFill,
  Freeze,
  OffthreadVideo,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import type { TimelineFile } from "../lib/timeline.ts";
import {
  cameraAt,
  planEdit,
  pointerAt,
  recordedTimeAt,
  type EditPlan,
  type EditSpec,
} from "./edit.ts";

export interface EditProps extends Record<string, unknown> {
  timeline: TimelineFile;
}

/** Output frames for `spec` over `timeline`, for a composition's `calculateMetadata`. */
export function editFrames(
  spec: EditSpec,
  timeline: TimelineFile,
  fps: number
): number {
  return planEdit(spec, timeline, fps).frames;
}

/** The standard arrow pointer, drawn at CSS size with its tip at (0, 0). */
const POINTER_PATH = "M0 0 L0 17 L4.5 13 L7.5 20 L10.5 18.7 L7.5 12 L13 12 Z";

const PointerLayer: React.FC<{ plan: EditPlan; timeline: TimelineFile }> = ({
  plan,
  timeline,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pointer = pointerAt(timeline, recordedTimeAt(plan, frame, fps));
  if (!pointer || pointer.opacity <= 0) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: pointer.x,
        top: pointer.y,
        opacity: pointer.opacity,
      }}
    >
      {pointer.ripple !== undefined ? (
        <div
          style={{
            position: "absolute",
            left: -18,
            top: -18,
            width: 36,
            height: 36,
            borderRadius: "50%",
            border: "2px solid rgba(255, 255, 255, 0.9)",
            background: "rgba(0, 120, 212, 0.25)",
            transform: `scale(${0.4 + pointer.ripple * 0.8})`,
            opacity: 1 - pointer.ripple,
          }}
        />
      ) : null}
      <svg
        width={16}
        height={22}
        viewBox="-1 -1 15 23"
        style={{ position: "absolute", left: -1, top: -1, overflow: "visible" }}
      >
        <path
          d={POINTER_PATH}
          fill="#fff"
          stroke="#000"
          strokeWidth={1.2}
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};

/**
 * Renders an edit: each cut plays its stretch of the raw recording at its
 * rate (or holds one frame), under a camera that eases between the cuts'
 * framings, with the pointer drawn on top in page coordinates.
 */
export const Edit: React.FC<{ spec: EditSpec; timeline: TimelineFile }> = ({
  spec,
  timeline,
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const plan = planEdit(spec, timeline, fps);
  const camera = cameraAt(plan, frame);
  const { width: pageWidth, height: pageHeight } = timeline.viewport;
  const outputScale = width / pageWidth;
  const video = staticFile(timeline.video);
  // Maps page point p to outputScale * zoom * (p + translate), which puts the
  // camera centre in the middle of the frame.
  const transform =
    `scale(${outputScale * camera.zoom}) ` +
    `translate(${pageWidth / (2 * camera.zoom) - camera.cx}px, ${pageHeight / (2 * camera.zoom) - camera.cy}px)`;

  return (
    <AbsoluteFill style={{ backgroundColor: "#000", overflow: "hidden" }}>
      <div
        style={{
          position: "absolute",
          width: pageWidth,
          height: pageHeight,
          transformOrigin: "0 0",
          transform,
        }}
      >
        {plan.segments.map((segment) => (
          <Sequence
            key={segment.startFrame}
            from={segment.startFrame}
            durationInFrames={segment.frames}
          >
            {segment.hold ? (
              <Freeze frame={0}>
                <OffthreadVideo
                  src={video}
                  muted
                  trimBefore={Math.round(segment.from * fps)}
                  style={{ width: pageWidth, height: pageHeight }}
                />
              </Freeze>
            ) : (
              <OffthreadVideo
                src={video}
                muted
                trimBefore={Math.round(segment.from * fps)}
                playbackRate={segment.rate}
                style={{ width: pageWidth, height: pageHeight }}
              />
            )}
          </Sequence>
        ))}
        <PointerLayer plan={plan} timeline={timeline} />
      </div>
    </AbsoluteFill>
  );
};
