import type React from "react";
import {
  VISUAL_BEATS,
  VISUAL_OR_YAML_PANE,
  VISUAL_TAKE,
  YAML_BEATS,
  YAML_REFS,
  YAML_TAKE,
} from "../shots/visual-or-yaml.beats.ts";
import { takeOf, type EditProps } from "./Edit.tsx";
import { typingCuts, type EditSpec, type Pane } from "./edit.ts";
import { SideBySide } from "./SideBySide.tsx";

/** The dashboard building the workflow, a little faster than it was performed. */
export const VISUAL_EDIT: EditSpec = {
  cuts: [
    {
      from: "start",
      to: { beat: VISUAL_BEATS.DONE, offset: 1.5 },
      rate: 1.25,
    },
  ],
};

/** Cropped to the editor; typing sped up, each completion at real speed. */
const EDITOR = { focus: YAML_BEATS.EDITOR } as const;

export const YAML_EDIT: EditSpec = {
  frame: VISUAL_OR_YAML_PANE,
  cuts: [
    { from: "start", to: YAML_BEATS.CARET, ...EDITOR },
    ...typingCuts(
      YAML_BEATS.CARET,
      YAML_REFS.map((ref) => ({
        open: YAML_BEATS.open(ref),
        pick: YAML_BEATS.pick(ref),
      })),
      YAML_BEATS.SAVE,
      { rate: 1.6, ...EDITOR }
    ),
    {
      from: YAML_BEATS.SAVE,
      to: { beat: YAML_BEATS.DONE, offset: 1.5 },
      ...EDITOR,
    },
  ],
};

/** The two panes, built from the takes' timelines. */
export function visualOrYamlPanes(props: EditProps): Pane[] {
  return [
    { spec: VISUAL_EDIT, timeline: takeOf(props, VISUAL_TAKE) },
    { spec: YAML_EDIT, timeline: takeOf(props, YAML_TAKE) },
  ];
}

/**
 * "Build visually or edit as YAML" (SCREENSHOTS_AND_MEDIA_PLAN.md #14): the
 * dashboard on the left builds the workflow, then the YAML on the right is
 * typed, each pane dimmed while the other plays.
 */
export const VisualOrYaml: React.FC<EditProps> = (props) => (
  <SideBySide panes={visualOrYamlPanes(props)} />
);
