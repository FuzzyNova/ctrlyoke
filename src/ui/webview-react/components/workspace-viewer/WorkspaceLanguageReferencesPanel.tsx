import { useMemo, useState } from "react";
import {
  useWorkspaceViewerStore,
  type LanguageReferenceResult,
  type LanguageReferenceSelection,
} from "@store/workspaceViewerStore";
import { useEditorStore } from "@store/editorStore";
import { useIsMobile } from "@hooks/useMediaQuery";
import { languageReferenceSymbolName } from "@utils/languageReferences";
import { buildSelectionReference } from "@root/completions/ContextReferenceBuilder";
import { PROMPT_EDITOR_INSERT_MODES } from "@root/types/DashboardConstants";
import { Icon } from "../shared/Icon";

/** Characters of context kept before the symbol when a line is long. */
const PREVIEW_LEADING_CONTEXT = 24;

interface ReferenceFileGroup {
  path: string;
  references: LanguageReferenceResult[];
}

/** Results arrive sorted by file, so one pass groups them. */
function groupByFile(results: LanguageReferenceResult[]): ReferenceFileGroup[] {
  const groups: ReferenceFileGroup[] = [];
  for (const result of results) {
    const last = groups[groups.length - 1];
    if (last?.path === result.path) last.references.push(result);
    else groups.push({ path: result.path, references: [result] });
  }
  return groups;
}

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0
    ? { name: path, dir: "" }
    : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

/**
 * The reference's line split around the symbol, without its indentation and
 * with leading context trimmed so the symbol stays visible in a narrow panel.
 */
export function referencePreviewParts(
  preview: string,
  startCharacter: number,
  endCharacter: number
): { before: string; match: string; after: string } {
  const start = Math.min(startCharacter, preview.length);
  const indent = preview.length - preview.trimStart().length;
  let from = Math.min(indent, start);
  const trimmed = start - from > PREVIEW_LEADING_CONTEXT;
  if (trimmed) from = start - PREVIEW_LEADING_CONTEXT;
  return {
    before: `${trimmed ? "…" : ""}${preview.slice(from, start)}`,
    match: preview.slice(start, endCharacter),
    after: preview.slice(endCharacter).trimEnd(),
  };
}

