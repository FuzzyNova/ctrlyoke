/**
 * Shot list #10, desktop set: the hosted dashboard's workspace viewer on
 * demo-app, with the hero run's changes left uncommitted as an agent would
 * leave them. The editor with the language server's references, and Source
 * Control reviewing the diff before a commit. Landing page, "Your project, in
 * any browser".
 */
import type { Page } from "playwright";
import {
  editorWord,
  openWorkspaceFile,
  waitForDashboard,
} from "../lib/dashboard.ts";
import type { Shot, Still } from "../lib/shot.ts";

const VIEWPORT = { width: 1280, height: 800 };
const LANGUAGE_SERVER_TIMEOUT_MS = 60_000;
/** hero-end's own commit message for these changes. */
const COMMIT_MESSAGE =
  "feat(notes): add search, pagination, tags, and PATCH endpoint";

function still(file: string, setup: Still["setup"]): Still {
  return { file, viewport: VIEWPORT, setup };
}

async function blur(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur());
}

export const workspaceViewer: Shot = {
  id: "workspace-viewer",
  description:
    "#10 Workspace viewer: references in the editor, a diff to commit (landing)",
  stages: [
    {
      startTag: "hero-start",
      changesFrom: "hero-end",
      stills: [
        still("workspace-viewer-references-2560x1600.png", async (page) => {
          const editor = await openWorkspaceFile(
            page,
            "src/store/notesStore.ts"
          );
          // Show the store's folder alongside its siblings, not alone in it.
          await page
            .getByRole("button", { name: "Go to parent directory" })
            .click();
          await page.getByRole("button", { name: /^routes\/, / }).waitFor();
          const symbol = await editorWord(
            editor,
            "export function normalizeTag(",
            "normalizeTag"
          );
          // The menu lists the symbol actions only once the TypeScript server
          // has reported what it can do, which takes a while on a fresh host.
          const references = page.getByRole("button", {
            name: "Find All References",
          });
          const deadline = Date.now() + LANGUAGE_SERVER_TIMEOUT_MS;
          for (;;) {
            await page.mouse.click(symbol.x, symbol.y, { button: "right" });
            await page.waitForTimeout(500);
            if (await references.isEnabled().catch(() => false)) break;
            if (Date.now() > deadline) {
              throw new Error("the language server never offered references");
            }
            await page.keyboard.press("Escape");
            await page.waitForTimeout(1000);
          }
          await references.click();
          await page
            .getByText(/^\d+ results in \d+ files$/)
            .waitFor({ timeout: LANGUAGE_SERVER_TIMEOUT_MS });
        }),
        still("workspace-viewer-commit-2560x1600.png", async (page) => {
          await waitForDashboard(page);
          await page
            .getByRole("button", { name: "Explore files and changes" })
            .click();
          await page.getByRole("tab", { name: "Source Control" }).click();
          await page.getByRole("button", { name: "Stage All" }).click();
          await page.getByText("Staged (5)").waitFor();
          await page.getByTitle("src/routes/notes.ts").click();
          await page.getByText("Hide diff").waitFor();
          await page
            .getByRole("textbox", { name: "Commit message" })
            .fill(COMMIT_MESSAGE);
          await blur(page);
        }),
      ],
    },
  ],
};
