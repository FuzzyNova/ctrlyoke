import type { Shot } from "../lib/shot.ts";
import type { VideoShot } from "../lib/video.ts";
import { hero } from "./hero.capture.ts";
import { history } from "./history.capture.ts";
import { license } from "./license.capture.ts";
import { promptEditor } from "./prompt-editor.capture.ts";
import { propertiesTabs } from "./properties-tabs.capture.ts";
import { visualOrYaml } from "./visual-or-yaml.capture.ts";
import { walkthroughVerifyHarness } from "./walkthrough.capture.ts";
import { workspaceViewer } from "./workspace-viewer.capture.ts";

export const SHOTS: Shot[] = [
  propertiesTabs,
  walkthroughVerifyHarness,
  history,
  workspaceViewer,
  license,
];
export const VIDEOS: VideoShot[] = [hero, promptEditor, visualOrYaml];
