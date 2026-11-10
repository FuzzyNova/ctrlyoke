/**
 * Hook backing the back/forward controls. Exposes whether a step is possible
 * and the actions to take it. Both header instances (main dashboard and the
 * workspace-viewer overlay) share this single hook, so they are two views of
 * one history.
 *
 * In the hosted browser the controls drive the real session history
 * (`history.back()/forward()`), with enabled states tracked in
 * {@link useBrowserHistoryCursorStore}; in the VS Code webview they walk the in-memory
 * {@link useRouteHistoryStore}. Hooks are always called unconditionally; the
 * mode constant only selects which result to surface.
 */
import { useCallback } from "react";
import { useVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { useRouteHistoryStore, canGoBack, canGoForward } from "./routeHistoryStore";
import {
  useBrowserHistoryCursorStore,
  canGoBackBrowser,
  canGoForwardBrowser,
} from "./browserHistoryCursorStore";
import { applyRoute } from "./applyRoute";

export interface NavHistory {
  canBack: boolean;
  canForward: boolean;
  back: () => void;
  forward: () => void;
}

export function useNavHistory(): NavHistory {
  const vscode = useVsCodeApi();
  const memCanBack = useRouteHistoryStore(canGoBack);
  const memCanForward = useRouteHistoryStore(canGoForward);
  const browserCanBack = useBrowserHistoryCursorStore(canGoBackBrowser);
  const browserCanForward = useBrowserHistoryCursorStore(canGoForwardBrowser);

  const back = useCallback(() => {
    if (isStandalone) {
      window.history.back();
      return;
    }
    const route = useRouteHistoryStore.getState().back();
    if (route) applyRoute(route, vscode);
  }, [vscode]);

  const forward = useCallback(() => {
    if (isStandalone) {
      window.history.forward();
      return;
    }
    const route = useRouteHistoryStore.getState().forward();
    if (route) applyRoute(route, vscode);
  }, [vscode]);

  return {
    canBack: isStandalone ? browserCanBack : memCanBack,
    canForward: isStandalone ? browserCanForward : memCanForward,
    back,
    forward,
  };
}
