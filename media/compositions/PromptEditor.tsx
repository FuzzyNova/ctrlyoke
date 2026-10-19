import type React from "react";
import {
  PROMPT_EDITOR_BEATS as BEATS,
  PROMPT_EDITOR_REFS,
  PROMPT_EDITOR_TAKE,
} from "../shots/prompt-editor.beats.ts";
import { Edit, takeOf, type EditProps } from "./Edit.tsx";
import { typingCuts, type EditSpec } from "./edit.ts";

const CODE = { focus: BEATS.CODE, maxZoom: 1.4 } as const;
const EDITOR = { focus: BEATS.EDITOR, maxZoom: 1.5 } as const;

/**
 * The prompt editor clip's edit (SCREENSHOTS_AND_MEDIA_PLAN.md #9): close on
 * the code while the lines are selected and added, out while the viewer
 * closes, then close on the editor while the prompt is typed. Typing plays
 * sped up; every completion list plays at real speed.
 */
export const PROMPT_EDITOR_EDIT: EditSpec = {
  cuts: [
    { from: "start", to: { beat: BEATS.ADD_SELECTION, offset: 0.5 }, ...CODE },
    { from: { beat: BEATS.ADD_SELECTION, offset: 0.5 }, to: BEATS.EDITOR },
    ...typingCuts(
      BEATS.EDITOR,
      PROMPT_EDITOR_REFS.map((ref) => ({
        open: BEATS.open(ref),
        pick: BEATS.pick(ref),
      })),
      // The last pick lands a moment before DONE; let it settle first.
      { beat: BEATS.DONE, offset: 0.8 },
      { rate: 1.6, ...EDITOR }
    ),
    { from: { beat: BEATS.DONE, offset: 0.8 }, to: "end", ...EDITOR },
    { hold: "end", seconds: 1, ...EDITOR },
  ],
};

export const PromptEditor: React.FC<EditProps> = (props) => (
  <Edit
    spec={PROMPT_EDITOR_EDIT}
    timeline={takeOf(props, PROMPT_EDITOR_TAKE)}
  />
);
