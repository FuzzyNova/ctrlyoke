import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { OutputMessageTarget } from "@utils/outputProjection";
import type { OutputRenderRow } from "@utils/outputRows";
import {
  findOutputMatches,
  type OutputFindMatch,
  type RowFindDecoration,
} from "@utils/outputFind";

export interface OutputFindState {
  isOpen: boolean;
  query: string;
  matchCount: number;
  currentMatch: number;
  caseSensitive: boolean;
}

const INITIAL_STATE: OutputFindState = {
  isOpen: false,
  query: "",
  matchCount: 0,
  currentMatch: 0,
  caseSensitive: false,
};

export interface OutputFindOpenRequest {
  query: string;
  preferredTarget?: OutputMessageTarget | null;
}

function areOutputMessageTargetsEqual(
  left: OutputMessageTarget | undefined,
  right: OutputMessageTarget | null | undefined
): boolean {
  return !!left && !!right && left.kind === right.kind && left.index === right.index;
}

function getInitialMatchIndex(
  matches: readonly OutputFindMatch[],
  preferredTarget?: OutputMessageTarget | null
): number {
  if (!preferredTarget) {
    return 0;
  }

  const preferredIndex = matches.findIndex((match) =>
    areOutputMessageTargetsEqual(match.target, preferredTarget)
  );
  return preferredIndex >= 0 ? preferredIndex : 0;
}

export function useOutputFind(
  rows: OutputRenderRow[],
  onRevealMatch: (match: OutputFindMatch) => void,
  externalRequest?: OutputFindOpenRequest | null
) {
  const [state, setState] = useState<OutputFindState>(INITIAL_STATE);
  const stateRef = useRef<OutputFindState>(INITIAL_STATE);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const revealMatch = useCallback(
    (match: OutputFindMatch | undefined) => {
      if (!match) {
        return;
      }
      onRevealMatch(match);
      requestAnimationFrame(() => {
        onRevealMatch(match);
      });
    },
    [onRevealMatch]
  );

  const matches = useMemo(
    () => findOutputMatches(rows, state.query, state.caseSensitive),
    [rows, state.query, state.caseSensitive]
  );

  // Keep matchCount/currentMatch in sync as rows/query/caseSensitive change,
  // preserving the current position when it's still valid. This must never
  // reveal a row - jumping the viewport only happens in response to an
  // explicit search/open/navigate so the user can scroll freely otherwise.
  useEffect(() => {
    setState((previous) => {
      const nextMatchCount = matches.length;
      let nextCurrentMatch = previous.currentMatch;
      if (nextMatchCount === 0) {
        nextCurrentMatch = 0;
      } else if (nextCurrentMatch < 1 || nextCurrentMatch > nextMatchCount) {
        nextCurrentMatch = 1;
      }

      if (
        previous.matchCount === nextMatchCount &&
        previous.currentMatch === nextCurrentMatch
      ) {
        return previous;
      }

      return {
        ...previous,
        matchCount: nextMatchCount,
        currentMatch: nextCurrentMatch,
      };
    });
  }, [matches]);

  const search = useCallback(
    (
      query: string,
      caseSensitive = stateRef.current.caseSensitive,
      options?: { preferredTarget?: OutputMessageTarget | null }
    ) => {
      const nextMatches = findOutputMatches(rows, query, caseSensitive);
      const nextMatchIndex = getInitialMatchIndex(
        nextMatches,
        options?.preferredTarget
      );
      setState((previous) => ({
        ...previous,
        query,
        matchCount: nextMatches.length,
        currentMatch: nextMatches.length > 0 ? nextMatchIndex + 1 : 0,
        caseSensitive,
      }));
      revealMatch(nextMatches[nextMatchIndex]);
      return nextMatches;
    },
    [revealMatch, rows]
  );

  const open = useCallback(
    (request?: string | OutputFindOpenRequest) => {
      const nextQuery =
        typeof request === "string"
          ? request
          : request?.query ?? stateRef.current.query;
      setState((previous) => ({
        ...previous,
        isOpen: true,
        query: nextQuery,
      }));
      if (nextQuery) {
        search(nextQuery, stateRef.current.caseSensitive, {
          preferredTarget:
            typeof request === "string" ? undefined : request?.preferredTarget,
        });
      }
    },
    [search]
  );

  const close = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const navigate = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) {
        return;
      }

      const current = stateRef.current.currentMatch;
      const currentZeroBased = current > 0 ? current - 1 : 0;
      const nextIndex =
        (currentZeroBased + direction + matches.length) % matches.length;

      revealMatch(matches[nextIndex]);
      setState((previous) => ({
        ...previous,
        currentMatch: nextIndex + 1,
      }));
    },
    [matches, revealMatch]
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        navigate(event.shiftKey ? -1 : 1);
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }

      if (event.key === "F3") {
        event.preventDefault();
        navigate(event.shiftKey ? -1 : 1);
      }
    },
    [close, navigate]
  );

  const rowDecorations = useMemo(() => {
    const decorations = new Map<string, RowFindDecoration>();
    matches.forEach((match, index) => {
      const decoration = decorations.get(match.rowKey) ?? { matches: [] };
      decoration.matches.push({
        start: match.start,
        end: match.end,
        active: state.currentMatch > 0 && index === state.currentMatch - 1,
      });
      decorations.set(match.rowKey, decoration);
    });
    return decorations;
  }, [matches, state.currentMatch]);

  const activeMatch =
    state.currentMatch > 0 ? matches[state.currentMatch - 1] ?? null : null;

  useEffect(() => {
    if (externalRequest?.query.trim()) {
      open(externalRequest);
    }
  }, [externalRequest, open]);

  return {
    state,
    setState,
    search,
    open,
    close,
    navigate,
    handleKeyDown,
    rowDecorations,
    activeMatch,
  };
}
