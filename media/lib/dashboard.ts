import type { Locator, Page } from "playwright";
import type { Clip } from "./shot.ts";
import type { Point } from "./timeline.ts";

export const WORKFLOWS_DIR = ".ctrlyoke/workflows";

const STARTUP_TIMEOUT_MS = 30_000;

/** Waits until the startup overlay is gone and the dashboard takes input. */
export async function waitForDashboard(page: Page): Promise<void> {
  // In every layout; Toggle workflow properties only shows below wide ones.
  await page.getByRole("button", { name: "Open workflow menu" }).waitFor();
  await page
    .getByLabel("Loading ctrlyoke…")
    .waitFor({ state: "hidden", timeout: STARTUP_TIMEOUT_MS });
}

/** Loads a workspace-relative workflow file through the Load Workflow File dialog. */
export async function loadWorkflow(
  page: Page,
  relativePath: string
): Promise<void> {
  await waitForDashboard(page);
  await page.getByRole("button", { name: "Open workflow menu" }).click();
  await page.getByRole("option", { name: "Load from File..." }).click();
  await page
    .getByPlaceholder("path/to/workflow.ctrlyoke.yaml")
    .fill(relativePath);
  await page.getByRole("button", { name: "Load File" }).click();
  await page.getByText("Load Workflow File").waitFor({ state: "hidden" });
}

/** Opens the Workflow Properties drawer on a tab and returns the drawer. */
export async function openWorkflowProperties(
  page: Page,
  tab: string
): Promise<Locator> {
  await page
    .getByRole("button", { name: "Toggle workflow properties" })
    .click();
  const drawer = page.getByRole("region", { name: "Workflow Properties" });
  // The drawer slides in from below. Clicking a tab mid-slide makes Playwright
  // scroll the body to reach it, and that scroll outlasts the animation.
  await waitForStableBox(drawer);
  await drawer.getByRole("tab", { name: tab, exact: true }).click();
  return drawer;
}

/**
 * Scrolls the largest scrollable area inside `container` to the bottom, again
 * until its content stops growing. A mouse wheel would chain into the page
 * once that area hits its end.
 */
export async function scrollToEnd(container: Locator): Promise<void> {
  let previousHeight = -1;
  for (let attempt = 0; attempt < 50; attempt++) {
    const height = await container.evaluate((root) => {
      let best: Element | undefined;
      let bestOverflow = 0;
      for (const el of root.querySelectorAll("*")) {
        const overflow = el.scrollHeight - el.clientHeight;
        if (
          overflow > bestOverflow &&
          /(auto|scroll)/.test(getComputedStyle(el).overflowY)
        ) {
          best = el;
          bestOverflow = overflow;
        }
      }
      if (!best) return 0;
      best.scrollTop = best.scrollHeight;
      return best.scrollHeight;
    });
    if (height > 0 && height === previousHeight) return;
    previousHeight = height;
    await container.page().waitForTimeout(150);
  }
  throw new Error("scrollable content never settled");
}

/**
 * Scrolls the document back to the top. The dashboard never scrolls its
 * document, but automation can: loading a workflow through the Load Workflow
 * File dialog leaves the body scrolled with the heading row off-screen.
 */
export async function resetPageScroll(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  });
}

/** Waits until an element stops moving, e.g. after a panel's open animation. */
export async function waitForStableBox(element: Locator): Promise<void> {
  let previous = "";
  for (let attempt = 0; attempt < 50; attempt++) {
    const box = await element.boundingBox();
    const current = box ? JSON.stringify(box) : "";
    if (current && current === previous) return;
    previous = current;
    await element.page().waitForTimeout(100);
  }
  throw new Error("element never stopped moving");
}

/**
 * The full-width strip from the element's top edge to the bottom of the
 * viewport. Side-panel crops use it so the panel's own 1px border stays in.
 */
export async function stripFrom(page: Page, element: Locator): Promise<Clip> {
  const box = await element.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error("element is not visible");
  return {
    x: 0,
    y: box.y,
    width: viewport.width,
    height: viewport.height - box.y,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Opens a workspace file in the workspace viewer the way a person would:
 * Explore files and changes, then each folder and the file in the Explorer.
 * Returns the viewer's file editor once it shows the file.
 */
export async function openWorkspaceFile(
  page: Page,
  relativePath: string
): Promise<Locator> {
  await waitForDashboard(page);
  await page.getByRole("button", { name: "Explore files and changes" }).click();
  const parts = relativePath.split("/");
  for (const [index, part] of parts.entries()) {
    const isFolder = index < parts.length - 1;
    // Explorer rows are named "<name>[/], <path>, modified <date>".
    await page
      .getByRole("button", {
        name: new RegExp(`^${escapeRegExp(part)}${isFolder ? "/" : ""}, `),
      })
      .click();
  }
  const editor = page.getByRole("textbox", { name: "File editor" });
  await editor.waitFor();
  return editor;
}

/**
 * Where a CodeMirror line starts and ends on screen, to click the caret there
 * or drag a selection. `editor` is the editor's textbox; `line` is a 1-based
 * line number or text the line contains. A wrapped line ends on its last row.
 */
export async function editorLine(
  editor: Locator,
  line: number | string
): Promise<{ start: Point; end: Point }> {
  const found = await editor.evaluate((content, wanted) => {
    const lines = [...content.querySelectorAll(":scope > .cm-line")];
    let element: Element | undefined;
    if (typeof wanted === "string") {
      element = lines.find((candidate) =>
        candidate.textContent?.includes(wanted)
      );
    } else {
      // Line numbers live in the gutter; match its row to a content line.
      const number = [
        ...(content
          .closest(".cm-editor")
          ?.querySelectorAll(".cm-lineNumbers .cm-gutterElement") ?? []),
      ].find((gutter) => gutter.textContent === String(wanted));
      const top = number?.getBoundingClientRect().top;
      element =
        top === undefined
          ? undefined
          : lines.find(
              (candidate) =>
                Math.abs(candidate.getBoundingClientRect().top - top) < 2
            );
    }
    if (!element) return undefined;
    const range = document.createRange();
    range.selectNodeContents(element);
    const rows = [...range.getClientRects()];
    const box = element.getBoundingClientRect();
    const first = rows[0] ?? box;
    const last = rows[rows.length - 1] ?? box;
    return {
      start: { x: box.left + 1, y: first.top + first.height / 2 },
      end: { x: last.right + 1, y: last.top + last.height / 2 },
    };
  }, line);
  if (!found)
    throw new Error(`the editor shows no line ${JSON.stringify(line)}`);
  return found;
}
