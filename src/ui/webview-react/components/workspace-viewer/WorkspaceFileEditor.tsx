import {
  useEffect,
  useRef,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import {
  indentWithTab,
  undo,
  redo,
  undoDepth,
  redoDepth,
} from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import { createThemeExtension } from "@utils/codemirrorTheme";
import {
  getLanguageExtension,
  createWorkspaceEditorHighlightExtension,
} from "@utils/codemirrorLanguage";

export interface WorkspaceFileEditorHandle {
  undo: () => void;
  redo: () => void;
  selectLines: (startLine: number, endLine: number) => void;
  getSelectionText: () => string;
  getSelectionRange: () => { startLine: number; endLine: number } | null;
}

interface WorkspaceFileEditorProps {
  filePath: string;
  content: string;
  readOnly?: boolean;
  onChange: (newContent: string) => void;
  onSave: () => void;
  saving?: boolean;
  onUndoRedoChange?: (canUndo: boolean, canRedo: boolean) => void;
}

export const WorkspaceFileEditor = forwardRef<
  WorkspaceFileEditorHandle,
  WorkspaceFileEditorProps
>(
  (
    { filePath, content, readOnly = false, onChange, onSave, onUndoRedoChange },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onSaveRef = useRef(onSave);
    const onChangeRef = useRef(onChange);
    const onUndoRedoChangeRef = useRef(onUndoRedoChange);
    const ignoreUpdateRef = useRef(false);

    // Keep callback refs current without triggering re-creation of the editor
    useEffect(() => {
      onSaveRef.current = onSave;
    }, [onSave]);

    useEffect(() => {
      onChangeRef.current = onChange;
    }, [onChange]);

    useEffect(() => {
      onUndoRedoChangeRef.current = onUndoRedoChange;
    }, [onUndoRedoChange]);

    useImperativeHandle(ref, () => ({
      undo: () => {
        if (viewRef.current) undo(viewRef.current);
      },
      redo: () => {
        if (viewRef.current) redo(viewRef.current);
      },
      selectLines: (startLine: number, endLine: number) => {
        const view = viewRef.current;
        if (!view) return;
        const doc = view.state.doc;
        const lineCount = doc.lines;
        const clampedStart = Math.max(1, Math.min(startLine, lineCount));
        const clampedEnd = Math.max(clampedStart, Math.min(endLine, lineCount));
        const from = doc.line(clampedStart).from;
        const to = doc.line(clampedEnd).to;
        view.dispatch({
          selection: { anchor: from, head: to },
          scrollIntoView: true,
        });
        view.focus();
      },
      getSelectionText: () => {
        const view = viewRef.current;
        if (!view) return "";
        const { from, to } = view.state.selection.main;
        if (from === to) return "";
        return view.state.sliceDoc(from, to);
      },
      getSelectionRange: () => {
        const view = viewRef.current;
        if (!view) return null;
        const { from, to } = view.state.selection.main;
        if (from === to) return null;
        const doc = view.state.doc;
        const startLine = doc.lineAt(from).number;
        const endLine = doc.lineAt(to).number;
        return { startLine, endLine };
      },
    }));

    const extensions = useMemo(() => {
      const langExt = getLanguageExtension(filePath);
      return [
        basicSetup,
        createThemeExtension("editor"),
        createWorkspaceEditorHighlightExtension(),
        ...(langExt ? [langExt] : []),
        keymap.of([
          indentWithTab,
          {
            key: "Mod-s",
            run: () => {
              onSaveRef.current();
              return true;
            },
          },
        ]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged && !ignoreUpdateRef.current) {
            onChangeRef.current(update.state.doc.toString());
          }
          if (update.docChanged) {
            onUndoRedoChangeRef.current?.(
              undoDepth(update.state) > 0,
              redoDepth(update.state) > 0
            );
          }
        }),
        ...(readOnly ? [EditorState.readOnly.of(true)] : []),
      ];
    }, [filePath, readOnly]);

    // Create / recreate the editor when extensions change (filePath or readOnly changed)
    useEffect(() => {
      if (!containerRef.current) return;

      const view = new EditorView({
        doc: content,
        extensions,
        parent: containerRef.current,
      });
      viewRef.current = view;
      onUndoRedoChangeRef.current?.(
        undoDepth(view.state) > 0,
        redoDepth(view.state) > 0
      );

      return () => {
        view.destroy();
        viewRef.current = null;
        onUndoRedoChangeRef.current?.(false, false);
      };
      // extensions covers filePath + readOnly; content is handled by the effect below
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [extensions]);

    // Sync editor content when the prop changes externally (e.g. file loaded from disk)
    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;

      const current = view.state.doc.toString();
      if (current !== content) {
        ignoreUpdateRef.current = true;
        view.dispatch({
          changes: { from: 0, to: current.length, insert: content },
          annotations: Transaction.addToHistory.of(false),
        });
        ignoreUpdateRef.current = false;
      }
    }, [content]);

    return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
  }
);

WorkspaceFileEditor.displayName = "WorkspaceFileEditor";
