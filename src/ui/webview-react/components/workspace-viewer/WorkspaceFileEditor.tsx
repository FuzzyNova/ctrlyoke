import {
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from "react";
import { EditorView, basicSetup } from "codemirror";
import {
  EditorState,
  EditorSelection,
  RangeSetBuilder,
  type Extension,
} from "@codemirror/state";
import { keymap, type PluginValue } from "@codemirror/view";
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
import { Decoration, ViewPlugin } from "@codemirror/view";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useUiStore } from "@store/uiStore";
import { parseSecretReferences } from "@root/utils/SecretReferenceParser";
import { createReferencePatterns } from "@root/utils/ReferencePatterns";

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
  /**
   * When set (a `data:` URI for a known image type), the file is rendered as an
   * inline <img> instead of the CodeMirror text editor — binary image bytes
   * can't be loaded into the text editor. See HostedWorkspaceViewerService.readFile.
   */
  imageDataUri?: string;
  readOnly?: boolean;
  onChange: (newContent: string) => void;
  onSave: () => void;
  saving?: boolean;
  onUndoRedoChange?: (canUndo: boolean, canRedo: boolean) => void;
  pendingSelection?: WorkspaceFileEditorPendingSelection | null;
  onPendingSelectionApplied?: (requestId: number) => void;
}

type WorkspaceReferenceType =
  | "file"
  | "directory"
  | "lineRange"
  | "symbol"
  | "secret";

export interface WorkspaceFileEditorPendingSelection {
  requestId: number;
  startLine: number;
  endLine: number;
}

interface WorkspaceReferenceMatch {
  from: number;
  to: number;
  type: WorkspaceReferenceType;
  path: string;
  secretName?: string;
  lineStart?: string;
  lineEnd?: string;
}

const LINK_TOUCH_MOVE_THRESHOLD_PX = 10;
const LINK_TOUCH_LONG_PRESS_MS = 500;

export const WorkspaceFileEditor = forwardRef<
  WorkspaceFileEditorHandle,
  WorkspaceFileEditorProps
