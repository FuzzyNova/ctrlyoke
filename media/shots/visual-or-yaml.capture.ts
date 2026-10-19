import type { Locator, Page } from "playwright";
import {
  WORKFLOWS_DIR,
  editorLine,
  loadWorkflow,
  openWorkspaceFile,
  resetPageScroll,
} from "../lib/dashboard.ts";
import type { Timeline } from "../lib/timeline.ts";
import { complete, typeProse, type Completion } from "../lib/typing.ts";
import type { VideoShot } from "../lib/video.ts";
import {
  VISUAL_OR_YAML_PANE as PANE,
  VISUAL_BEATS,
  VISUAL_TAKE,
  YAML_BEATS,
  YAML_TAKE,
  type YamlRef,
} from "./visual-or-yaml.beats.ts";

/**
 * Both takes edit this file, each from its own start state. The visual take
 * loads it into the dashboard and changes only the dashboard's copy, so the
 * YAML take can reinstall the file and start over.
 */
const WORKFLOW_FILE = "bug-sweep.ctrlyoke.yaml";
/** Steps out of order, the third hunt outside the group with no harness. */
const VISUAL_START = "bug-sweep-unbuilt.ctrlyoke.yaml";
/**
 * The finished workflow less the third hunt and the last fix, which the take
 * types. It is on screen, so it carries no fixture comment of its own.
 */
const YAML_START = "bug-sweep-unfinished.ctrlyoke.yaml";

/** The YAML take needs room for the Explorer, which the edit crops away. */
const YAML_VIEWPORT = { width: 900, height: PANE.height } as const;

/** A step in the step list by its name; their accessible names are "Step <n>". */
function step(page: Page, name: string): Locator {
  return page
    .getByRole("button", { name: /^Step \d+$/ })
    .filter({ hasText: name });
}

/** The drag handle at a step's right edge. It shows on hover. */
async function dragHandle(page: Page, name: string): Promise<Locator> {
  await step(page, name).hover();
  return step(page, name).getByRole("button", { name: "Drag to reorder" });
}

