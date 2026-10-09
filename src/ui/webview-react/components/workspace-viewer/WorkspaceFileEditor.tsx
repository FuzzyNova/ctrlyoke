import {
  useEffect,
  useCallback,
  useRef,
  useMemo,
  useState,
  useImperativeHandle,
  forwardRef,
} from "react";
import { EditorView, basicSetup } from "codemirror";
import {
  EditorState,
  Compartment,
  EditorSelection,
  RangeSetBuilder,
  type Extension,
  type StateField,
} from "@codemirror/state";
import { keymap, repositionTooltips, type PluginValue } from "@codemirror/view";
import {
  indentWithTab,
  undo,
  redo,
  undoDepth,
  redoDepth,
} from "@codemirror/commands";
import { Transaction } from "@codemirror/state";
import {
  createAtomicReferenceWidgetTheme,
  createThemeExtension,
} from "@utils/codemirrorTheme";
import {
  getLanguageExtension,
  createWorkspaceEditorHighlightExtension,
  loadYamlLanguageExtension,
} from "@utils/codemirrorLanguage";
import { getLanguageFromPath } from "@utils/syntaxHighlighting";
import { Decoration, ViewPlugin } from "@codemirror/view";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useLanguageIntelligence } from "@hooks/useLanguageIntelligence";
import {
  registerLanguageIntelligenceView,
  requestLanguageIntelligence,
  viewerPathFromUri,
  workspaceFileUri,
} from "@utils/languageIntelligenceClient";
import { useUiStore } from "@store/uiStore";
import { useSettingsStore } from "@store/settingsStore";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { getCtrlYokeFileKind } from "@root/completions/CtrlYokeFileKind";
import { createPromptCompletionClient } from "@utils/promptCompletion/createPromptCompletionClient";
import {
  loadWorkflowFileSupport,
  type WorkflowFileSupport,
} from "@utils/workflowFileSupport/loadWorkflowFileSupport";
import { createWorkflowFileCompletionExtension } from "@utils/workflowFileSupport/workflowFileCompletionExtension";
import {
  createWorkflowOutlineHoverExtension,
  createWorkflowPromptLintExtension,
} from "@utils/workflowFileSupport/workflowPromptLintExtension";
import {
  createWorkflowDocumentLintExtension,
  forceLinting,
} from "@utils/workflowFileSupport/workflowDocumentLintExtension";
import { createStoreWorkflowValueDataSource } from "@utils/workflowFileSupport/workflowValueDataSource";
import { parseSecretReferences } from "@root/utils/SecretReferenceParser";
import { createReferencePatterns } from "@root/utils/ReferencePatterns";
import { createAtomicReferenceExtension } from "@components/editor/CodeMirrorEditor";
import type { WorkflowTextSpan } from "@root/completions/WorkflowTextDecoding";
import {
  ATOMIC_REFERENCE_KINDS,
  CODEMIRROR_LANGUAGE_IDS,
  CTRLYOKE_FILE_KINDS,
  LSP_METHODS,
  PROMPT_FILE_LANGUAGE_IDS,
  WORKSPACE_ENTRY_KINDS,
  type WorkspaceFileTreeEntryKind,
} from "@root/types/DashboardConstants";

