import type React from "react";
import { HERO_BEATS, HERO_JUMPS } from "../shots/hero.beats.ts";
import { Edit, type EditProps } from "./Edit.tsx";
import type { Cut, EditSpec } from "./edit.ts";

const { step, peek, jump } = HERO_BEATS;

/** Leans in on the output's right side while the minimap jumps. */
const JUMP_CAMERA = { focus: HERO_BEATS.MINIMAP, maxZoom: 1.35 } as const;

/** Each minimap jump: glide to the marker, hover, click, read. */
const jumps: Cut[] = HERO_JUMPS.flatMap((name, index): Cut[] => [
  {
    from:
      index === 0
        ? HERO_BEATS.MINIMAP
        : { beat: jump(HERO_JUMPS[index - 1]), offset: 2.4 },
    to: peek(name),
    rate: 1.5,
    ...JUMP_CAMERA,
  },
  {
    from: peek(name),
    to: { beat: jump(name), offset: 2.4 },
    rate: 1,
    ...JUMP_CAMERA,
  },
]);

/**
 * The hero's edit (SCREENSHOTS_AND_MEDIA_PLAN.md #6). The take records the
 * whole run at a 1.2 s idle-gap cap; this plays the opening and the end at
 * real speed and the six steps fast, then the minimap jumps at real speed.
 * Times are recorded seconds; rates are how many play per second.
 */
export const HERO_EDIT: EditSpec = {
  cuts: [
    { from: "start", to: HERO_BEATS.RUN, rate: 1 },
    { from: HERO_BEATS.RUN, to: { beat: HERO_BEATS.RUN, offset: 2 }, rate: 1 },
    { from: { beat: HERO_BEATS.RUN, offset: 2 }, to: step(3), rate: 4 },
    { from: step(3), to: step(6), rate: 9 },
    { from: step(6), to: HERO_BEATS.DONE, rate: 5 },
    { from: HERO_BEATS.DONE, to: HERO_BEATS.MINIMAP, rate: 1 },
    ...jumps,
    { hold: "end", seconds: 1 },
  ],
};

export const Hero: React.FC<EditProps> = ({ timeline }) => (
  <Edit spec={HERO_EDIT} timeline={timeline} />
);
