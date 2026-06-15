/**
 * Hook backing the back/forward controls. Exposes whether a step is possible
 * and the actions to take it. Both header instances (main dashboard and the
 * workspace-viewer overlay) share this single hook, so they are two views of
 * one history.
 *
 * In the hosted browser the controls drive the real session history
 * (`history.back()/forward()`), with enabled states tracked in
 * {@link useBrowserHistoryStore}; in the VS Code webview they walk the in-memory
 * {@link useNavHistoryStore}. Hooks are always called unconditionally; the
 * mode constant only selects which result to surface.
 */
import { useCallback } from "react";
import { useVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useNavHistoryStore, canGoBack, canGoForward } from "./navHistoryStore";
import {
  useBrowserHistoryStore,
  canGoBackBrowser,
  canGoForwardBrowser,
} from "./browserHistoryStore";
import { applyRoute } from "./applyRoute";

export interface NavHistory {
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
}

export function useNavHistory(): NavHistory {
  const vscode = useVsCodeApi();
  const memCanBack = useNavHistoryStore(canGoBack);
  const memCanForward = useNavHistoryStore(canGoForward);
  const browserCanBack = useBrowserHistoryStore(canGoBackBrowser);
  const browserCanForward = useBrowserHistoryStore(canGoForwardBrowser);

  const back = useCallback(() => {
    if (isStandalone) {
      window.history.back();
      return;
    }
    const route = useNavHistoryStore.getState().back();
    if (route) applyRoute(route, vscode);
  }, [vscode]);

  const forward = useCallback(() => {
    if (isStandalone) {
      window.history.forward();
      return;
    }
    const route = useNavHistoryStore.getState().forward();
    if (route) applyRoute(route, vscode);
  }, [vscode]);

  return {
    canBack: isStandalone ? browserCanBack : memCanBack,
    canForward: isStandalone ? browserCanForward : memCanForward,
    back,
    forward,
  };
}
