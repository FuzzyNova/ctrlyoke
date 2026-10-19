import type { Shot } from "../lib/shot.ts";
import type { VideoShot } from "../lib/video.ts";
import { hero } from "./hero.capture.ts";
import { propertiesTabs } from "./properties-tabs.capture.ts";
import { walkthroughVerifyHarness } from "./walkthrough.capture.ts";

export const SHOTS: Shot[] = [propertiesTabs, walkthroughVerifyHarness];
export const VIDEOS: VideoShot[] = [hero];