>(
  (
    {
      filePath,
      content,
      imageDataUri,
      readOnly = false,
      onChange,
      onSave,
      onUndoRedoChange,
      pendingSelection,
      onPendingSelectionApplied,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onSaveRef = useRef(onSave);
    const onChangeRef = useRef(onChange);
    const onUndoRedoChangeRef = useRef(onUndoRedoChange);
    const onPendingSelectionAppliedRef = useRef(onPendingSelectionApplied);
    const ignoreUpdateRef = useRef(false);
    const openToFile = useWorkspaceViewerStore((s) => s.openToFile);
    const openToDirectory = useWorkspaceViewerStore((s) => s.openToDirectory);
    const openSecretsSettings = useCallback(() => {
      const ui = useUiStore.getState();
      ui.setGlobalSettingsTab("secrets");
      if (!ui.globalSettingsOpen) ui.toggleGlobalSettings();
    }, []);

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

    useEffect(() => {
      onPendingSelectionAppliedRef.current = onPendingSelectionApplied;
    }, [onPendingSelectionApplied]);

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
        selectAndScrollToLines(view, startLine, endLine);
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

    const extensions = useMemo<Extension[]>(() => {
      const langExt = getLanguageExtension(filePath);
      return [
        basicSetup,
        createThemeExtension("editor"),
        createWorkspaceEditorHighlightExtension(),
        createWorkspaceEditorLinkThemeExtension(),
        createWorkspaceReferenceDecorationExtension(),
        createWorkspaceReferenceClickHandlerExtension(
          openToFile,
          openToDirectory,
          openSecretsSettings
        ),
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
    }, [filePath, openSecretsSettings, openToDirectory, openToFile, readOnly]);

    // Create / recreate the editor when extensions change (filePath or readOnly changed)
    useEffect(() => {
      // Image files render as an <img> (below), not a CodeMirror view.
      if (imageDataUri) return;
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

    useEffect(() => {
      const view = viewRef.current;
      if (!view || !pendingSelection) return;

      selectAndScrollToLines(
        view,
        pendingSelection.startLine,
        pendingSelection.endLine
      );
      onPendingSelectionAppliedRef.current?.(pendingSelection.requestId);
    }, [content, pendingSelection]);

    if (imageDataUri) {
      return (
        <div className="h-full w-full overflow-auto flex items-center justify-center bg-editor-bg p-4">
          <img
            src={imageDataUri}
            alt={filePath}
            title={filePath}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    }

    return <div ref={containerRef} className="h-full w-full overflow-hidden" />;
  }
);

WorkspaceFileEditor.displayName = "WorkspaceFileEditor";

function selectAndScrollToLines(
  view: EditorView,
  startLine: number,
  endLine: number
) {
  const doc = view.state.doc;
  const lineCount = doc.lines;
  const clampedStart = Math.max(1, Math.min(startLine, lineCount));
  const clampedEnd = Math.max(clampedStart, Math.min(endLine, lineCount));
  const from = doc.line(clampedStart).from;
  const to = doc.line(clampedEnd).to;
  const range = EditorSelection.range(from, to);
  view.dispatch({
    selection: EditorSelection.create([range]),
    effects: EditorView.scrollIntoView(range, {
      y: "center",
      x: "nearest",
      yMargin: 24,
    }),
    userEvent: "select",
  });
  view.focus();
}

function createWorkspaceEditorLinkThemeExtension() {
  return EditorView.baseTheme({
    ".cm-link": {
      color: "var(--vscode-textLink-foreground)",
      textDecoration: "underline",
      cursor: "pointer",
    },
    ".cm-link:hover": {
      color: "var(--vscode-textLink-activeForeground)",
    },
  });
}

function findWorkspaceReferenceMatches(
  text: string,
  offset = 0
): WorkspaceReferenceMatch[] {
  const patterns = createReferencePatterns();

  const fileMatches: WorkspaceReferenceMatch[] = [];
  const directoryMatches: WorkspaceReferenceMatch[] = [];
  const lineRangeMatches: WorkspaceReferenceMatch[] = [];
  const symbolMatches: WorkspaceReferenceMatch[] = [];
  const secretMatches: WorkspaceReferenceMatch[] = parseSecretReferences(
    text
  ).map((reference) => ({
    from: offset + reference.startOffset,
    to: offset + reference.endOffset,
    type: "secret",
    path: "",
    secretName: reference.name,
  }));
  let match: RegExpExecArray | null;

  const collectPathMatches = (
    pattern: RegExp,
    type: "file" | "directory",
    target: WorkspaceReferenceMatch[]
  ) => {
    const regex = new RegExp(pattern.source, "g");
    while ((match = regex.exec(text)) !== null) {
      target.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type,
        path: match[1],
      });
    }
  };

  collectPathMatches(patterns.fullFileQuoted, "file", fileMatches);
  collectPathMatches(patterns.fullFile, "file", fileMatches);
  collectPathMatches(patterns.directoryQuoted, "directory", directoryMatches);
  collectPathMatches(patterns.directory, "directory", directoryMatches);

  const collectLineRangeMatches = (pattern: RegExp) => {
    const regex = new RegExp(pattern.source, "g");
    while ((match = regex.exec(text)) !== null) {
      lineRangeMatches.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type: "lineRange",
        // Group 1 is the quoted path, group 2 the bare one; exactly one is set.
        path: match[1] ?? match[2],
        lineStart: match[3],
        lineEnd: match[4],
      });
    }
  };

  collectLineRangeMatches(patterns.lineRange);

  const collectSymbolMatches = (pattern: RegExp) => {
    const regex = new RegExp(pattern.source, "g");
    while ((match = regex.exec(text)) !== null) {
      symbolMatches.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type: "symbol",
        path: match[2] ?? match[3],
        lineStart: match[6],
        lineEnd: match[7],
      });
    }
  };

  collectSymbolMatches(patterns.symbol);

  const filteredDirectoryMatches = directoryMatches.filter((dirMatch) => {
    return !fileMatches.some(
      (fileMatch) =>
        dirMatch.from >= fileMatch.from && dirMatch.to <= fileMatch.to
    );
  });

  return [
    ...fileMatches,
    ...filteredDirectoryMatches,
    ...lineRangeMatches,
    ...symbolMatches,
    ...secretMatches,
  ].sort((a, b) => a.from - b.from);
}

