import { useEffect, useRef } from "react";
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { Annotation, Compartment, EditorState, Prec } from "@codemirror/state";
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

export interface SingleLineCompletionEditorProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /**
   * Classes for the wrapper div this editor mounts into (e.g. `border`,
   * `rounded`, `bg-input-bg`). Single-line mode fixes its own height (see
   * `singleLineTheme`), while multiline mode lets this wrapper's height
   * determine the visible editor size. Both modes pad their content
   * horizontally via `.cm-line` — do not add `py-*`/`px-*` here.
   */
  className?: string;
  multiline?: boolean;
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
const singleLineTheme = EditorView.theme({
  "&": {
    height: "26px",
    minHeight: "26px",
    maxHeight: "26px",
    overflow: "hidden",
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
  view.dispatch(
    view.state.replaceSelection(replaceNewlines(text, multiline))
  );
  return true;
}

function syncDocument(view: EditorView, value: string, multiline: boolean): void {
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

export function SingleLineCompletionEditor({
  id,
  value,
  onChange,
  onBlur,
  placeholder: placeholderText,
  disabled = false,
  className,
  multiline = false,
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
        multiline ? multilineTheme : singleLineTheme,
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
      ],
    });

    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, [multiline]);

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
