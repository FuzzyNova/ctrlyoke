/**
 * The activation step in docs/pro/index.md#activate-online: Settings → License
 * on a Free install, with a key pasted and Activate ready. The key field is a
 * password input, so the dummy key shows only as dots. The host keeps its
 * license out of the OS credential store (`media` mode in
 * scripts/dev-host.mjs), so this is always the Free state, never the
 * capturer's own license.
 */
import {
  resetPageScroll,
  waitForDashboard,
  waitForStableBox,
} from "../lib/dashboard.ts";
import type { Shot } from "../lib/shot.ts";

/** Displayed near its CSS size in the docs' ~688 px prose column. */
const VIEWPORT = { width: 760, height: 560 };
const DUMMY_KEY = "DEMO-KEY-NOT-REAL-0000-0000";

export const license: Shot = {
  id: "license",
  description: "Settings → License with a key ready to activate (docs/pro)",
  stages: [
    {
      stills: [
        {
          file: "license-activate-1520x1120.png",
          viewport: VIEWPORT,
          async setup(page) {
            await waitForDashboard(page);
            await page
              .getByRole("button", { name: "Open global settings" })
              .click();
            const tab = page.getByRole("button", {
              name: "License",
              exact: true,
            });
            await waitForStableBox(tab);
            await tab.click();
            await page.getByText("Tier").waitFor();
            // The capture host is a dev build; released builds have no Developer tab.
            await page
              .getByRole("button", { name: "Developer", exact: true })
              .evaluate((el) => el.style.setProperty("display", "none"));
            // License is the rail's last tab; keep it in view, selected.
            await tab.evaluate((el) => el.scrollIntoView({ block: "nearest" }));
            await resetPageScroll(page);
            await page.getByLabel("Pro license key").fill(DUMMY_KEY);
            await page.evaluate(() =>
              (document.activeElement as HTMLElement)?.blur()
            );
          },
        },
      ],
    },
  ],
};