export interface WorkspaceFileEditorHandle {
  undo: () => void;
  redo: () => void;
  selectLines: (startLine: number, endLine: number) => void;
  getSelectionText: () => string;
  getSelectionRange: () => { startLine: number; endLine: number } | null;
  getLanguageCapabilities: () => Record<string, unknown>;
  goToDefinition: () => Promise<void>;
  findAllReferences: () => Promise<void>;
  renameSymbol: () => Promise<void>;
  formatDocument: () => Promise<void>;
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
  | WorkspaceFileTreeEntryKind
  | typeof ATOMIC_REFERENCE_KINDS.LINE_RANGE
  | typeof ATOMIC_REFERENCE_KINDS.SYMBOL
  | typeof ATOMIC_REFERENCE_KINDS.SECRET;

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
    const yamlLanguageCompartment = useRef(new Compartment());
    const yamlLanguageExtensionRef = useRef<Extension>([]);
    const languageIntelligenceCompartment = useRef(new Compartment());
    const languageIntelligence = useLanguageIntelligence(filePath);
    const languageIntelligenceRef = useRef(languageIntelligence);
    languageIntelligenceRef.current = languageIntelligence;
    // ctrlyoke completions for workflow files live in their own compartment,
    // beside the language-intelligence one, so a change never rebuilds the view.
    const ctrlyokeFileSupportCompartment = useRef(new Compartment());
    const ctrlyokeFileKind = useMemo(
      () => getCtrlYokeFileKind(filePath),
      [filePath]
    );
    // Null until the lazily loaded location/completion chunk arrives; the
    // sources answer nothing meanwhile.
    const workflowSupportRef = useRef<WorkflowFileSupport | null>(null);
    const [workflowSupportRevision, setWorkflowSupportRevision] = useState(0);
    const workflowPromptRangesField = useMemo(
      () =>
        workflowSupportRevision > 0 && ctrlyokeFileKind
          ? workflowSupportRef.current?.createWorkflowPromptRangesField(
              ctrlyokeFileKind
            )
          : undefined,
      [ctrlyokeFileKind, workflowSupportRevision]
    );
    const atomicContextReferences = useSettingsStore(
      (state) => state.globalSettings.atomicContextReferences
    );
    const defaultPreCondition = useSettingsStore(
      (state) => state.globalSettings.defaultPreCondition
    );
    const isMultiRootWorkspace = useSettingsStore(
      (state) => state.globalSettings.isMultiRoot
    );
    const isMultiRootWorkspaceRef = useRef(isMultiRootWorkspace);
    isMultiRootWorkspaceRef.current = isMultiRootWorkspace;
    const symbolIconCacheRef = useRef(new Map<string, string>());
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

    const goToDefinition = useCallback(async () => {
      const view = viewRef.current;
      const sessionId = languageIntelligenceRef.current.sessionId;
      if (!view || !sessionId) return;
      const result = (await requestLanguageIntelligence(
        sessionId,
        "textDocument/definition",
        {
          textDocument: { uri: workspaceFileUri(filePath) },
          position: toLspPosition(view, view.state.selection.main.head),
        }
      )) as LspLocation | LspLocation[] | null;
      const location = Array.isArray(result) ? result[0] : result;
      const path = location && viewerPathFromUri(location.uri);
      if (!location || !path) return;
      if (path === filePath)
        selectAndScrollToLines(
          view,
          location.range.start.line + 1,
          location.range.end.line + 1
        );
      else
        openToFile(
          path,
          location.range.start.line + 1,
          location.range.end.line + 1
        );
    }, [filePath, openToFile]);

    const findAllReferences = useCallback(async () => {
      const view = viewRef.current;
      const sessionId = languageIntelligenceRef.current.sessionId;
      if (!view || !sessionId) return;
      const result = (await requestLanguageIntelligence(
        sessionId,
        "textDocument/references",
        {
          textDocument: { uri: workspaceFileUri(filePath) },
          position: toLspPosition(view, view.state.selection.main.head),
          context: { includeDeclaration: true },
        }
      )) as LspLocation[] | null;
      const references = (result ?? []).flatMap((location) => {
        const path = viewerPathFromUri(location.uri);
        return path
          ? [
              {
                path,
                startLine: location.range.start.line + 1,
                endLine: Math.max(
                  location.range.start.line + 1,
                  location.range.end.line + 1
                ),
              },
            ]
          : [];
      });
      useWorkspaceViewerStore.getState().setLanguageReferences(references);
      useWorkspaceViewerStore.getState().open();
    }, [filePath]);