function addReferenceToPrompt(reference: LanguageReferenceResult): void {
  const editor = useEditorStore.getState();
  editor.preparePromptEditorForInsert();
  editor.enqueuePromptEditorInsert({
    requestId: `language-reference-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    references: [
      buildSelectionReference(reference.path, reference.line, reference.line),
    ],
    mode: PROMPT_EDITOR_INSERT_MODES.APPEND,
  });
}

function ReferenceRow({
  reference,
  selected,
  onSelect,
}: {
  reference: LanguageReferenceResult;
  selected: boolean;
  onSelect: (selection: LanguageReferenceSelection) => void;
}) {
  const label = `${reference.path}, line ${reference.line}`;
  const parts =
    reference.preview === undefined
      ? null
      : referencePreviewParts(
          reference.preview,
          reference.startCharacter,
          reference.endCharacter
        );
  return (
    <li
      className={`group flex items-center gap-1 pr-2 ${
        selected
          ? "bg-list-active-bg text-list-active-fg"
          : "hover:bg-list-hover-bg"
      }`}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-baseline gap-2 py-0.5 pl-7 text-left"
        title={label}
        aria-label={label}
        aria-current={selected ? "location" : undefined}
        onClick={() => onSelect({ path: reference.path, line: reference.line })}
      >
        <span className="w-8 shrink-0 text-right text-xs tabular-nums text-description-fg">
          {reference.line}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs whitespace-pre">
          {parts ? (
            <>
              {parts.before}
              <mark className="rounded-xs bg-find-match-highlight text-inherit">
                {parts.match}
              </mark>
              {parts.after}
            </>
          ) : (
            <span className="text-description-fg">line {reference.line}</span>
          )}
        </span>
      </button>
      <button
        type="button"
        className="shrink-0 rounded-sm p-0.5 text-description-fg opacity-0 group-hover:opacity-100 hover:bg-toolbar-hover-bg hover:text-foreground focus-visible:opacity-100 max-sm:opacity-100"
        title="Add reference to ctrlyoke"
        aria-label={`Add ${label} to ctrlyoke`}
        onClick={() => addReferenceToPrompt(reference)}
      >
        <Icon name="add" />
      </button>
    </li>
  );
}

export function WorkspaceLanguageReferencesPanel() {
  const liveView = useWorkspaceViewerStore((state) => state.languageReferences);
  const panelOpen = useWorkspaceViewerStore(
    (state) => state.languageReferencesPanelOpen
  );
  const selectReference = useWorkspaceViewerStore(
    (state) => state.selectLanguageReference
  );
  const setPanelOpen = useWorkspaceViewerStore(
    (state) => state.setLanguageReferencesPanelOpen
  );
  const clearReferences = useWorkspaceViewerStore(
    (state) => state.clearLanguageReferences
  );
  const isMobile = useIsMobile();
  const visible = liveView !== null && (!isMobile || panelOpen);

  // On mobile the panel slides out before unmounting, so it keeps rendering
  // the view it last showed until the exit animation ends. Adjusted during
  // render (not in an effect) so the closing frame never paints empty.
  const [shownView, setShownView] = useState(visible ? liveView : null);
  const [closing, setClosing] = useState(false);
  if (visible && (shownView !== liveView || closing)) {
    setShownView(liveView);
    setClosing(false);
  } else if (!visible && shownView !== null && !closing) {
    if (isMobile) setClosing(true);
    else setShownView(null);
  }
  const view = visible ? liveView : closing ? shownView : null;

  const results = view?.results ?? null;
  const groups = useMemo(
    () => (results ? groupByFile(results) : []),
    [results]
  );

  if (!view) return null;

  const symbolName = results
    ? languageReferenceSymbolName(view.origin, results)
    : null;
  const summary = results
    ? `${results.length} ${results.length === 1 ? "result" : "results"} in ${groups.length} ${groups.length === 1 ? "file" : "files"}`
    : "Searching…";

  return (
    <section
      className={`flex flex-col bg-sidebar-bg ${
        isMobile
          ? `absolute inset-0 z-20 ${closing ? "animate-slide-out-right" : "animate-slide-in-right"}`
          : "w-80 shrink-0 border-l border-panel-border xl:w-96"
      }`}
      aria-label="References"
      aria-hidden={closing || undefined}
      onAnimationEnd={(event) => {
        if (!closing || event.currentTarget !== event.target) return;
        setClosing(false);
        setShownView(null);
      }}
    >
      <header className="cy-no-select flex items-center gap-2 border-b border-panel-border px-3 py-1.5">
        {/* Collapse on the far side from Close, like the other drawers. */}
        {isMobile && (
          <button
            type="button"
            className="shrink-0 rounded-sm p-1 text-description-fg hover:bg-toolbar-hover-bg hover:text-foreground"
            title="Hide references"
            aria-label="Hide references"
            onClick={() => setPanelOpen(false)}
          >
            <Icon name="chevron-right" />
          </button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-medium">
            {symbolName ? (
              <>
                References to <code className="font-mono">{symbolName}</code>
              </>
            ) : (
              "References"
            )}
          </h2>
          <p className="truncate text-xs text-description-fg" role="status">
            {summary}
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-sm p-1 text-description-fg hover:bg-toolbar-hover-bg hover:text-foreground"
          title="Clear references"
          aria-label="Close references"
          onClick={clearReferences}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {view.error ? (
          <p className="px-3 py-2 text-sm text-description-fg">{view.error}</p>
        ) : results === null ? (
          <p className="flex items-center gap-2 px-3 py-2 text-sm text-description-fg">
            <Icon name="loading" className="animate-spin" />
            Finding references…
          </p>
        ) : results.length === 0 ? (
          <p className="px-3 py-2 text-sm text-description-fg">
            No references found.
          </p>
        ) : (
          groups.map((group) => {
            const { name, dir } = splitPath(group.path);
            return (
              <section key={group.path} aria-label={group.path}>
                <h3
                  className="cy-no-select flex items-center gap-1.5 px-3 pt-1.5 pb-0.5 text-sm"
                  title={group.path}
                >
                  <Icon name="file" className="shrink-0 text-description-fg" />
                  <span className="shrink-0 font-medium">{name}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-description-fg">
                    {dir}
                  </span>
                  <span className="shrink-0 rounded-full bg-badge-bg px-1.5 text-[10px] leading-4 text-badge-fg">
                    {group.references.length}
                  </span>
                </h3>
                <ul>
                  {group.references.map((reference) => (
                    <ReferenceRow
                      key={`${reference.line}:${reference.startCharacter}`}
                      reference={reference}
                      selected={
                        view.selected?.path === reference.path &&
                        view.selected.line === reference.line
                      }
                      onSelect={selectReference}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}
      </div>
    </section>
  );
}