function createWorkspaceReferenceDecorationExtension() {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      decorations;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: {
        docChanged: boolean;
        viewportChanged: boolean;
        view: EditorView;
      }) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>();

        for (const { from, to } of view.visibleRanges) {
          const text = view.state.doc.sliceString(from, to);
          const matches = findWorkspaceReferenceMatches(text, from);

          for (const linkMatch of matches) {
            const attrs: Record<string, string> = {
              "data-type": linkMatch.type,
              "data-path": linkMatch.path,
            };

            if (linkMatch.lineStart) {
              attrs["data-line-start"] = linkMatch.lineStart;
            }
            if (linkMatch.lineEnd) {
              attrs["data-line-end"] = linkMatch.lineEnd;
            }
            if (linkMatch.secretName) {
              attrs["data-secret-name"] = linkMatch.secretName;
            }

            builder.add(
              linkMatch.from,
              linkMatch.to,
              Decoration.mark({
                class: "cm-link",
                attributes: attrs,
              })
            );
          }
        }

        return builder.finish();
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

function getLinkElement(target: EventTarget | null): HTMLElement | null {
  return target instanceof HTMLElement ? target.closest(".cm-link") : null;
}

function openWorkspaceReferenceLink(
  target: HTMLElement,
  openToFile: (filePath: string, startLine?: number, endLine?: number) => void,
  openToDirectory: (dirPath: string) => void,
  openSecretsSettings: () => void
): boolean {
  const type = target.getAttribute("data-type");
  if (type === "secret") {
    openSecretsSettings();
    return true;
  }
  const path = target.getAttribute("data-path");
  if (!type || !path) return false;

  if (type === "directory") {
    openToDirectory(path);
    return true;
  }

  if (type === "lineRange") {
    const lineStart = target.getAttribute("data-line-start");
    const lineEnd = target.getAttribute("data-line-end");
    openToFile(
      path,
      lineStart ? parseInt(lineStart, 10) : undefined,
      lineEnd ? parseInt(lineEnd, 10) : undefined
    );
    return true;
  }

  if (type === "symbol") {
    const lineStart = target.getAttribute("data-line-start");
    const lineEnd = target.getAttribute("data-line-end");
    openToFile(
      path,
      lineStart ? parseInt(lineStart, 10) : undefined,
      lineEnd ? parseInt(lineEnd, 10) : undefined
    );
    return true;
  }

  if (type === "file") {
    openToFile(path);
    return true;
  }

  return false;
}

function createWorkspaceReferenceClickHandlerExtension(
  openToFile: (filePath: string, startLine?: number, endLine?: number) => void,
  openToDirectory: (dirPath: string) => void,
  openSecretsSettings: () => void
) {
  let touchStart: {
    x: number;
    y: number;
    time: number;
    target: HTMLElement;
  } | null = null;

  const cancelTouch = () => {
    touchStart = null;
  };

  return EditorView.domEventHandlers({
    touchstart: (event) => {
      if (event.touches.length !== 1) {
        cancelTouch();
        return false;
      }

      const target = getLinkElement(event.target);
      if (!target) {
        cancelTouch();
        return false;
      }

      const touch = event.touches[0];
      touchStart = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
        target,
      };
      return false;
    },
    touchmove: (event) => {
      if (!touchStart || event.touches.length === 0) return false;

      const touch = event.touches[0];
      const dx = touch.clientX - touchStart.x;
      const dy = touch.clientY - touchStart.y;
      if (Math.sqrt(dx * dx + dy * dy) > LINK_TOUCH_MOVE_THRESHOLD_PX) {
        cancelTouch();
      }

      return false;
    },
    touchcancel: () => {
      cancelTouch();
      return false;
    },
    touchend: (event) => {
      if (!touchStart) return false;

      const start = touchStart;
      cancelTouch();

      if (Date.now() - start.time >= LINK_TOUCH_LONG_PRESS_MS) {
        return false;
      }

      const endTarget = getLinkElement(event.target);
      if (endTarget !== start.target) {
        return false;
      }

      if (
        !openWorkspaceReferenceLink(
          start.target,
          openToFile,
          openToDirectory,
          openSecretsSettings
        )
      ) {
        return false;
      }

      event.preventDefault();
      return true;
    },
    click: (event, view) => {
      const target = getLinkElement(event.target);
      if (!target) return false;
      if (!(event.ctrlKey || event.metaKey)) return false;

      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos === null) return false;

      if (
        !openWorkspaceReferenceLink(
          target,
          openToFile,
          openToDirectory,
          openSecretsSettings
        )
      ) {
        return false;
      }

      event.preventDefault();
      return true;
    },
  });
}
