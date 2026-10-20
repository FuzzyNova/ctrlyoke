import type { Page } from "playwright";
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
  PROMPT_EDITOR_BEATS as BEATS,
  PROMPT_EDITOR_TAKE,
  type PromptEditorRef,
} from "./prompt-editor.beats.ts";

/**
 * demo-app's capture workflow: one step, so `$previous` has something to point
 * at. Its header comment is the script this take follows.
 */
const DEMO_WORKFLOW = `${WORKFLOWS_DIR}/prompt-editor-demo.ctrlyoke.yaml`;
/** Declares CODECOV_TOKEN so `!` has a secret to complete (see the fixture). */
const SECRET_FIXTURE = "media-coverage-secret.ctrlyoke.yaml";
const SELECTED_FILE = "src/routes/notes.ts";
/** parsePositivePage and parsePageSize: the same function twice. */
const SELECTION = { from: 17, to: 37 } as const;

/** One reference typed into the prompt: what is typed and the option picked. */
function ref(name: PromptEditorRef, typed: string, option: string): Completion {
  return {
    typed,
    option,
    labels: { open: BEATS.open(name), pick: BEATS.pick(name) },
  };
}

/**
 * The opening frame: the prompt-editor demo loaded with the output pane
 * collapsed, so the editor gets the height, and notes.ts open in the
 * workspace viewer, scrolled so the selection fits. The Workflow Properties
 * panel stays open: the narrower editor wraps the prompt into a column the
 * edit can zoom in on.
 */
async function prepare(page: Page): Promise<void> {
  await loadWorkflow(page, DEMO_WORKFLOW);
  await page.getByRole("button", { name: "Collapse output" }).click();
  await page.getByRole("region", { name: "Workflow Properties" }).waitFor();
  await resetPageScroll(page);
  const editor = await openWorkspaceFile(page, SELECTED_FILE);
  // Two lines of context above the selection at the top of the editor.
  const top = await editorLine(editor, SELECTION.from - 2);
  await editor.evaluate((content, y) => {
    const scroller = content.closest(".cm-scroller");
    if (!scroller) throw new Error("the file editor has no scroller");
    scroller.scrollTop += y - scroller.getBoundingClientRect().top - 8;
  }, top.start.y - 10);
  await resetPageScroll(page);
}

async function record(page: Page, timeline: Timeline): Promise<void> {
  const editor = page.getByRole("textbox", { name: "File editor" });
  await timeline.hold(1);

  // Select the two parsers and send them to the prompt editor.
  const first = await editorLine(editor, SELECTION.from);
  const last = await editorLine(editor, SELECTION.to);
  timeline.focusArea(
    {
      x: first.start.x - 48,
      y: first.start.y - 16,
      w: 600,
      h: last.end.y - first.start.y + 32,
    },
    BEATS.CODE
  );
  await timeline.clickAt(first.start, BEATS.SELECT_START);
  await timeline.hold(0.4);
  await timeline.clickAt(last.end, BEATS.SELECT_END, { shift: true });
  await timeline.hold(0.8);
  await timeline.clickAt(
    { x: first.start.x + 240, y: (first.start.y + last.end.y) / 2 },
    BEATS.MENU,
    { button: "right" }
  );
  const addSelection = page.getByRole("menuitem", {
    name: "Add Selection to ctrlyoke",
  });
  await addSelection.waitFor();
  await timeline.hold(0.6);
  await timeline.click(addSelection, BEATS.ADD_SELECTION);
  await timeline.hold(0.6);
  await timeline.click(
    page.getByRole("button", { name: "Close workspace viewer" }),
    BEATS.CLOSE_VIEWER
  );

  // The chip is in; frame the editor and write the rest of the prompt.
  const prompt = page.getByRole("textbox", { name: "Prompt editor" });
  await prompt
    .getByTitle(`#selection:${SELECTED_FILE}:${SELECTION.from}-${SELECTION.to}`)
    .waitFor();
  const header = await page
    .getByRole("button", { name: "Collapse editor" })
    .boundingBox();
  const box = await prompt.boundingBox();
  if (!header || !box) throw new Error("the prompt editor is not visible");
  timeline.focusArea(
    { x: box.x - 8, y: header.y - 4, w: box.width + 16, h: 340 },
    BEATS.EDITOR
  );
  await page.mouse.move(0, 0);
  await prompt.focus();
  await page.keyboard.press("ControlOrMeta+End");
  await timeline.hold(0.8);

  await page.keyboard.press("Enter");
  await typeProse(
    page,
    "These two parsers are the same function twice. Fold them into one " +
      "parseIntInRange helper that reports errors the way "
  );
  await complete(page, timeline, ref("symbol", "#normalizeT", "normalizeTag"));
  await typeProse(page, " does.");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await typeProse(page, "Keep ");
  await complete(page, timeline, ref("file", "@notesSt", "notesStore.ts"));
  await typeProse(page, " unchanged, follow the layout in ");
  await complete(page, timeline, ref("folder", "@tes", "tests/"));
  await typeProse(page, ", and use the conventions from the scan in ");
  await complete(page, timeline, ref("previous", "$prev", "previous"));
  await typeProse(page, ". ");
  await complete(page, timeline, ref("commit", "~dedupe", "0f2072a"));
  await typeProse(
    page,
    " already deduped query normalization once, so match its style."
  );
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await typeProse(page, "When the tests pass, upload coverage with ");
  await complete(page, timeline, ref("secret", "!CODEC", "CODECOV_TOKEN"));
  await typeProse(page, " and cite every change with ");
  await complete(page, timeline, ref("skill", "/syn", "ctrlyoke-syntax"));
  await typeProse(page, ".");
  timeline.mark(BEATS.DONE);
  await timeline.hold(2.5);
}

/**
 * Shot list #9: the prompt editor's context references. Lines of a file go
 * from the workspace viewer into the prompt as a chip, then each trigger
 * (`#`, `@` file and folder, `$`, `~`, `!`, `/`) is typed and picked from its
 * completion. The edit is `compositions/PromptEditor.tsx`.
 */
export const promptEditor: VideoShot = {
  id: "prompt-editor",
  description:
    "Prompt editor: a selection becomes a chip, then every reference trigger completes",
  workflows: [SECRET_FIXTURE],
  // A dummy value, so the declared secret shows as set from the environment
  // and nothing is written to this machine's credential store.
  env: { CODECOV_TOKEN: "media-capture-dummy" },
  composition: "PromptEditor",
  outputs: {
    av1: "prompt-editor-av1-1920x1280.mp4",
    h264: { file: "prompt-editor-h264-960x640.mp4", width: 960 },
    // The finished prompt, every chip in place.
    poster: { file: "prompt-editor-poster-1920x1280.webp", atSeconds: -1 },
  },
  takes: [
    {
      id: PROMPT_EDITOR_TAKE,
      viewport: { width: 960, height: 640 },
      prepare,
      record,
    },
  ],
};
