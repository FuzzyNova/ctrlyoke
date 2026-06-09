import type { OutputMessageTarget } from "./outputProjection";

export interface OutputNavigationOptions {
  behavior?: ScrollBehavior;
  align?: "start" | "end";
}

export interface OutputNavigationController {
  scrollToTarget: (
    target: OutputMessageTarget,
    options?: OutputNavigationOptions
  ) => void;
  getTargetScrollFraction: (target: OutputMessageTarget) => number | null;
}

let activeOutputNavigationController: OutputNavigationController | null = null;

export function setActiveOutputNavigationController(
  controller: OutputNavigationController | null
): void {
  activeOutputNavigationController = controller;
}

export function getActiveOutputNavigationController(): OutputNavigationController | null {
  return activeOutputNavigationController;
}
