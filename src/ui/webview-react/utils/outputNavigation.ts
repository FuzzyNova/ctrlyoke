import type { OutputMessageTarget } from "./outputProjection";

export interface OutputNavigationOptions {
  behavior?: ScrollBehavior;
  align?: "start" | "center" | "end";
}

export interface OutputNavigationController {
  scrollToRowIndex: (
    rowIndex: number,
    options?: OutputNavigationOptions
  ) => void;
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