async function midpoint(
  locator: Locator,
  fraction: number
): Promise<{ x: number; y: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} is not visible`);
  return { x: box.x + box.width / 2, y: box.y + box.height * fraction };
}

async function prepareVisual(page: Page): Promise<void> {
  await loadWorkflow(page, `${WORKFLOWS_DIR}/${WORKFLOW_FILE}`);
  await resetPageScroll(page);
}

async function recordVisual(page: Page, timeline: Timeline): Promise<void> {
  await timeline.hold(1);
  // Into the parallel group: over Hunt store bugs, so it lands between the
  // two hunts already there. Steps drag by their handle, which sits at the
  // step's right edge, so keep the pointer on that column.
  const hunt = await dragHandle(page, "Hunt doc bugs");
  const handleX = (await midpoint(hunt, 0.5)).x;
  const intoGroup = await midpoint(step(page, "Hunt store bugs"), 0.6);
  await timeline.drag(
    hunt,
    { x: handleX, y: intoGroup.y },
    { grab: VISUAL_BEATS.GRAB_HUNT, drop: VISUAL_BEATS.DROP_HUNT }
  );
  await timeline.hold(0.8);
  // Triage runs after the hunts: onto the top of the first fix.
  const triage = await dragHandle(page, "Triage");
  const beforeFixes = await midpoint(step(page, "Fix API bug"), 0.2);
  await timeline.drag(
    triage,
    { x: handleX, y: beforeFixes.y },
    { grab: VISUAL_BEATS.GRAB_TRIAGE, drop: VISUAL_BEATS.DROP_TRIAGE }
  );
  await timeline.hold(0.8);

  // Give the new hunt its own harness and model.
  await timeline.click(step(page, "Hunt doc bugs"), VISUAL_BEATS.SELECT_HUNT);
  await timeline.hold(0.5);
  await timeline.click(
    page.getByRole("button", { name: "Toggle prompt properties" }),
    VISUAL_BEATS.PROPERTIES
  );
  const properties = page.getByRole("region", { name: "Prompt Properties" });
  await properties.waitFor();
  await timeline.hold(0.6);
  await timeline.click(
    properties.getByRole("button", { name: /^Harness, / }),
    VISUAL_BEATS.HARNESS
  );
  await timeline.hold(0.7);
  await timeline.click(
    page.getByRole("button", { name: "Copilot CLI, harness: copilot-cli" }),
    VISUAL_BEATS.COPILOT
  );
  await timeline.hold(0.6);
  await timeline.click(
    properties.getByRole("button", { name: /^Model, / }),
    VISUAL_BEATS.MODEL
  );
  const gemini = page.getByRole("button", {
    name: "Gemini 3.8 Flash, model: gemini-3.8-flash",
  });
  // The list is long; it scrolls itself, not the page.
  await timeline.hold(0.5);
  await gemini.scrollIntoViewIfNeeded();
  await timeline.hold(0.6);
  await timeline.click(gemini, VISUAL_BEATS.GEMINI);
  await timeline.hold(0.6);
  await timeline.click(
    page.getByRole("button", { name: "Update", exact: true }),
    VISUAL_BEATS.UPDATE
  );
  await step(page, "Hunt doc bugs").getByText("gemini-3.8-flash").waitFor();
  timeline.mark(VISUAL_BEATS.DONE);
  await timeline.hold(2);
}

/** One YAML completion: what is typed and the option picked. */
function yamlRef(
  name: YamlRef,
  typed: Completion["typed"],
  option: string
): Completion {
  return {
    typed,
    option,
    labels: { open: YAML_BEATS.open(name), pick: YAML_BEATS.pick(name) },
  };
}

/**
 * Starts a new line and types it with its own indentation. The editor's YAML
 * auto-indent follows the line above, which is right only some of the time,
 * so the take selects whatever it inserted and types over it.
 */
async function newLine(page: Page, text: string): Promise<void> {
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Home");
  await typeProse(page, text);
}

async function prepareYaml(page: Page): Promise<void> {
  await openWorkspaceFile(page, `${WORKFLOWS_DIR}/${WORKFLOW_FILE}`);
  await resetPageScroll(page);
}

async function recordYaml(page: Page, timeline: Timeline): Promise<void> {
  const editor = page.getByRole("textbox", { name: "File editor" });
  // The pane shows the editor alone, from its left edge to the window's.
  const left = await editor.evaluate(
    (content) => content.closest(".cm-editor")?.getBoundingClientRect().left
  );
  if (left === undefined) throw new Error("the file editor has no frame");
  timeline.focusArea(
    { x: left, y: 0, w: YAML_VIEWPORT.width - left, h: YAML_VIEWPORT.height },
    YAML_BEATS.EDITOR
  );
  await timeline.hold(1);

  // The third hunt, between the other two, as the visual take placed it.
  const apiHunt = await editorLine(editor, "that a client could hit.");
  await timeline.clickAt(apiHunt.end, YAML_BEATS.CARET);
  await page.keyboard.press("End");
  await timeline.hold(0.4);
  await newLine(page, "      - name: Hunt doc bugs");
  await newLine(page, "        harness: ");
  await complete(page, timeline, yamlRef("harness", "cop", "copilot-cli"));
  await newLine(page, "        model: ");
  await complete(page, timeline, yamlRef("model", "gem", "gemini-3.8-flash"));
  await newLine(page, "        prompt: Find one place where ");
  await complete(page, timeline, yamlRef("file", "@READ", "README.md"));
  await typeProse(page, " disagrees with the code.");
  await timeline.hold(0.8);

  // The last fix, at the end of the file.
  timeline.mark(YAML_BEATS.END);
  await page.keyboard.press("ControlOrMeta+End");
  await newLine(page, "  - name: Fix doc bug");
  await newLine(page, "    prompt: Fix the README bug from ");
  // `$step:` alone ends the value with a colon, which YAML reads as a key and
  // the list closes; typing on to the number keeps it open.
  await complete(
    page,
    timeline,
    yamlRef("step", ["$ste", "p:4"], "Step 4: Triage")
  );
  await typeProse(page, " and commit.");
  await timeline.hold(0.8);
  await timeline.click(
    page.getByRole("button", { name: "Save file" }),
    YAML_BEATS.SAVE
  );
  timeline.mark(YAML_BEATS.DONE);
  await timeline.hold(2);
}

/**
 * Shot list #14, "Build visually or edit as YAML": the same workflow built two
 * ways, shown side by side. Left, the dashboard: a hunt dragged into the
 * parallel group, triage moved after it, the hunt's harness and model set in
 * its properties. Right, the workflow file in the workspace viewer: the same
 * hunt and the last fix typed with ctrlyoke's YAML completions. The edit is
 * `compositions/VisualOrYaml.tsx`.
 */
export const visualOrYaml: VideoShot = {
  id: "visual-or-yaml",
  description:
    "Landing: one workflow built in the dashboard, then typed as YAML, side by side",
  composition: "VisualOrYaml",
  outputs: {
    av1: "visual-or-yaml-av1-2560x1600.mp4",
    h264: { file: "visual-or-yaml-h264-1280x800.mp4", width: 1280 },
    poster: { file: "visual-or-yaml-poster-2560x1600.webp", atSeconds: 12 },
  },
  takes: [
    {
      id: VISUAL_TAKE,
      viewport: PANE,
      workflows: { [WORKFLOW_FILE]: VISUAL_START },
      prepare: prepareVisual,
      record: recordVisual,
    },
    {
      id: YAML_TAKE,
      viewport: YAML_VIEWPORT,
      workflows: { [WORKFLOW_FILE]: YAML_START },
      prepare: prepareYaml,
      record: recordYaml,
    },
  ],
};