    const renameSymbol = useCallback(async () => {
      const view = viewRef.current;
      const sessionId = languageIntelligenceRef.current.sessionId;
      if (!view || !sessionId) return;
      const word = view.state.wordAt(view.state.selection.main.head);
      if (!word) return;
      const oldName = view.state.sliceDoc(word.from, word.to);
      const newName = window.prompt("Rename symbol", oldName);
      if (!newName || newName === oldName) return;
      await requestLanguageIntelligence(sessionId, LSP_METHODS.RENAME, {
        textDocument: { uri: workspaceFileUri(filePath) },
        position: toLspPosition(view, word.from),
        newName,
      });
    }, [filePath]);

    const formatDocument = useCallback(async () => {
      const view = viewRef.current;
      const sessionId = languageIntelligenceRef.current.sessionId;
      if (!view || !sessionId) return;
      const edits = (await requestLanguageIntelligence(
        sessionId,
        "textDocument/formatting",
        {
          textDocument: { uri: workspaceFileUri(filePath) },
          options: { tabSize: 2, insertSpaces: true },
        }
      )) as LspTextEdit[] | null;
      if (!edits?.length) return;
      view.dispatch({
        changes: edits
          .map((edit) => ({
            from: lspOffset(view, edit.range.start),
            to: lspOffset(view, edit.range.end),
            insert: edit.newText,
          }))
          .sort((a, b) => a.from - b.from),
      });
    }, [filePath]);

    useImperativeHandle(
      ref,
      () => ({
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
        getLanguageCapabilities: () =>
          languageIntelligenceRef.current.capabilities,
        goToDefinition,
        findAllReferences,
        renameSymbol,
        formatDocument,
      }),
      [findAllReferences, formatDocument, goToDefinition, renameSymbol]
    );

    const workflowPromptClient = useMemo(
      () =>
        ctrlyokeFileKind
          ? createPromptCompletionClient({
              transport: getVsCodeApi(),
              getView: () => viewRef.current,
              getSymbolIconCache: () => symbolIconCacheRef.current,
              getIsMultiRootWorkspace: () => isMultiRootWorkspaceRef.current,
            })
          : null,
      [ctrlyokeFileKind]
    );
    useEffect(
      () => () => workflowPromptClient?.dispose(),
      [workflowPromptClient]
    );
    const ctrlyokeFileSupportExtension = useMemo<Extension>(
      () =>
        ctrlyokeFileKind && workflowPromptClient
          ? [
              ...(ctrlyokeFileKind === CTRLYOKE_FILE_KINDS.WORKFLOW_YAML &&
              workflowSupportRef.current
                ? [
                    workflowSupportRef.current.createWorkflowPromptMarkdownLanguage(),
                    ...(workflowPromptRangesField
                      ? [
                          workflowSupportRef.current.createWorkflowPromptMarkdownDecorations(
                            workflowPromptRangesField
                          ),
                        ]
                      : []),
                  ]
                : []),
              createWorkflowFileCompletionExtension({
                kind: ctrlyokeFileKind,
                getSupport: () => workflowSupportRef.current,
                getDataSource: createStoreWorkflowValueDataSource,
                transport: getVsCodeApi(),
                promptClient: workflowPromptClient,
              }),
              createWorkflowDocumentLintExtension({
                kind: ctrlyokeFileKind,
                getSupport: () => workflowSupportRef.current,
                transport: getVsCodeApi(),
              }),
              createWorkflowPromptLintExtension({
                kind: ctrlyokeFileKind,
                getSupport: () => workflowSupportRef.current,
                transport: getVsCodeApi(),
                getSettingsPreCondition: () => defaultPreCondition,
              }),
              createWorkflowOutlineHoverExtension({
                kind: ctrlyokeFileKind,
                getSupport: () => workflowSupportRef.current,
              }),
              ...(workflowPromptRangesField ? [workflowPromptRangesField] : []),
              ...(atomicContextReferences && workflowPromptRangesField
                ? [
                    createAtomicReferenceExtension(
                      undefined,
                      undefined,
                      (view, from, to) =>
                        isWorkspacePromptReferenceRange(
                          view,
                          from,
                          to,
                          workflowPromptRangesField,
                          ctrlyokeFileKind,
                          filePath,
                          workflowSupportRef.current
                        )
                    ),
                  ]
                : []),
            ]
          : [],
      [
        atomicContextReferences,
        ctrlyokeFileKind,
        defaultPreCondition,
        filePath,
        workflowPromptClient,
        workflowPromptRangesField,
      ]
    );
    const ctrlyokeFileSupportExtensionRef = useRef(
      ctrlyokeFileSupportExtension
    );
    ctrlyokeFileSupportExtensionRef.current = ctrlyokeFileSupportExtension;

