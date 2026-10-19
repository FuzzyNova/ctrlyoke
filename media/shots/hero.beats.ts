/**
 * Beat labels the hero capture records and its composition cuts on. Shared so
 * a renamed beat breaks the typecheck instead of the render.
 */
export const HERO_BEATS = {
  RUN: "run",
  OUTPUT: "output",
  /** `step-<n>` marks when step n starts (1-based; step 1 starts at RUN). */
  step: (number: number) => `step-${number}`,
  DONE: "done",
  MINIMAP: "minimap",
  /** Hovering, then clicking, a step's minimap marker. */
  peek: (step: string) => `peek-${step}`,
  jump: (step: string) => `jump-${step}`,
} as const;

/** The hero's one take. */
export const HERO_TAKE = "run";
export const HERO_STEP_COUNT = 6;
/** The steps the clip jumps back to through the minimap, in order. */
export const HERO_JUMPS = ["plan", "implement"] as const;
