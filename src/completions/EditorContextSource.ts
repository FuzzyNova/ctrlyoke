export interface EditorSelection {
  viewerPath: string;
  startLine: number;
  endLine: number;
  text: string;
  isOutput: boolean;
  visibleEditorCount?: number;
  outputChannel?: string;
  captureId?: string;
}

export interface VisibleOutputChannel {
  viewerPath: string;
  channel: string;
  text: string;
  captureId?: string;
}

/** Optional access to live editor state. Headless hosts provide no source. */
export interface EditorContextSource {
  getSelections(): EditorSelection[];
  getVisibleOutputChannels(): VisibleOutputChannel[];
}