    useEffect(() => {
      if (!ctrlyokeFileKind) return;
      let cancelled = false;
      void loadWorkflowFileSupport().then((support) => {
        if (!cancelled) {
          workflowSupportRef.current = support;
          setWorkflowSupportRevision((revision) => revision + 1);
        }
      });
      return () => {
        cancelled = true;
        workflowSupportRef.current = null;
      };
    }, [ctrlyokeFileKind]);

    const extensions = useMemo<Extension[]>(() => {
      const langExt =
        ctrlyokeFileKind === CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
          ? null
          : getLanguageExtension(filePath);
      return [
        basicSetup,
        createThemeExtension("editor"),
        createAtomicReferenceWidgetTheme(),
        createWorkspaceEditorHighlightExtension(),
        createWorkspaceEditorLinkThemeExtension(),
        createWorkspaceReferenceDecorationExtension(),
        createWorkspaceReferenceClickHandlerExtension(
          openToFile,
          openToDirectory,
          openSecretsSettings
        ),
        ...(langExt ? [langExt] : []),
        yamlLanguageCompartment.current.of(yamlLanguageExtensionRef.current),
        languageIntelligenceCompartment.current.of(
          languageIntelligenceRef.current.extensions
        ),
        ctrlyokeFileSupportCompartment.current.of(
          ctrlyokeFileSupportExtensionRef.current
        ),
        keymap.of([
          indentWithTab,
          {
            key: "F12",
            preventDefault: true,
            run: () => {
              if (
                !languageIntelligenceRef.current.capabilities.definitionProvider
              )
                return false;
              void goToDefinition();
              return true;
            },
          },
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
    }, [
      filePath,
      goToDefinition,
      openSecretsSettings,
      openToDirectory,
      openToFile,
      readOnly,
      ctrlyokeFileKind,
    ]);

    useEffect(() => {
      const isPlainYaml =
        ctrlyokeFileKind !== CTRLYOKE_FILE_KINDS.WORKFLOW_YAML &&
        getLanguageFromPath(filePath) === CODEMIRROR_LANGUAGE_IDS.YAML;
      if (!isPlainYaml) {
        yamlLanguageExtensionRef.current = [];
        viewRef.current?.dispatch({
          effects: yamlLanguageCompartment.current.reconfigure([]),
        });
        return;
      }
      let cancelled = false;
      void loadYamlLanguageExtension().then((extension) => {
        if (cancelled || !viewRef.current) return;
        yamlLanguageExtensionRef.current = extension;
        viewRef.current.dispatch({
          effects: yamlLanguageCompartment.current.reconfigure(extension),
        });
      });
      return () => {
        cancelled = true;
      };
    }, [ctrlyokeFileKind, filePath]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: languageIntelligenceCompartment.current.reconfigure(
          languageIntelligence.extensions
        ),
      });
    }, [languageIntelligence.extensions]);

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: ctrlyokeFileSupportCompartment.current.reconfigure(
          ctrlyokeFileSupportExtension
        ),
      });
      forceLinting(view);
    }, [ctrlyokeFileSupportExtension]);

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
      const unregisterLanguageView = registerLanguageIntelligenceView(
        filePath,
        view
      );
      onUndoRedoChangeRef.current?.(
        undoDepth(view.state) > 0,
        redoDepth(view.state) > 0
      );

      return () => {
        unregisterLanguageView();
        view.destroy();
        viewRef.current = null;
        onUndoRedoChangeRef.current?.(false, false);
      };
      // extensions covers filePath + readOnly; content is handled by the effect below
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [extensions, filePath]);

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

    // Keep the caret visible above the mobile keyboard on visual viewport
    // changes — same treatment as CodeMirrorEditor. Resize fires once after
    // the keyboard fully opens, so a synchronous scrollIntoView dispatch is
    // safe; scroll fires continuously during native scroll animations, so
    // only requestMeasure runs there (no dispatches that could interfere).
    useEffect(() => {
      const vv = window.visualViewport;
      if (!vv) return;
      // requestMeasure alone does not re-run an open completion tooltip's own
      // placement, so reposition it against the keyboard-shrunk viewport.
      const handleScroll = () => {
        const view = viewRef.current;
        if (!view) return;
        view.requestMeasure();
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
      vv.addEventListener("resize", handleResize);
      vv.addEventListener("scroll", handleScroll);
      return () => {
        vv.removeEventListener("resize", handleResize);
        vv.removeEventListener("scroll", handleScroll);
      };
    }, []);

    if (imageDataUri) {
      return (
        <div className="flex h-full min-h-0 w-full items-center justify-center overflow-auto bg-editor-bg p-4">
          <img
            src={imageDataUri}
            alt={filePath}
            title={filePath}
            className="max-h-full max-w-full object-contain"
          />
        </div>
      );
    }

    return (
      <div className="flex h-full min-h-0 w-full flex-col overflow-hidden">
        <div
          ref={containerRef}
          className="min-h-0 w-full flex-1 overflow-hidden"
        />
        {languageIntelligence.statusHint && (
          <p
            className="shrink-0 px-2 py-1 text-xxs text-description-fg"
            role="status"
          >
            {languageIntelligence.statusHint}
          </p>
        )}
      </div>
    );
  }
);

