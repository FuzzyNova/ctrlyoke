import { useEffect, type RefObject } from "react";
import { EditorView, repositionTooltips } from "@codemirror/view";

/**
 * Keeps CodeMirror geometry and tooltips in sync with the mobile visual
 * viewport. Scroll fires continuously during native scroll animations, so it
 * only remeasures and repositions tooltips there; dispatching could interfere
 * with the scroll. Resize fires after the keyboard opens, so a focused editor
 * can safely scroll its caret into view.
 */
export function useVisualViewportEditorSync(
  viewRef: RefObject<EditorView | null>
): void {
  useEffect(() => {
    const visualViewport = window.visualViewport;
    if (!visualViewport) return;

    const handleScroll = () => {
      const view = viewRef.current;
      if (!view) return;
      view.requestMeasure();
      // requestMeasure does not re-run the tooltip plugin's measure request.
      repositionTooltips(view);
    };
    const handleResize = () => {
      const view = viewRef.current;
      if (!view) return;
      view.requestMeasure();
      repositionTooltips(view);
      if (!view.hasFocus) return;
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.selection.main.head, {
          y: "end",
          yMargin: 24,
        }),
      });
    };

    visualViewport.addEventListener("resize", handleResize);
    visualViewport.addEventListener("scroll", handleScroll);
    return () => {
      visualViewport.removeEventListener("resize", handleResize);
      visualViewport.removeEventListener("scroll", handleScroll);
    };
  }, []);
}
