import type { CompletionResult } from "@codemirror/autocomplete";
import { useEffect, useRef } from "react";
import { SingleLineCompletionEditor } from "./SingleLineCompletionEditor";
import { getVsCodeApi } from "@hooks/useVsCodeApi";
import { useCompletionRequest } from "@hooks/useCompletionRequest";
import { MESSAGE_TYPES, type HarnessId } from "@root/types/DashboardConstants";
import type { HarnessFlagCompletionsResponseMessage } from "@root/types/WebviewMessageTypes";
import type { SingleLineCompletionEditorProps } from "./SingleLineCompletionEditor";

type HarnessFlagCompletion =
  HarnessFlagCompletionsResponseMessage["items"][number];

export type AdditionalArgsEditorProps = Omit<
  SingleLineCompletionEditorProps,
  "completionSource" | "placeholder" | "wrapSingleLine"
> & {
  harnessId: HarnessId;
};

// Single-sourced here so every caller shows identical placeholder text
// instead of each passing its own copy that can drift out of sync.
const ADDITIONAL_ARGS_PLACEHOLDER = "e.g. --effort high";

interface CursorArgumentContext {
  prefix: string;
  previousToken?: string;
}

const VALUE_HINT_SECTION = {
  name: "Value hints",
  rank: 1,
};

/**
 * Find the current argument and the token immediately before it. This keeps
 * the same quote and whitespace behavior as the extension-host parser while
 * retaining the information needed to offer a flag's value hints.
 */
function parseCursorArgumentContext(
  text: string,
  position: number
): CursorArgumentContext {
  const cursor = Math.max(0, Math.min(position, text.length));
  const completedTokens: string[] = [];
  let current = "";
  let tokenStarted = false;
  let quote: '"' | "'" | undefined;
  let sawQuote = false;
  let replacementStart = cursor;

  for (let index = 0; index < cursor; index += 1) {
    const character = text[index];

    if (quote === '"') {
      if (character === "\\" && text[index + 1] === '"') {
        current += '"';
        index += 1;
      } else if (character === '"') {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (quote === "'") {
      if (character === "'") {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }

    if (/\s/.test(character)) {
      if (current.length > 0) {
        completedTokens.push(current);
      }
      current = "";
      tokenStarted = false;
      sawQuote = false;
      replacementStart = cursor;
      continue;
    }

    if (!tokenStarted) {
      tokenStarted = true;
      replacementStart = index;
    }

    if (character === '"') {
      quote = '"';
      sawQuote = true;
      if (index === replacementStart) {
        replacementStart = index + 1;
      }
    } else if (character === "'") {
      quote = "'";
      sawQuote = true;
      if (index === replacementStart) {
        replacementStart = index + 1;
      }
    } else {
      current += character;
    }
  }

  return {
    prefix: sawQuote ? current : text.slice(replacementStart, cursor),
    previousToken: completedTokens[completedTokens.length - 1],
  };
}

function parseHarnessFlagCompletionResponse(
  data: unknown
): HarnessFlagCompletionsResponseMessage | null {
  const message = data as Partial<HarnessFlagCompletionsResponseMessage>;
  if (
    message.type !== MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_RESPONSE ||
    typeof message.seq !== "number" ||
    typeof message.from !== "number" ||
    !Array.isArray(message.items)
  ) {
    return null;
  }

  return message as HarnessFlagCompletionsResponseMessage;
}

function findFlagForToken(
  items: readonly HarnessFlagCompletion[],
  token: string | undefined
): HarnessFlagCompletion | undefined {
  if (!token) return undefined;
  return items.find((item) => item.flag === token || item.alias === token);
}

function buildHarnessFlagCompletionResult(
  items: HarnessFlagCompletion[],
  from: number,
  context: CursorArgumentContext,
  cachedItems: readonly HarnessFlagCompletion[]
): CompletionResult {
  const allItems = new Map<string, HarnessFlagCompletion>();
  for (const item of cachedItems) {
    allItems.set(item.flag, item);
  }
  for (const item of items) {
    allItems.set(item.flag, item);
  }

  const previousFlag = findFlagForToken(
    [...allItems.values()],
    context.previousToken
  );
  const valueHints = (previousFlag?.valueHints ?? []).filter((hint) =>
    hint.toLocaleLowerCase().startsWith(context.prefix.toLocaleLowerCase())
  );

  return {
    from,
    // The extension host already filters flag names by the current token.
    // Disabling CodeMirror's fuzzy filtering preserves that authoritative
    // result and lets the value-hint section use the same replacement range.
    filter: false,
    options: [
      ...items.map((item, index) => ({
        label: item.flag,
        detail: item.detail,
        apply: item.flag,
        boost: -index,
      })),
      ...valueHints.map((hint) => ({
        label: hint,
        apply: hint,
        section: VALUE_HINT_SECTION,
      })),
    ],
  };
}

export function AdditionalArgsEditor({
  harnessId,
  ...props
}: AdditionalArgsEditorProps) {
  const vscode = getVsCodeApi();
  const cachedItemsRef = useRef<HarnessFlagCompletion[]>([]);
  const requestContextRef = useRef<CursorArgumentContext | null>(null);

  useEffect(() => {
    // The child editor remounts below, which drops its active completion UI.
    // Clear the source cache as well so flags from the previous harness cannot
    // leak into value-hint completions after a harness switch.
    cachedItemsRef.current = [];
    requestContextRef.current = null;
  }, [harnessId]);

  const completionSource =
    useCompletionRequest<HarnessFlagCompletionsResponseMessage>({
      parseResponse: parseHarnessFlagCompletionResponse,
      buildResult: (response) => {
        const context = requestContextRef.current ?? { prefix: "" };
        const result = buildHarnessFlagCompletionResult(
          response.items,
          response.from,
          context,
          cachedItemsRef.current
        );
        for (const item of response.items) {
          cachedItemsRef.current = [
            ...cachedItemsRef.current.filter(
              (cachedItem) => cachedItem.flag !== item.flag
            ),
            item,
          ];
        }
        return result;
      },
      sendRequest: (context, seq) => {
        const text = context.state.doc.toString();
        requestContextRef.current = parseCursorArgumentContext(
          text,
          context.pos
        );
        vscode.postMessage({
          type: MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_REQUEST,
          harnessId,
          text,
          position: context.pos,
          seq,
        });
      },
    });

  return (
    <SingleLineCompletionEditor
      key={harnessId}
      {...props}
      placeholder={ADDITIONAL_ARGS_PLACEHOLDER}
      wrapSingleLine
      completionSource={completionSource}
    />
  );
}
