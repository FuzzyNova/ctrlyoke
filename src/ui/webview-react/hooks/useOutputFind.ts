import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
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

export function useOutputFind(
  rows: OutputRenderRow[],
  onRevealRow: (rowIndex: number) => void,
  externalQuery?: string | null
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
      onRevealRow(match.rowIndex);
      requestAnimationFrame(() => {
        onRevealRow(match.rowIndex);
      });
    },
    [onRevealRow]
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
    (query: string, caseSensitive = stateRef.current.caseSensitive) => {
      const nextMatches = findOutputMatches(rows, query, caseSensitive);
      setState((previous) => ({
        ...previous,
        query,
        matchCount: nextMatches.length,
        currentMatch: nextMatches.length > 0 ? 1 : 0,
        caseSensitive,
      }));
      revealMatch(nextMatches[0]);
      return nextMatches;
    },
    [revealMatch, rows]
  );

  const open = useCallback(
    (query?: string) => {
      const nextQuery = query ?? stateRef.current.query;
      setState((previous) => ({
        ...previous,
        isOpen: true,
        query: nextQuery,
      }));
      if (nextQuery) {
        search(nextQuery, stateRef.current.caseSensitive);
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
    if (externalQuery && externalQuery.trim()) {
      open(externalQuery);
    }
  }, [externalQuery, open]);

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
