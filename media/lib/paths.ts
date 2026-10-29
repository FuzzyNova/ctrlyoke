import path from "node:path";
import { fileURLToPath } from "node:url";

export const MEDIA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
export const REPO_ROOT = path.resolve(MEDIA_DIR, "..");
export const SCREENSHOTS_DIR = path.join(REPO_ROOT, "images", "screenshots");
export const FIXTURES_DIR = path.join(MEDIA_DIR, "fixtures");

// Keep in sync with the `media` mode in scripts/dev-host.mjs.
export const WORK_DIR = path.join(MEDIA_DIR, ".work");
export const DEMO_APP_DIR = path.join(WORK_DIR, "demo-app");
export const VSCODE_USER_DATA_DIR = path.join(WORK_DIR, "vscode-userdata");
/** The capture host's USERPROFILE/HOME, seeded from fixtures/home/. */
export const HOME_DIR = path.join(WORK_DIR, "home");
/** One JSON per phone shot (lib/phone.ts), with the shooting script beside them. */
export const PHONE_SHOTS_DIR = path.join(MEDIA_DIR, "phone");
/** The phone mockup the recordings are framed in; it isn't committed. */
export const PHONE_FRAME_FILE = path.join(WORK_DIR, "phone", "frame.png");
