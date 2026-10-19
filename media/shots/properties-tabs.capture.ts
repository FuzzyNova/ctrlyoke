/**
 * Shot list #12: the Workflow Properties drawer, one still per tab, cropped to
 * the panel at its real side-panel width (400 CSS px at 2×). Slotted into
 * docs/workflows/properties-panel.md, permissions.md and mcp-servers.md.
 */
import type { Page } from "playwright";
import {
  WORKFLOWS_DIR,
  loadWorkflow,
  openWorkflowProperties,
  scrollToEnd,
  stripFrom,
} from "../lib/dashboard.ts";
import type { Clip, Shot, Still } from "../lib/shot.ts";

const PROPERTIES = "media-properties.ctrlyoke.yaml";
const NAMED_WORKTREE = "media-properties-named-worktree.ctrlyoke.yaml";
const NO_VALIDATION = "media-properties-no-validation.ctrlyoke.yaml";

/** 400 CSS px wide; 880 tall leaves the panel 800 tall below the header. */
const VIEWPORT = { width: 400, height: 880 };

function tabStill(
  file: string,
  workflow: string,
  tab: string,
  arrange?: (page: Page) => Promise<void>
): Still {
  return {
    file,
    viewport: VIEWPORT,
    async setup(page): Promise<Clip> {
      await loadWorkflow(page, `${WORKFLOWS_DIR}/${workflow}`);
      const drawer = await openWorkflowProperties(page, tab);
      await arrange?.(page);
      return stripFrom(page, drawer);
    },
  };
}

export const propertiesTabs: Shot = {
  id: "properties-tabs",
  description: "#12 Workflow Properties drawer tabs (docs)",
  stages: [
    {
      workflows: [PROPERTIES, NAMED_WORKTREE, NO_VALIDATION],
      stills: [
        tabStill(
          "harness-tab-with-dropdown-800x1600.png",
          NO_VALIDATION,
          "Harness",
          async (page) => {
            await page.locator("#settings-harness").click();
          }
        ),
        tabStill(
          "harness-tab-managed-worktree-800x1600.png",
          PROPERTIES,
          "Harness"
        ),
        tabStill(
          "harness-tab-named-worktree-800x1600.png",
          NAMED_WORKTREE,
          "Harness"
        ),
        tabStill("context-tab-800x1600.png", PROPERTIES, "Context"),
        tabStill(
          "validation-tab-none-800x1600.png",
          NO_VALIDATION,
          "Validation"
        ),
        tabStill(
          "validation-tab-end-condition-with-script-800x1600.png",
          PROPERTIES,
          "Validation"
        ),
        tabStill(
          "validation-tab-end-condition-with-retry-800x1600.png",
          PROPERTIES,
          "Validation",
          async (page) => {
            // Scroll to the end, where the retry prompt and error behavior sit.
            await scrollToEnd(
              page.getByRole("region", { name: "Workflow Properties" })
            );
          }
        ),
        tabStill("mcp-tab-800x1600.png", PROPERTIES, "MCP", async (page) => {
          await page
            .getByText("Loading installed servers")
            .waitFor({ state: "hidden" });
          // Expanded, so the server's id, command and args show.
          await page.getByRole("button", { name: "playwright User" }).click();
        }),
        tabStill("hooks-tab-800x1600.png", PROPERTIES, "Hooks"),
        tabStill("permissions-tab-800x1600.png", PROPERTIES, "Permissions"),
      ],
    },
  ],
};
