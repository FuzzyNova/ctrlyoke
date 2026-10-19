import type { Shot } from "../lib/shot.ts";
import { propertiesTabs } from "./properties-tabs.capture.ts";
import { walkthroughVerifyHarness } from "./walkthrough.capture.ts";

export const SHOTS: Shot[] = [propertiesTabs, walkthroughVerifyHarness];
