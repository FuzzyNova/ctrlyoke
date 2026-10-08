import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useEditorStore } from "@store/editorStore";
import { buildSelectionReference } from "@root/completions/ContextReferenceBuilder";
import { PROMPT_EDITOR_INSERT_MODES } from "@root/types/DashboardConstants";

export function formatLanguageReference(
  path: string,
  startLine: number,
  endLine: number
): string {
  return `${path}#L${startLine}-L${endLine}`;
}

export function WorkspaceLanguageReferencesPanel() {
  const references = useWorkspaceViewerStore(
    (state) => state.languageReferences
  );
  const setReferences = useWorkspaceViewerStore(
    (state) => state.setLanguageReferences
  );
  const openToFile = useWorkspaceViewerStore((state) => state.openToFile);
  if (!references) return null;

  return (
    <section
      className="absolute inset-y-0 right-0 z-20 flex w-full max-w-md flex-col border-l border-panel-border bg-sidebar-bg shadow-xl"
      aria-label="References"
    >
      <header className="flex items-center justify-between border-b border-panel-border px-3 py-2">
        <h2 className="font-medium">References ({references.length})</h2>
        <button
          type="button"
          className="cy-button"
          aria-label="Close references"
          onClick={() => setReferences(null)}
        >
          ×
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        {references.length === 0 ? (
          <p className="p-3 text-description-fg">No references found.</p>
        ) : (
          references.map((reference, index) => {
            const label = formatLanguageReference(
              reference.path,
              reference.startLine,
              reference.endLine
            );
            return (
              <div
                key={`${reference.path}:${reference.startLine}:${index}`}
                className="flex items-center gap-2 border-b border-panel-border px-3 py-2"
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left hover:underline"
                  title={label}
                  onClick={() => {
                    setReferences(null);
                    openToFile(
                      reference.path,
                      reference.startLine,
                      reference.endLine
                    );
                  }}
                >
                  {label}
                </button>
                <button
                  type="button"
                  className="cy-button shrink-0"
                  title="Add reference to ctrlyoke"
                  aria-label={`Add ${label} to ctrlyoke`}
                  onClick={() => {
                    const editor = useEditorStore.getState();
                    editor.preparePromptEditorForInsert();
                    editor.enqueuePromptEditorInsert({
                      requestId: `language-reference-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                      references: [
                        buildSelectionReference(
                          reference.path,
                          reference.startLine,
                          reference.endLine
                        ),
                      ],
                      mode: PROMPT_EDITOR_INSERT_MODES.APPEND,
                    });
                  }}
                >
                  Add
                </button>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
