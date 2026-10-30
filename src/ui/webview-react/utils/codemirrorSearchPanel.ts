import {
  EditorView,
  runScopeHandlers,
  type Panel,
  type ViewUpdate,
} from "@codemirror/view";
import type { EditorState } from "@codemirror/state";
import {
  SearchQuery,
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  search,
  selectMatches,
  setSearchQuery,
} from "@codemirror/search";
import {
  EXIT_BUTTON_CLASS,
  EXIT_BUTTON_ICON_CLASS,
} from "@components/shared/ExitButton";
import { KEYBOARD_KEYS } from "@root/types/DashboardConstants";

/** Marker class on the panel root; styles nothing in globals.css. */
const SEARCH_PANEL_CLASS = "cy-cm-find";

/** Counting stops here so a one-character query in a huge file stays cheap. */
export const SEARCH_MATCH_COUNT_LIMIT = 9999;

// Whether the replace row is expanded, remembered per editor across closes the
// way VS Code remembers it per editor group.
const replaceExpandedByView = new WeakMap<EditorView, boolean>();

const ICON_BUTTON_CLASS = "icon-btn cy-find-widget-button";

// Wraps onto a second line in a narrow editor rather than squeezing the input.
// Start-aligned so the shorter replace row sits right beside its input.
const CONTROLS_CLASS = "flex flex-wrap items-center gap-0.5";

export interface SearchMatchCount {
  /** Number of matches found, at most SEARCH_MATCH_COUNT_LIMIT. */
  total: number;
  /** 1-based index of the match the main selection covers, or 0. */
  current: number;
  /** True when counting stopped at SEARCH_MATCH_COUNT_LIMIT. */
  capped: boolean;
}

export function countSearchMatches(
  state: EditorState,
  query: SearchQuery
): SearchMatchCount {
  const count: SearchMatchCount = { total: 0, current: 0, capped: false };
  if (!query.search || !query.valid) return count;
  const main = state.selection.main;
  const cursor = query.getCursor(state);
  for (let next = cursor.next(); !next.done; next = cursor.next()) {
    count.total++;
    if (next.value.from === main.from && next.value.to === main.to) {
      count.current = count.total;
    }
    if (count.total >= SEARCH_MATCH_COUNT_LIMIT) {
      count.capped = true;
      break;
    }
  }
  return count;
}

/** Same wording as the output pane's find bar: "2 of 5", "0". */
export function formatSearchMatchCount(count: SearchMatchCount): string {
  if (count.total === 0) return "0";
  const total = count.capped ? `${count.total}+` : `${count.total}`;
  return `${count.current > 0 ? count.current : "?"} of ${total}`;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  attributes: Record<string, string> = {}
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value);
  }
  return node;
}

function codicon(name: string, className = ""): HTMLElement {
  return element("i", `codicon codicon-${name} ${className}`.trim(), {
    "aria-hidden": "true",
  });
}

function iconButton(
  icon: string,
  label: string,
  onClick: () => void,
  className = ICON_BUTTON_CLASS,
  iconClassName = ""
): HTMLButtonElement {
  const button = element("button", className, {
    type: "button",
    title: label,
    "aria-label": label,
  });
  button.append(codicon(icon, iconClassName));
  button.addEventListener("click", onClick);
  return button;
}

/**
 * VS Code-style replacement for @codemirror/search's default panel: the same
 * `.cy-find-widget` controls as the output pane's find bar, docked above the
 * text as a CodeMirror top panel so it pushes the document down instead of
 * covering its first lines, with icon toggles for case, whole word and regex
 * and a collapsible replace row. Commands, keymap and highlighting are still
 * @codemirror/search's own; only the panel DOM is ours.
 */
class FindWidgetPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  private query: SearchQuery;
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
  private readonly countLabel: HTMLElement;
  private readonly caseToggle: HTMLButtonElement;
  private readonly wordToggle: HTMLButtonElement;
  private readonly regexpToggle: HTMLButtonElement;
  private readonly replaceToggle: HTMLButtonElement | null;
  private readonly replaceRow: HTMLElement[];

  constructor(private readonly view: EditorView) {
    this.query = getSearchQuery(view.state);
    const canReplace = !view.state.readOnly;

    this.searchField = element("input", "cy-find-widget-input", {
      type: "text",
      placeholder: "Find",
      "aria-label": "Find",
      // openSearchPanel focuses and selects the field carrying this attribute
      // when the panel is already open.
      "main-field": "true",
    });
    this.searchField.value = this.query.search;
    this.searchField.addEventListener("input", () =>
      this.commit({ search: this.searchField.value })
    );

    this.replaceField = element("input", "cy-find-widget-input", {
      type: "text",
      placeholder: "Replace",
      "aria-label": "Replace",
    });
    this.replaceField.value = this.query.replace;
    this.replaceField.addEventListener("input", () =>
      this.commit({ replace: this.replaceField.value })
    );

    this.countLabel = element("span", "cy-find-widget-count px-1", {
      "aria-live": "polite",
    });

    this.caseToggle = this.optionToggle("case-sensitive", "Match case", () =>
      this.commit({ caseSensitive: !this.query.caseSensitive })
    );
    this.wordToggle = this.optionToggle("whole-word", "Match whole word", () =>
      this.commit({ wholeWord: !this.query.wholeWord })
    );
    this.regexpToggle = this.optionToggle(
      "regex",
      "Use regular expression",
      () => this.commit({ regexp: !this.query.regexp })
    );

    const findControls = element("div", CONTROLS_CLASS);
    findControls.append(
      this.countLabel,
      iconButton("arrow-up", "Previous match (Shift+Enter)", () =>
        findPrevious(view)
      ),
      iconButton("arrow-down", "Next match (Enter)", () => findNext(view)),
      this.caseToggle,
      this.wordToggle,
      this.regexpToggle,
      iconButton(
        "close",
        "Close (Escape)",
        () => closeSearchPanel(view),
        `${EXIT_BUTTON_CLASS} shrink-0`,
        EXIT_BUTTON_ICON_CLASS
      )
    );

    const replaceControls = element("div", CONTROLS_CLASS);
    replaceControls.append(
      iconButton("replace", "Replace (Enter)", () => replaceNext(view)),
      iconButton("replace-all", "Replace all (Ctrl+Alt+Enter)", () =>
        replaceAll(view)
      )
    );

    // One grid for both rows so the find and replace inputs share a width.
    // The controls column takes what it needs first; the input keeps at
    // least 8rem and gets the rest, up to the grid's cap on wide editors.
    const rows = element(
      "div",
      "grid min-w-0 max-w-[40rem] flex-1 grid-cols-[minmax(8rem,1fr)_minmax(0,auto)] items-center gap-x-1 gap-y-1"
    );
    rows.append(this.searchField, findControls);
    this.replaceRow = canReplace ? [this.replaceField, replaceControls] : [];
    rows.append(...this.replaceRow);

    this.replaceToggle = canReplace
      ? iconButton("chevron-right", "Toggle replace", () =>
          this.setReplaceExpanded(!this.replaceExpanded)
        )
      : null;

    this.dom = element("div", `cy-find-widget ${SEARCH_PANEL_CLASS}`, {
      role: "search",
    });
    this.dom.append(...(this.replaceToggle ? [this.replaceToggle] : []), rows);
    this.dom.addEventListener("keydown", (event) => this.keydown(event));

    this.syncToggles();
    this.setReplaceExpanded(replaceExpandedByView.get(view) ?? false);
    this.syncCount();
  }

  mount(): void {
    this.searchField.select();
  }

  update(update: ViewUpdate): void {
    // Recount for every query change, including the panel's own commits,
    // which already updated `this.query` before dispatching.
    let queryChanged = false;
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (!effect.is(setSearchQuery)) continue;
        queryChanged = true;
        if (!effect.value.eq(this.query)) this.setQuery(effect.value);
      }
    }
    if (queryChanged || update.docChanged || update.selectionSet) {
      this.syncCount();
    }
  }

  private get replaceExpanded(): boolean {
    return replaceExpandedByView.get(this.view) ?? false;
  }

  private optionToggle(
    icon: string,
    label: string,
    onClick: () => void
  ): HTMLButtonElement {
    return iconButton(
      icon,
      label,
      onClick,
      `${ICON_BUTTON_CLASS} cy-find-widget-toggle`
    );
  }

  private setReplaceExpanded(expanded: boolean): void {
    if (!this.replaceToggle) return;
    replaceExpandedByView.set(this.view, expanded);
    for (const node of this.replaceRow)
      node.classList.toggle("hidden", !expanded);
    this.replaceToggle.setAttribute("aria-expanded", String(expanded));
    const icon = this.replaceToggle.firstElementChild;
    icon?.classList.toggle("codicon-chevron-down", expanded);
    icon?.classList.toggle("codicon-chevron-right", !expanded);
    if (expanded) this.replaceField.focus();
  }

  private commit(
    change: Partial<
      Pick<
        SearchQuery,
        "search" | "replace" | "caseSensitive" | "wholeWord" | "regexp"
      >
    >
  ): void {
    const query = new SearchQuery({
      search: this.query.search,
      replace: this.query.replace,
      caseSensitive: this.query.caseSensitive,
      wholeWord: this.query.wholeWord,
      regexp: this.query.regexp,
      literal: this.query.literal,
      ...change,
    });
    if (query.eq(this.query)) return;
    this.query = query;
    this.syncToggles();
    this.view.dispatch({ effects: setSearchQuery.of(query) });
  }

  private setQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.syncToggles();
  }

  private syncToggles(): void {
    this.caseToggle.setAttribute(
      "aria-pressed",
      String(this.query.caseSensitive)
    );
    this.wordToggle.setAttribute("aria-pressed", String(this.query.wholeWord));
    this.regexpToggle.setAttribute("aria-pressed", String(this.query.regexp));
    this.searchField.setAttribute(
      "aria-invalid",
      String(Boolean(this.query.search) && !this.query.valid)
    );
  }

  private syncCount(): void {
    this.countLabel.textContent = formatSearchMatchCount(
      countSearchMatches(this.view.state, this.query)
    );
  }

  private keydown(event: KeyboardEvent): void {
    // Escape, Mod-f, F3 and the rest of searchKeymap's panel-scoped bindings.
    if (runScopeHandlers(this.view, event, "search-panel")) {
      event.preventDefault();
      return;
    }
    if (event.key !== KEYBOARD_KEYS.ENTER) return;
    if (event.target === this.searchField) {
      event.preventDefault();
      if (event.altKey) selectMatches(this.view);
      else if (event.shiftKey) findPrevious(this.view);
      else findNext(this.view);
    } else if (event.target === this.replaceField) {
      event.preventDefault();
      if ((event.ctrlKey || event.metaKey) && event.altKey) {
        replaceAll(this.view);
      } else {
        replaceNext(this.view);
      }
    }
  }
}

// The widget is docked: CodeMirror reserves the top panel's height above the
// text, so the first line stays visible below it and scrollIntoView already
// keeps a revealed match clear of it. Docked, it drops the floating card's
// corners and shadow for a single divider, and `.cm-panels` loses its own
// default background and silver border so only the widget's surface shows.
// The `:has()` keeps any other top panel styled as usual.
const searchPanelTheme = EditorView.baseTheme({
  ".cm-panels.cm-panels-top:has(> .cy-cm-find)": {
    border: "none",
    backgroundColor: "transparent",
  },
  [`.cm-panel.${SEARCH_PANEL_CLASS}`]: {
    borderRadius: "0",
    borderTopWidth: "0",
    borderLeftWidth: "0",
    borderRightWidth: "0",
    boxShadow: "none",
  },
});

/** CodeMirror search configured with ctrlyoke's docked find widget. */
export function createSearchPanelExtension() {
  return [
    search({
      top: true,
      createPanel: (view) => new FindWidgetPanel(view),
    }),
    searchPanelTheme,
  ];
}
