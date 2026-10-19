/**
 * Beat labels the "Build visually or edit as YAML" capture records and its
 * composition cuts on. Shared so a renamed beat breaks the typecheck instead
 * of the render.
 */

/**
 * Each pane's size in CSS pixels: the visual take's viewport, and the crop of
 * the YAML take's wider one. The dashboard keeps its step list at this width.
 */
export const VISUAL_OR_YAML_PANE = { width: 640, height: 800 } as const;

/** The dashboard building the workflow: the left pane. */
export const VISUAL_TAKE = "visual";
/** The same workflow typed in the workspace viewer: the right pane. */
export const YAML_TAKE = "yaml";

export const VISUAL_BEATS = {
  GRAB_HUNT: "grab-hunt",
  DROP_HUNT: "drop-hunt",
  GRAB_TRIAGE: "grab-triage",
  DROP_TRIAGE: "drop-triage",
  SELECT_HUNT: "select-hunt",
  PROPERTIES: "properties",
  HARNESS: "harness",
  COPILOT: "copilot",
  MODEL: "model",
  GEMINI: "gemini",
  UPDATE: "update",
  DONE: "done",
} as const;

/** The YAML completions typed, in order. */
export const YAML_REFS = ["harness", "model", "file", "step"] as const;
export type YamlRef = (typeof YAML_REFS)[number];

export const YAML_BEATS = {
  /** The editor pane, which the right half crops to. */
  EDITOR: "editor",
  /** The caret goes to the end of the parallel group's last step. */
  CARET: "caret",
  open: (ref: YamlRef) => `${ref}-open`,
  pick: (ref: YamlRef) => `${ref}-pick`,
  /** The caret goes to the end of the file for the last step. */
  END: "end",
  SAVE: "save",
  DONE: "done",
} as const;
