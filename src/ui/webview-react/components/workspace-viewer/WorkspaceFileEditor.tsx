import React, { useEffect, useRef, useMemo } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { createThemeExtension } from "@utils/codemirrorTheme";
import {
  getLanguageExtension,
  createWorkspaceEditorHighlightExtension,
} from "@utils/codemirrorLanguage";

interface WorkspaceFileEditorProps {
  filePath: string;
  content: string;
  readOnly?: boolean;
  onChange: (newContent: string) => void;
  onSave: () => void;
  saving?: boolean;
}

export const WorkspaceFileEditor: React.FC<WorkspaceFileEditorProps> = ({
  filePath,
  content,
  readOnly = false,
  onChange,
  onSave,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onSaveRef = useRef(onSave);
  const onChangeRef = useRef(onChange);
  const ignoreUpdateRef = useRef(false);

  // Keep callback refs current without triggering re-creation of the editor
  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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

    return () => {
      view.destroy();
      viewRef.current = null;
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
      });
      ignoreUpdateRef.current = false;
    }
  }, [content]);

  return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
};
