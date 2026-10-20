/**
 * Shot list #15: run history, over demo-app's recorded history
 * (lib/history.ts). The workflow list with its favorites and run counts,
 * history search finding one question answered by five harnesses, and an old
 * run reopened from a result. Landing page, "Every session, searchable".
 */
import type { Locator, Page } from "playwright";
import {
  resetPageScroll,
  waitForDashboard,
  waitForStableBox,
} from "../lib/dashboard.ts";
import type { Clip, Shot, Still } from "../lib/shot.ts";

const VIEWPORT = { width: 1280, height: 800 };
/** The hero run: six steps on six harnesses, which shows behind the list. */
const BACKDROP_WORKFLOW = "notes tagging and search api";
/** The rate-limiter runs gave five harnesses the same task; each answer names it. */
const QUERY = "per IP";
const SEARCH_TIMEOUT_MS = 120_000;

function workflowRow(page: Page, name: string): Locator {
  // Rows are named "<name> — <state> — <steps> — ...".
  return page.getByRole("button", { name: new RegExp(`^${name} — `) });
}

/** Opens the workflow list and waits for its reveal animation to finish. */
async function openWorkflowList(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: /^Show workflows: / });
  // The list stays mounted while closed, so its rows exist either way; wait
  // on the trigger and the menu's own reveal instead.
  await expectExpanded(trigger, "false");
  await trigger.click();
  await expectExpanded(trigger, "true");
  await page.waitForFunction(() => {
    const menu = document.querySelector(".workflow-dropdown-menu");
    return menu !== null && getComputedStyle(menu).opacity === "1";
  });
  await waitForStableBox(workflowRow(page, BACKDROP_WORKFLOW));
}

async function expectExpanded(
  trigger: Locator,
  expanded: "true" | "false"
): Promise<void> {
  await trigger
    .page()
    .waitForFunction(
      ([element, value]) => element?.getAttribute("aria-expanded") === value,
      [await trigger.elementHandle(), expanded] as const
    );
}

/** Opens the backdrop workflow, so the list opens over a real run. */
async function loadBackdrop(page: Page): Promise<void> {
  await waitForDashboard(page);
  await openWorkflowList(page);
  await workflowRow(page, BACKDROP_WORKFLOW).click();
  await page.getByRole("button", { name: /^Step 6$/ }).waitFor();
}

/**
 * Searches history for the query, narrowed to responses, and waits until the
 * listing is complete. The first search on a fresh host builds the index.
 */
async function searchHistory(page: Page): Promise<Locator> {
  await waitForDashboard(page);
  await page.getByRole("button", { name: "Search history" }).click();
  await page
    .getByRole("searchbox", { name: "Search workflow history" })
    .fill(QUERY);
  await page.getByRole("button", { name: /^History search filters/ }).click();
  await page.locator("#history-event-kind-filter").click();
  const kinds = page.getByRole("listbox").filter({ hasText: "Conversation" });
  await kinds.getByText("All", { exact: true }).click();
  await kinds.getByRole("button", { name: "Response", exact: true }).click();
  await page.keyboard.press("Escape");
  // Opening the filter dropdown scrolls the document; the dashboard never does.
  await resetPageScroll(page);
  await page
    .getByText(/^\d+ results? \(filtered\)$/)
    .waitFor({ timeout: SEARCH_TIMEOUT_MS });
  await page
    .getByLabel("Still searching")
    .waitFor({ state: "hidden", timeout: SEARCH_TIMEOUT_MS });
  const results = page.locator("[data-history-search-listing-id] button");
  await results.first().waitFor();
  return results;
}

/** The search input keeps focus, and a result row draws a focus border. */
async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

function still(file: string, setup: Still["setup"]): Still {
  return { file, viewport: VIEWPORT, setup };
}

export const history: Shot = {
  id: "history",
  description:
    "#15 Run history: workflow list, search, a reopened run (landing)",
  stages: [
    {
      // The docs-* workflows were made for documentation captures; their
      // names read as internal on the landing page.
      host: { history: { exclude: /^docs-/ } },
      // A day after the newest recorded run, so times read "yesterday" and
      // "N days ago" on every retake.
      now: "2026-10-15T17:00:00Z",
      stills: [
        still("history-workflows-2560x1600.png", async (page) => {
          await loadBackdrop(page);
          await openWorkflowList(page);
        }),
        still("history-search-2560x1600.png", async (page) => {
          await searchHistory(page);
          await blur(page);
        }),
        still(
          "history-reopened-run-2560x1600.png",
          async (page): Promise<Clip | void> => {
            const results = await searchHistory(page);
            await results
              .filter({ hasText: "rate limiter middleware - opencode" })
              .first()
              .click();
            // Opening a result arms the output find bar with the query.
            await page.getByText(/^1 of \d+$/).waitFor();
            await page.getByRole("button", { name: /^Step 3$/ }).waitFor();
          }
        ),
      ],
    },
  ],
};