WorkspaceFileEditor.displayName = "WorkspaceFileEditor";

interface LspPosition {
  line: number;
  character: number;
}
interface LspRange {
  start: LspPosition;
  end: LspPosition;
}
interface LspLocation {
  uri: string;
  range: LspRange;
}
interface LspTextEdit {
  range: LspRange;
  newText: string;
}

function toLspPosition(view: EditorView, offset: number): LspPosition {
  const line = view.state.doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

function lspOffset(view: EditorView, position: LspPosition): number {
  if (position.line >= view.state.doc.lines) return view.state.doc.length;
  const line = view.state.doc.line(Math.max(1, position.line + 1));
  return Math.min(line.to, line.from + Math.max(0, position.character));
}

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

function isWorkspacePromptReferenceRange(
  view: EditorView,
  from: number,
  to: number,
  field: StateField<readonly WorkflowTextSpan[]>,
  kind: NonNullable<ReturnType<typeof getCtrlYokeFileKind>>,
  filePath: string,
  support: WorkflowFileSupport | null
): boolean {
  if (
    !support ||
    (kind !== CTRLYOKE_FILE_KINDS.WORKFLOW_YAML &&
      kind !== CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN)
  )
    return false;

  const spans = view.state.field(field, false) ?? [];
  const docText = view.state.doc.toString();
  const codeRanges = getCachedPromptCodeRanges(
    spans,
    docText,
    support,
    filePath,
    kind
  );

  return spans.some((span) => {
    if (
      !span.exact ||
      from < span.sourceRange.start ||
      to > span.sourceRange.end
    )
      return false;

    const source = docText.slice(span.sourceRange.start, span.sourceRange.end);
    const quote = docText[span.sourceRange.start - 1];
    if (
      (quote === '"' && source.includes("\\")) ||
      (quote === "'" && source.includes("''"))
    )
      return false;

    return !codeRanges.some((range) => from >= range.from && to <= range.to);
  });
}

const promptCodeRangesBySpans = new WeakMap<
  readonly WorkflowTextSpan[],
  ReturnType<WorkflowFileSupport["getPromptCodeRanges"]>
>();

function getCachedPromptCodeRanges(
  spans: readonly WorkflowTextSpan[],
  text: string,
  support: WorkflowFileSupport,
  filePath: string,
  kind: NonNullable<ReturnType<typeof getCtrlYokeFileKind>>
) {
  const cached = promptCodeRangesBySpans.get(spans);
  if (cached) return cached;
  const ranges = support.getPromptCodeRanges(
    text,
    filePath,
    kind === CTRLYOKE_FILE_KINDS.WORKFLOW_YAML
      ? PROMPT_FILE_LANGUAGE_IDS.YAML
      : PROMPT_FILE_LANGUAGE_IDS.MARKDOWN
  );
  promptCodeRangesBySpans.set(spans, ranges);
  return ranges;
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
    type: ATOMIC_REFERENCE_KINDS.SECRET,
    path: "",
    secretName: reference.name,
  }));
  let match: RegExpExecArray | null;

  const collectPathMatches = (
    pattern: RegExp,
    type: WorkspaceFileTreeEntryKind,
    target: WorkspaceReferenceMatch[]
  ) => {
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(text)) !== null) {
      target.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type,
        path: match[1],
      });
    }
  };

  collectPathMatches(
    patterns.fullFileQuoted,
    WORKSPACE_ENTRY_KINDS.FILE,
    fileMatches
  );
  collectPathMatches(
    patterns.fullFile,
    WORKSPACE_ENTRY_KINDS.FILE,
    fileMatches
  );
  collectPathMatches(
    patterns.directoryQuoted,
    WORKSPACE_ENTRY_KINDS.DIRECTORY,
    directoryMatches
  );
  collectPathMatches(
    patterns.directory,
    WORKSPACE_ENTRY_KINDS.DIRECTORY,
    directoryMatches
  );

  const collectLineRangeMatches = (pattern: RegExp) => {
    const regex = new RegExp(pattern.source, pattern.flags);
    while ((match = regex.exec(text)) !== null) {
      lineRangeMatches.push({
        from: offset + match.index,
        to: offset + match.index + match[0].length,
        type: ATOMIC_REFERENCE_KINDS.LINE_RANGE,
        // Group 1 is the quoted path, group 2 the bare one; exactly one is set.
        path: match[1] ?? match[2],
        lineStart: match[3],
        lineEnd: match[4],
      });
    }
  };

  collectLineRangeMatches(patterns.lineRange);

  const collectSymbolMatches = (pattern: RegExp) => {
    const regex = new RegExp(pattern.source, pattern.flags);
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
  return target instanceof HTMLElement
    ? target.closest(".cm-link, .cm-atomic-ref")
    : null;
}

