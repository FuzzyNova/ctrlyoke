import React from "react";
import { useEditorStore } from "@store/editorStore";
import { countTokens } from "@utils/tokenizer";

export const EditorFooter: React.FC = () => {
  const { promptText } = useEditorStore();

  const tokenCount = countTokens(promptText);
  const charCount = promptText.length;
  const lineCount = promptText.split("\n").length;

  return (
    <div className="flex items-center justify-between px-3 py-1 border-t border-[var(--vscode-panel-border)] bg-[var(--vscode-statusBar-background)] text-[var(--vscode-statusBar-foreground)]">
      <div className="flex items-center gap-4 text-xs">
        {/* Token count */}
        <div className="flex items-center gap-1">
          <i className="codicon codicon-symbol-misc"></i>
          <span>{tokenCount} tokens</span>
        </div>

        {/* Character count */}
        <div className="flex items-center gap-1">
          <i className="codicon codicon-symbol-text"></i>
          <span>{charCount} chars</span>
        </div>

        {/* Line count */}
        <div className="flex items-center gap-1">
          <i className="codicon codicon-list-ordered"></i>
          <span>{lineCount} lines</span>
        </div>
      </div>

      {/* Status indicators (right side) */}
      <div className="flex items-center gap-3 text-xs">
        {/* Spell check status */}
        <div className="flex items-center gap-1">
          <i className="codicon codicon-check-all"></i>
          <span>Spell check active</span>
        </div>
      </div>
    </div>
  );
};
