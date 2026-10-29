/**
 * Shot list #11: undo, over the hero run replayed with its file snapshots, so
 * every edit has its original content and can be undone. An edit in the output
 * with its diff and Undo, and the Workflow changes dialog with two files picked
 * to undo. Landing page, "Every result, with undo".
 */
import type { Locator, Page } from "playwright";
import {
  resetPageScroll,
  waitForDashboard,
  waitForStableBox,
} from "../lib/dashboard.ts";
import { findRunFixture } from "../lib/runs.ts";
import type { Shot, Still } from "../lib/shot.ts";
import { HERO_STEP_COUNT } from "./hero.beats.ts";
import { loadHeroWorkflow, stepCount } from "./hero.capture.ts";

const VIEWPORT = { width: 1280, height: 800 };
/** At replay speed 0 the run still takes about a minute: each step plays its events. */
const RUN_TIMEOUT_MS = 5 * 60_000;
/** Antigravity's review edit: small enough that its whole diff fits the frame. */
const OUTPUT_EDIT = { step: "review", added: 18, removed: 7 };
/** Space left above the edit, so its "Edited" line and the reply before it show. */
const OUTPUT_EDIT_MARGIN_PX = 120;
/** The files ticked in the dialog; the first one's diff is opened. */
const DIALOG_FILES = ["src/routes/notes.ts", "src/store/notesStore.ts"];
/** Space left above the first ticked card in the dialog's list. */
const DIALOG_LIST_MARGIN_PX = 8;

const hero = findRunFixture("hero");
let heroRun: Promise<void> | undefined;

/**
 * Loads and runs the hero workflow once per capture. The host keeps the
 * finished run, so a later still's fresh page opens on it.
 */
function ensureHeroRun(page: Page): Promise<void> {
  heroRun ??= (async () => {
    await loadHeroWorkflow(page);
    await page
      .getByRole("button", { name: "Run", description: "Run draft" })
      .click();
    // "6 steps" shows before the run starts as well as after it ends.
    await stepCount(page)
      .getByText(new RegExp(`^Completed \\d+ of ${HERO_STEP_COUNT}$`))
      .waitFor({ timeout: RUN_TIMEOUT_MS });
    await stepCount(page)
      .getByText(`${HERO_STEP_COUNT} steps`, { exact: true })
      .waitFor({ timeout: RUN_TIMEOUT_MS });
  })();
  return heroRun;
}

async function openHeroRun(page: Page): Promise<void> {
  await waitForDashboard(page);
  await ensureHeroRun(page);
  await page.getByRole("button", { name: /^Step 6$/ }).waitFor();
}

/** Jumps the output to a step through its minimap marker, as the hero clip does. */
async function jumpToStep(page: Page, step: string): Promise<void> {
  await page
    .getByRole("group", { name: `Step ${step}`, exact: true })
    .getByRole("button", { name: step, exact: true })
    .click();
}

/**
 * Scrolls the list or output holding `element` so it sits `margin` px below
 * its top. Wheel scrolling would chain into the page; the dashboard never
 * scrolls its body.
 */
async function scrollIntoList(element: Locator, margin: number): Promise<void> {
  await element.evaluate((target, offset) => {
    let scroller = target.parentElement;
    while (
      scroller &&
      !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
    ) {
      scroller = scroller.parentElement;
    }
    if (!scroller) throw new Error("the element is not in a scrollable list");
    scroller.scrollTop +=
      target.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      offset;
  }, margin);
  await resetPageScroll(element.page());
  await waitForStableBox(element);
}

/** Opens the output on OUTPUT_EDIT with its diff expanded and its Undo in view. */
async function showOutputEdit(page: Page): Promise<void> {
  await openHeroRun(page);
  await jumpToStep(page, OUTPUT_EDIT.step);
  // The diff's header row: its toggle, line counts and Undo button.
  const header = page
    .locator("div", {
      has: page.getByLabel(
        `${OUTPUT_EDIT.added} lines added, ${OUTPUT_EDIT.removed} lines removed`
      ),
    })
    .filter({ has: page.getByRole("button", { name: "Toggle diff" }) })
    .last();
  await header.getByRole("button", { name: "Toggle diff" }).click();
  await header.getByText("Hide diff").waitFor();
  await scrollIntoList(header, OUTPUT_EDIT_MARGIN_PX);
}

function still(file: string, setup: Still["setup"]): Still {
  return { file, viewport: VIEWPORT, setup };
}

export const fileChanges: Shot = {
  id: "file-changes",
  description:
    "#11 Undo: an edit with its diff and Undo, the Workflow changes dialog (landing, docs)",
  stages: [
    {
      startTag: hero.startTag,
      // Speed 0 jumps each step to its end state; the shots show the end.
      host: { replay: { bundleDir: hero.bundleDir, speed: 0 } },
      stills: [
        still("file-changes-output-undo-2560x1600.png", showOutputEdit),
        // The docs column is too narrow for the whole dashboard: the pane alone.
        still("file-changes-output-pane-1596x1148.png", async (page) => {
          await showOutputEdit(page);
          // The section comes first; a pane inside it shares the name.
          return page.getByRole("region", { name: "Output" }).first();
        }),
        still("file-changes-workflow-2560x1600.png", async (page) => {
          await openHeroRun(page);
          // The output toolbar's count of every file the run changed comes
          // first; each step header repeats one for its own files.
          await page
            .getByRole("button", { name: /^View \d+ changes?$/ })
            .first()
            .click();
          const dialog = page.getByRole("dialog", { name: "Workflow changes" });
          await waitForStableBox(dialog);
          const cards = DIALOG_FILES.map((file) =>
            dialog.getByRole("article").filter({
              has: page.getByRole("checkbox", {
                name: new RegExp(`^Select .*${file.replace(/[.]/g, "\\.")}$`),
              }),
            })
          );
          for (const card of cards) await card.getByRole("checkbox").check();
          await cards[0].getByRole("button", { name: "Toggle diff" }).click();
          await cards[0].getByText("Hide diff").waitFor();
          // Lead with the ticked files. The plan file above them has no single
          // original to compare with, and says so.
          await scrollIntoList(cards[1], DIALOG_LIST_MARGIN_PX);
        }),
      ],
    },
  ],
};
