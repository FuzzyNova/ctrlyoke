import { useEffect, useRef } from "react";
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import {
  Annotation,
  Compartment,
  EditorState,
  Prec,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder,
  repositionTooltips,
  tooltips,
} from "@codemirror/view";
import { minimalSetup } from "codemirror";
import { createThemeExtension } from "@utils/codemirrorTheme";
import type { ThemeExtensionOptions } from "@utils/codemirrorTheme";
import { keyboardTooltipSpace } from "@utils/keyboardTooltipSpace";
import { WebviewLog } from "@utils/logger";

export interface SingleLineCompletionEditorProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Classes for the wrapper div this editor mounts into (e.g. `border`,
   * `rounded-sm`, `bg-input-bg`). Single-line and wrap-single-line modes fix
   * their own height range (see `singleLineTheme`/`wrapSingleLineTheme`),
   * while multiline mode lets this wrapper's height determine the visible
   * editor size. All modes pad their content horizontally via `.cm-line` —
   * do not add `py-*`/`px-*` here.
   */
  className?: string;
  multiline?: boolean;
  /**
   * Single-line semantics (Enter blurs/accepts, real newlines are stripped
   * on type and paste) with visual soft-wrap instead of a horizontal
   * scrollbar: the editor grows from one line up to `wrapSingleLineTheme`'s
   * capped height, then scrolls vertically. Ignored when `multiline` is set.
   */
  wrapSingleLine?: boolean;
  /** Additional CodeMirror extensions for specialized editor variants. */
  extensions?: Extension[];
  /**
   * Overrides the editor font size (any CSS font-size value). Read once at
   * mount; omit to follow the VS Code editor font size.
   */
  fontSize?: string;
  "aria-label"?: string;
  "aria-describedby"?: string;
  completionSource: (
    context: CompletionContext
  ) => Promise<CompletionResult | null> | CompletionResult | null;
}

const externalValueUpdateAnnotation = Annotation.define<boolean>();

const singleLineTransactionFilter = EditorState.transactionFilter.of(
  (transaction) => {
    if (!transaction.docChanged) return transaction;

    let containsNewline = false;
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    transaction.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
      const text = inserted.toString();
      const singleLineText = text.replace(/[\r\n]/g, "");
      containsNewline ||= text !== singleLineText;
      changes.push({
        from: fromA,
        to: toA,
        insert: singleLineText,
      });
    });

    return containsNewline ? { changes } : transaction;
  }
);

