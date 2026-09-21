export interface HistorySearchMatch {
  index: number;
  length: number;
}

export interface HistorySearchMatcher {
  find(text: string): HistorySearchMatch | undefined;
  /** A conservative literal required in every possible match, if one exists. */
  readonly requiredLiteral?: string;
}

export class SubstringHistorySearchMatcher implements HistorySearchMatcher {
  readonly requiredLiteral: string;
  private readonly loweredQuery: string;

  constructor(query: string) {
    this.requiredLiteral = query;
    this.loweredQuery = query.toLowerCase();
  }

  find(text: string): HistorySearchMatch | undefined {
    const index = text.toLowerCase().indexOf(this.loweredQuery);
    if (index === -1) {
      return undefined;
    }
    return { index, length: this.requiredLiteral.length };
  }
}

export function createHistorySearchMatcher(
  query: string,
  regex: boolean
): HistorySearchMatcher {
  if (regex) {
    throw new Error("Regex history search is not implemented yet");
  }
  return new SubstringHistorySearchMatcher(query);
}
