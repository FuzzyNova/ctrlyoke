/**
 * Shot list #13b: the walkthrough's `verifyHarness` step image, in all four
 * themes. Left half: the "No CLI coding agent is available" panel on a host
 * with every harness CLI hidden. Right half: the harness picker with detected
 * harnesses. Each half is the dashboard at 600×690 CSS px, captured at 2×.
 *
 * The other walkthrough stills show VS Code itself (activity bar, integrated
 * terminal, the panel inside the window), which the hosted dashboard can't,
 * so they stay manual captures (see dev/backlog/SCREENSHOTS_AND_MEDIA_PLAN.md #13).
 */
import { openWorkflowProperties, waitForDashboard } from "../lib/dashboard.ts";
import type { Composite, Shot, Still } from "../lib/shot.ts";
import { THEME_NAMES, type ThemeName } from "../lib/themes.ts";

const HALF = { width: 600, height: 690 };

const leftPart = (theme: ThemeName): string =>
  `verify-harness-left-${theme}.png`;
const rightPart = (theme: ThemeName): string =>
  `verify-harness-right-${theme}.png`;

function noHarnessPanel(theme: ThemeName): Still {
  return {
    file: leftPart(theme),
    viewport: HALF,
    theme,
    part: true,
    async setup(page) {
      await waitForDashboard(page);
      await page.getByText("No CLI coding agent is available").waitFor();
    },
  };
}

function harnessPicker(theme: ThemeName): Still {
  return {
    file: rightPart(theme),
    viewport: HALF,
    theme,
    part: true,
    async setup(page) {
      await waitForDashboard(page);
      await openWorkflowProperties(page, "Harness");
      await page.locator("#settings-harness").click();
    },
  };
}

function combined(theme: ThemeName): Composite {
  return {
    file: `walkthrough-verify-harness-${theme}-2400x1380.png`,
    parts: [leftPart(theme), rightPart(theme)],
  };
}

export const walkthroughVerifyHarness: Shot = {
  id: "walkthrough-verify-harness",
  description: "#13b walkthrough verifyHarness step, four themes",
  stages: [
    { host: { noHarnesses: true }, stills: THEME_NAMES.map(noHarnessPanel) },
    { stills: THEME_NAMES.map(harnessPicker) },
  ],
  composites: THEME_NAMES.map(combined),
  // Ships in the VSIX, so it gets the same palette compression as the other
  // walkthrough stills.
  quantize: true,
};
