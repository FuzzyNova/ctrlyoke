import { create } from "zustand";
import type {
  WorkspaceEntry,
  SourceControlFile,
  DiffKind,
} from "@root/types/HostedWorkspaceViewerTypes";

// ============================================================================
// State
// ============================================================================

interface WorkspaceViewerState {
  isOpen: boolean;
  activeTab: "explorer" | "sourceControl";

  // Explorer
  explorerPath: string;
  explorerEntries: WorkspaceEntry[];
  explorerLoading: boolean;

  // File editor
  selectedFilePath: string | null;
  fileContent: string;
  originalFileContent: string;
  fileDirty: boolean;
  fileLoading: boolean;
  fileSaving: boolean;
  fileReadOnly: boolean;
  fileReadOnlyReason: string | undefined;

  // Dirty-exit guard
  dirtyExitPending: boolean;
  dirtyExitAction: (() => void) | null;

  // Mobile: in explorer tab, whether the file editor is shown (vs directory list)
  mobileEditorVisible: boolean;

  // Source control
  sourceControlFiles: SourceControlFile[];
  sourceControlLoading: boolean;
  selectedDiffPath: string | null;
  diffOldContent: string;
  diffNewContent: string;
  diffLanguage: string | undefined;
  diffKind: DiffKind | null;
  diffLoading: boolean;

  // Commit area
  commitMessage: string;
  committing: boolean;
  pushing: boolean;
  pulling: boolean;
  scmError: string | null;

  // General
  error: string | null;
}

// ============================================================================
// Actions
// ============================================================================

interface WorkspaceViewerActions {
  // Modal control
  open(): void;
  close(): void;
  setActiveTab(tab: "explorer" | "sourceControl"): void;

  // Explorer
  setExplorerPath(path: string): void;
  setExplorerEntries(entries: WorkspaceEntry[]): void;
  setExplorerLoading(loading: boolean): void;

  // File editor
  selectFile(path: string): void;
  setFileContent(content: string): void;
  setOriginalFileContent(content: string): void;
  setFileLoading(loading: boolean): void;
  setFileSaving(saving: boolean): void;
  setFileReadOnly(readOnly: boolean, reason?: string): void;
  clearFile(): void;

  // Dirty-exit guard
  promptDirtyExit(action: () => void): void;
  confirmDirtyExit(): void;
  cancelDirtyExit(): void;

  // Mobile editor visibility
  setMobileEditorVisible(v: boolean): void;

  // Source control
  setSourceControlFiles(files: SourceControlFile[]): void;
  setSourceControlLoading(loading: boolean): void;
  selectDiff(path: string | null): void;
  setDiffData(
    oldContent: string,
    newContent: string,
    language: string | undefined,
    kind: DiffKind
  ): void;
  setDiffLoading(loading: boolean): void;
  setCommitMessage(msg: string): void;
  setCommitting(v: boolean): void;
  setPushing(v: boolean): void;
  setPulling(v: boolean): void;
  setScmError(err: string | null): void;
  setError(err: string | null): void;
}

// ============================================================================
// Initial state
// ============================================================================

const INITIAL_STATE: WorkspaceViewerState = {
  isOpen: false,
  activeTab: "explorer",

  explorerPath: "",
  explorerEntries: [],
  explorerLoading: false,

  selectedFilePath: null,
  fileContent: "",
  originalFileContent: "",
  fileDirty: false,
  fileLoading: false,
  fileSaving: false,
  fileReadOnly: false,
  fileReadOnlyReason: undefined,

  dirtyExitPending: false,
  dirtyExitAction: null,

  mobileEditorVisible: false,

  sourceControlFiles: [],
  sourceControlLoading: false,
  selectedDiffPath: null,
  diffOldContent: "",
  diffNewContent: "",
  diffLanguage: undefined,
  diffKind: null,
  diffLoading: false,

  commitMessage: "",
  committing: false,
  pushing: false,
  pulling: false,
  scmError: null,

  error: null,
};

// ============================================================================
// Store
// ============================================================================

export const useWorkspaceViewerStore = create<
  WorkspaceViewerState & WorkspaceViewerActions
>((set, get) => ({
  ...INITIAL_STATE,

  // --- Modal control ---

  open() {
    set({ isOpen: true });
  },

  close() {
    set({ ...INITIAL_STATE });
  },

  setActiveTab(tab) {
    set({ activeTab: tab });
  },

  // --- Explorer ---

  setExplorerPath(path) {
    set({ explorerPath: path });
  },

  setExplorerEntries(entries) {
    set({ explorerEntries: entries });
  },

  setExplorerLoading(loading) {
    set({ explorerLoading: loading });
  },

  // --- File editor ---

  selectFile(path) {
    set({
      selectedFilePath: path,
      fileContent: "",
      originalFileContent: "",
      fileDirty: false,
      fileReadOnly: false,
      fileReadOnlyReason: undefined,
    });
  },

  setFileContent(content) {
    const { originalFileContent } = get();
    set({ fileContent: content, fileDirty: content !== originalFileContent });
  },

  setOriginalFileContent(content) {
    set({ originalFileContent: content });
  },

  setFileLoading(loading) {
    set({ fileLoading: loading });
  },

  setFileSaving(saving) {
    set({ fileSaving: saving });
  },

  setFileReadOnly(readOnly, reason) {
    set({ fileReadOnly: readOnly, fileReadOnlyReason: readOnly ? reason : undefined });
  },

  clearFile() {
    set({
      selectedFilePath: null,
      fileContent: "",
      originalFileContent: "",
      fileDirty: false,
      fileReadOnly: false,
      fileReadOnlyReason: undefined,
    });
  },

  // --- Dirty-exit guard ---

  promptDirtyExit(action) {
    set({ dirtyExitPending: true, dirtyExitAction: action });
  },

  confirmDirtyExit() {
    const { dirtyExitAction } = get();
    set({ dirtyExitPending: false, dirtyExitAction: null });
    dirtyExitAction?.();
  },

  cancelDirtyExit() {
    set({ dirtyExitPending: false, dirtyExitAction: null });
  },

  // --- Mobile ---

  setMobileEditorVisible(v) {
    set({ mobileEditorVisible: v });
  },

  // --- Source control ---

  setSourceControlFiles(files) {
    set({ sourceControlFiles: files });
  },

  setSourceControlLoading(loading) {
    set({ sourceControlLoading: loading });
  },

  selectDiff(path) {
    set({ selectedDiffPath: path });
  },

  setDiffData(oldContent, newContent, language, kind) {
    set({
      diffOldContent: oldContent,
      diffNewContent: newContent,
      diffLanguage: language,
      diffKind: kind,
    });
  },

  setDiffLoading(loading) {
    set({ diffLoading: loading });
  },

  setCommitMessage(msg) {
    set({ commitMessage: msg });
  },

  setCommitting(v) {
    set({ committing: v });
  },

  setPushing(v) {
    set({ pushing: v });
  },

  setPulling(v) {
    set({ pulling: v });
  },

  setScmError(err) {
    set({ scmError: err });
  },

  setError(err) {
    set({ error: err });
  },
}));
