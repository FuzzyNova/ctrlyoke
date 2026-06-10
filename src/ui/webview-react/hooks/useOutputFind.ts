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
  const matchesRef = useRef<OutputFindMatch[]>([]);
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

  const search = useCallback(
    (query: string, caseSensitive = stateRef.current.caseSensitive) => {
      const matches = findOutputMatches(rows, query, caseSensitive);
      matchesRef.current = matches;
      setState((previous) => ({
        ...previous,
        query,
        matchCount: matches.length,
        currentMatch: matches.length > 0 ? 1 : 0,
        caseSensitive,
      }));
      revealMatch(matches[0]);
      return matches;
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
    matchesRef.current = [];
    setState(INITIAL_STATE);
  }, []);

  const navigate = useCallback(
    (direction: 1 | -1) => {
      const matches = matchesRef.current;
      if (matches.length === 0) {
        return;
      }

      setState((previous) => {
        const currentZeroBased =
          previous.currentMatch > 0 ? previous.currentMatch - 1 : 0;
        const nextIndex =
          (currentZeroBased + direction + matches.length) % matches.length;
        revealMatch(matches[nextIndex]);
        return {
          ...previous,
          currentMatch: nextIndex + 1,
        };
      });
    },
    [revealMatch]
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
    matchesRef.current.forEach((match, index) => {
      const decoration = decorations.get(match.rowKey) ?? { matches: [] };
      decoration.matches.push({
        start: match.start,
        end: match.end,
        active: state.currentMatch > 0 && index === state.currentMatch - 1,
      });
      decorations.set(match.rowKey, decoration);
    });
    return decorations;
  }, [state.currentMatch, state.matchCount]);

  const activeMatch =
    state.currentMatch > 0
      ? matchesRef.current[state.currentMatch - 1] ?? null
      : null;

  useEffect(() => {
    if (state.isOpen && state.query) {
      const matches = findOutputMatches(rows, state.query, state.caseSensitive);
      matchesRef.current = matches;
      const nextMatchCount = matches.length;
      const nextCurrentMatch = matches.length > 0 ? 1 : 0;
      setState((previous) => {
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
      revealMatch(matches[0]);
      return;
    }

    if (!state.query) {
      matchesRef.current = [];
      setState((previous) =>
        previous.matchCount === 0 && previous.currentMatch === 0
          ? previous
          : {
              ...previous,
              matchCount: 0,
              currentMatch: 0,
            }
      );
    }
  }, [revealMatch, rows, state.caseSensitive, state.isOpen, state.query]);

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
