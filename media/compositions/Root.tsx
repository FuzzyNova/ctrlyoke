import type React from "react";
import { Composition } from "remotion";
import { HERO_TAKE } from "../shots/hero.beats.ts";
import { PROMPT_EDITOR_TAKE } from "../shots/prompt-editor.beats.ts";
import { VISUAL_TAKE, YAML_TAKE } from "../shots/visual-or-yaml.beats.ts";
import type { TimelineFile } from "../lib/timeline.ts";
import { editFrames, takeOf, type EditProps } from "./Edit.tsx";
import type { EditSpec } from "./edit.ts";
import { Hero, HERO_EDIT } from "./Hero.tsx";
import { PromptEditor, PROMPT_EDITOR_EDIT } from "./PromptEditor.tsx";
import { sideBySideMetadata } from "./SideBySide.tsx";
import { VisualOrYaml, visualOrYamlPanes } from "./VisualOrYaml.tsx";

const FPS = 30;

/**
 * Size and length of a one-take edit: the frame is the recording's full
 * device resolution, and the length is whatever the edit adds up to.
 */
function fromTake(spec: EditSpec, take: string) {
  return ({ props }: { props: EditProps }) => {
    const timeline = takeOf(props, take);
    return {
      fps: FPS,
      width: timeline.viewport.width * timeline.scale,
      height: timeline.viewport.height * timeline.scale,
      durationInFrames: editFrames(spec, timeline, FPS),
    };
  };
}

/** Studio preview needs some props; real renders pass the takes' timelines. */
function placeholder(...takes: string[]): EditProps {
  const timeline: TimelineFile = {
    video: "raw.mp4",
    viewport: { width: 1350, height: 900 },
    scale: 2,
    fps: FPS,
    duration: 1,
    beats: [],
  };
  return {
    takes: Object.fromEntries(takes.map((take) => [take, timeline])),
  };
}

export const Root: React.FC = () => (
  <>
    <Composition
      id="Hero"
      component={Hero}
      defaultProps={placeholder(HERO_TAKE)}
      calculateMetadata={fromTake(HERO_EDIT, HERO_TAKE)}
    />
    <Composition
      id="PromptEditor"
      component={PromptEditor}
      defaultProps={placeholder(PROMPT_EDITOR_TAKE)}
      calculateMetadata={fromTake(PROMPT_EDITOR_EDIT, PROMPT_EDITOR_TAKE)}
    />
    <Composition
      id="VisualOrYaml"
      component={VisualOrYaml}
      defaultProps={placeholder(VISUAL_TAKE, YAML_TAKE)}
      calculateMetadata={({ props }: { props: EditProps }) =>
        sideBySideMetadata(visualOrYamlPanes(props), FPS)
      }
    />
  </>
);