function openWorkspaceReferenceLink(
  target: HTMLElement,
  openToFile: (filePath: string, startLine?: number, endLine?: number) => void,
  openToDirectory: (dirPath: string) => void,
  openSecretsSettings: () => void
): boolean {
  const type = target.getAttribute("data-type");
  if (type === ATOMIC_REFERENCE_KINDS.SECRET) {
    openSecretsSettings();
    return true;
  }
  const path = target.getAttribute("data-path");
  if (!type || !path) return false;

  if (type === WORKSPACE_ENTRY_KINDS.DIRECTORY) {
    openToDirectory(path);
    return true;
  }

  if (type === ATOMIC_REFERENCE_KINDS.LINE_RANGE) {
    const lineStart = target.getAttribute("data-line-start");
    const lineEnd = target.getAttribute("data-line-end");
    openToFile(
      path,
      lineStart ? parseInt(lineStart, 10) : undefined,
      lineEnd ? parseInt(lineEnd, 10) : undefined
    );
    return true;
  }

  if (type === ATOMIC_REFERENCE_KINDS.SYMBOL) {
    const lineStart = target.getAttribute("data-line-start");
    const lineEnd = target.getAttribute("data-line-end");
    openToFile(
      path,
      lineStart ? parseInt(lineStart, 10) : undefined,
      lineEnd ? parseInt(lineEnd, 10) : undefined
    );
    return true;
  }

  if (type === WORKSPACE_ENTRY_KINDS.FILE) {
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
