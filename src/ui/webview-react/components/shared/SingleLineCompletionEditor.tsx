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
import { keyboardTooltipSpace } from "@utils/keyboardTooltipSpace";

export interface SingleLineCompletionEditorProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
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

const singleLineTheme = EditorView.theme({
  "&": {
    height: "28px",
    minHeight: "28px",
    maxHeight: "28px",
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

function replaceNewlines(text: string): string {
  return text.replace(/[\r\n]/g, "");
}

function handlePaste(event: ClipboardEvent, view: EditorView): boolean {
  const text = event.clipboardData?.getData("text/plain");
  if (text === undefined) return false;

  event.preventDefault();
  view.dispatch(view.state.replaceSelection(replaceNewlines(text)));
  return true;
}

function syncDocument(view: EditorView, value: string): void {
  const nextValue = replaceNewlines(value);
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
      doc: replaceNewlines(valueRef.current),
      parent,
      extensions: [
        minimalSetup,
        singleLineTransactionFilter,
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
              run: (editorView) =>
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
        createThemeExtension("input"),
        singleLineTheme,
        tooltips({ parent: document.body, tooltipSpace: keyboardTooltipSpace }),
        EditorView.domEventHandlers({
          blur: () => {
            onBlurRef.current?.();
            return false;
          },
          paste: handlePaste,
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
  }, []);

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
    if (view) syncDocument(view, value);
  }, [value]);

  return <div ref={editorRef} className={className} />;
}