// Fixed to 26px (not 28px) so that adding the wrapper's 1px top/bottom
// border (see callers' `border` class) brings the *rendered* total to 28px —
// matching the `h-7` height Tailwind utility used by sibling plain `<input>`
// fields. Callers must not add vertical padding (e.g. `py-1`) to the wrapper
// className: this editor's height is fully fixed here, so any wrapper
// padding only adds extra height on top of it instead of being absorbed.
//
// IMPORTANT — no `overflow` on `&` here. `EditorView.theme({"&": {...}})`
// compiles `&` to a bare `.<generated-class>` selector (see @codemirror/view's
// `buildTheme`/`EditorView.theme`), and `TooltipViewManager` (the same
// module's tooltip-positioning plugin) sets its own tooltip-wrapping
// `container.className = view.themeClasses` — the SAME generated class,
// applied to a completely unrelated element that isn't a descendant of this
// editor at all. Any `overflow` set here leaks onto that container and
// clips the completions dropdown mounted inside it — invisible on desktop,
// where the tooltip stays `position: fixed` (which escapes ordinary
// `overflow` clipping), but on iOS `@codemirror/view` hardcodes tooltips to
// `position: absolute`, which does NOT escape it — clipped to nothing, with
// no visible error, is indistinguishable from "never rendered". `.cm-scroller`
// below (a real *descendant* selector, `cm-scroller` being a literal DOM
// class only this editor's own scroll container carries) is what actually
// needs to clip this field's oversized content, and does so on its own —
// this rule doesn't need its own `overflow` to achieve that.
const singleLineTheme = EditorView.theme({
  "&": {
    height: "26px",
    minHeight: "26px",
    maxHeight: "26px",
  },
  ".cm-scroller": {
    overflow: "hidden",
  },
  ".cm-content": {
    padding: "4px 0",
    whiteSpace: "nowrap",
  },
  ".cm-line": {
    whiteSpace: "nowrap",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
});

const multilineTheme = EditorView.theme({
  ".cm-content": {
    padding: "4px 0",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
});

// Grows from the same 26px single-line baseline up to ~4 lines, then
// scrolls vertically — replaces singleLineTheme's forced nowrap/horizontal
// overflow with soft-wrap while keeping the transaction filter's single
// logical line (no `whiteSpace: nowrap`, unlike singleLineTheme above).
const wrapSingleLineTheme = EditorView.theme({
  "&": {
    height: "auto",
    minHeight: "26px",
    maxHeight: "92px",
  },
  ".cm-scroller": {
    overflowY: "auto",
    overflowX: "hidden",
  },
  ".cm-content": {
    padding: "4px 0",
  },
  ".cm-gutters": {
    display: "none",
  },
  ".cm-activeLine": {
    backgroundColor: "transparent",
  },
});

function replaceNewlines(text: string, multiline: boolean): string {
  return multiline ? text : text.replace(/[\r\n]/g, "");
}

function handlePaste(
  event: ClipboardEvent,
  view: EditorView,
  multiline: boolean
): boolean {
  const text = event.clipboardData?.getData("text/plain");
  if (text === undefined) return false;

  event.preventDefault();
  view.dispatch(view.state.replaceSelection(replaceNewlines(text, multiline)));
  return true;
}

function syncDocument(
  view: EditorView,
  value: string,
  multiline: boolean
): void {
  const nextValue = replaceNewlines(value, multiline);
  const currentValue = view.state.doc.toString();
  if (currentValue === nextValue) return;

  let prefixLength = 0;
  while (
    prefixLength < currentValue.length &&
    prefixLength < nextValue.length &&
    currentValue[prefixLength] === nextValue[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < currentValue.length - prefixLength &&
    suffixLength < nextValue.length - prefixLength &&
    currentValue[currentValue.length - suffixLength - 1] ===
      nextValue[nextValue.length - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  view.dispatch({
    changes: {
      from: prefixLength,
      to: currentValue.length - suffixLength,
      insert: nextValue.slice(prefixLength, nextValue.length - suffixLength),
    },
    annotations: externalValueUpdateAnnotation.of(true),
  });
}

// Mobile-completion-dropdown diagnostics: logs when the completion dropdown
// becomes active and, one frame later — after CodeMirror's own tooltip
// measure/write pass has run — whether the tooltip DOM actually mounted,
// where CodeMirror placed it, and its computed style, so a future clipping
// or positioning regression is diagnosable from the extension-host session
// log (`WebviewLog`) without an attached mobile devtools session.
//
// Context for `tooltipComputedStyle`/`tooltipRect`: `@codemirror/view`
// hardcodes `position: browser.ios ? "absolute" : "fixed"` for tooltips —
// desktop always gets `fixed` (escapes ordinary ancestor `overflow: hidden`
// clipping), iOS always gets `absolute` (does not escape it). A field whose
// own theme leaks an `overflow` rule onto CodeMirror's tooltip-wrapping
// container (see `singleLineTheme`'s comment above) is invisible on iOS
// only, with a valid on-screen `tooltipRect` and no console error — clipped
// to nothing is indistinguishable from "never rendered" without checking
// `tooltipComputedStyle` directly.
function logCompletionDropdownState(
  view: EditorView,
  label: string,
  status: "active" | "pending" | null
): void {
  WebviewLog.debug(`[completions:${label}] status=${status}`);
  if (status !== "active") return;
  requestAnimationFrame(() => {
    const dom = document.querySelector<HTMLElement>(".cm-tooltip-autocomplete");
    const head = view.state.selection.main.head;
    const rect = dom?.getBoundingClientRect();
    const computed = dom ? window.getComputedStyle(dom) : undefined;
    WebviewLog.debug(`[completions:${label}] dropdown activated`, {
      tooltipFound: !!dom,
      tooltipStyleTop: dom?.style.top,
      tooltipRect: rect,
      tooltipComputedStyle: computed
        ? {
            opacity: computed.opacity,
            visibility: computed.visibility,
            display: computed.display,
            zIndex: computed.zIndex,
            position: computed.position,
          }
        : undefined,
      caretCoords: view.coordsAtPos(head),
      scrollDOMRect: view.scrollDOM.getBoundingClientRect(),
      keyboardTooltipSpace: keyboardTooltipSpace(),
      visualViewport: window.visualViewport
        ? {
            width: window.visualViewport.width,
            height: window.visualViewport.height,
            offsetTop: window.visualViewport.offsetTop,
            offsetLeft: window.visualViewport.offsetLeft,
          }
        : null,
    });
  });
}

export function SingleLineCompletionEditor({
  id,
  value,
  onChange,
  onBlur,
  placeholder: placeholderText,
  disabled = false,
  className,
  multiline = false,
  wrapSingleLine = false,
  extensions = [],
  fontSize,
  "aria-label": ariaLabel,
  "aria-describedby": ariaDescribedby,
  completionSource,
}: SingleLineCompletionEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const onBlurRef = useRef(onBlur);
  const completionSourceRef = useRef(completionSource);
  const disabledRef = useRef(disabled);
  const initialPropsRef = useRef({
    id,
    ariaLabel,
    ariaDescribedby,
    placeholderText,
    disabled,
    fontSize,
    extensions,
  });
  const editableCompartmentRef = useRef(new Compartment());
  const contentAttributesCompartmentRef = useRef(new Compartment());

  valueRef.current = value;
  onChangeRef.current = onChange;
  onBlurRef.current = onBlur;
  completionSourceRef.current = completionSource;
  disabledRef.current = disabled;

  useEffect(() => {
    const parent = editorRef.current;
    if (!parent) return;

    const initialProps = initialPropsRef.current;
    const contentAttributes = {
      id: initialProps.id,
      ...(initialProps.ariaLabel
        ? { "aria-label": initialProps.ariaLabel }
        : {}),
      ...(initialProps.ariaDescribedby
        ? { "aria-describedby": initialProps.ariaDescribedby }
        : {}),
      ...(initialProps.disabled ? { "aria-disabled": "true" } : {}),
    };

    const view = new EditorView({
      doc: replaceNewlines(valueRef.current, multiline),
      parent,
      extensions: [
        minimalSetup,
        ...(multiline ? [] : [singleLineTransactionFilter]),
        editableCompartmentRef.current.of([
          EditorState.readOnly.of(initialProps.disabled),
          EditorView.editable.of(!initialProps.disabled),
        ]),
        contentAttributesCompartmentRef.current.of(
          EditorView.contentAttributes.of(contentAttributes)
        ),
        Prec.highest(
          keymap.of([
            {
              key: "Enter",
              run: multiline
                ? acceptCompletion
                : (editorView) =>
                    acceptCompletion(editorView) ||
                    (editorView.contentDOM.blur(), true),
            },
            {
              key: "Tab",
              run: acceptCompletion,
            },
            {
              key: "Escape",
              run: (editorView) => {
                closeCompletion(editorView);
                return true;
              },
            },
          ])
        ),
        placeholder(initialProps.placeholderText ?? ""),
        createThemeExtension("input", {
          fontSize: initialProps.fontSize,
        } satisfies ThemeExtensionOptions),
        multiline
          ? multilineTheme
          : wrapSingleLine
            ? // The theme alone only caps the height: without lineWrapping,
              // `.cm-content` keeps CodeMirror's default `white-space: pre`,
              // so a long value never wraps and its intrinsic width pushes
              // the surrounding settings page off screen instead.
              [wrapSingleLineTheme, EditorView.lineWrapping]
            : singleLineTheme,
        tooltips({ parent: document.body, tooltipSpace: keyboardTooltipSpace }),
        EditorView.domEventHandlers({
          blur: () => {
            onBlurRef.current?.();
            return false;
          },
          paste: (event, editorView) =>
            handlePaste(event, editorView, multiline),
        }),
        autocompletion({
          override: [
            (context) =>
              disabledRef.current ? null : completionSourceRef.current(context),
          ],
        }),
        ...initialProps.extensions,
        EditorView.updateListener.of((update) => {
          if (!update.docChanged) return;
          if (
            update.transactions.some((transaction) =>
              transaction.annotation(externalValueUpdateAnnotation)
            )
          ) {
            return;
          }
          onChangeRef.current(update.state.doc.toString());
        }),
        EditorView.updateListener.of((update) => {
          const status = completionStatus(update.state);
          if (status === completionStatus(update.startState)) return;
          logCompletionDropdownState(update.view, initialProps.id, status);
        }),
      ],
    });

    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [multiline, wrapSingleLine]);

  // Remeasure the editor and reposition an already-open completion dropdown
  // when the mobile keyboard changes the visual viewport. requestMeasure alone
  // does not re-run CodeMirror's tooltip measure request.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;

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

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editableCompartmentRef.current.reconfigure([
        EditorState.readOnly.of(disabled),
        EditorView.editable.of(!disabled),
      ]),
    });
  }, [disabled]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: contentAttributesCompartmentRef.current.reconfigure(
        EditorView.contentAttributes.of({
          id,
          ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
          ...(ariaDescribedby ? { "aria-describedby": ariaDescribedby } : {}),
          ...(disabled ? { "aria-disabled": "true" } : {}),
        })
      ),
    });
  }, [ariaDescribedby, ariaLabel, disabled, id]);

  useEffect(() => {
    const view = viewRef.current;
    if (view) syncDocument(view, value, multiline);
  }, [multiline, value]);

  return <div ref={editorRef} className={className} />;
}
