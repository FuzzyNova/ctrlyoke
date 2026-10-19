import type React from "react";
import { Composition } from "remotion";
import type { TimelineFile } from "../lib/timeline.ts";
import { editFrames, type EditProps } from "./Edit.tsx";
import type { EditSpec } from "./edit.ts";
import { Hero, HERO_EDIT } from "./Hero.tsx";

const FPS = 30;

/**
 * Size and length come from the take: the frame is the recording's full
 * device resolution, and the length is whatever the edit adds up to.
 */
function fromTake(spec: EditSpec) {
  return ({ props }: { props: EditProps }) => {
    const timeline: TimelineFile = props.timeline;
    return {
      fps: FPS,
      width: timeline.viewport.width * timeline.scale,
      height: timeline.viewport.height * timeline.scale,
      durationInFrames: editFrames(spec, timeline, FPS),
    };
  };
}

/** Studio preview needs some props; real renders pass the take's timeline. */
const PLACEHOLDER: EditProps = {
  timeline: {
    video: "raw.mp4",
    viewport: { width: 1350, height: 900 },
    scale: 2,
    fps: FPS,
    duration: 1,
    beats: [],
  },
};

export const Root: React.FC = () => (
  <Composition
    id="Hero"
    component={Hero}
    defaultProps={PLACEHOLDER}
    calculateMetadata={fromTake(HERO_EDIT)}
  />
);
