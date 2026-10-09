/**
 * "Find All References" for the hosted workspace viewer.
 *
 * A references view is addressed by its origin (the file position the query
 * ran at), so it can be restored from a URL or a back/forward step without an
 * editor open on the origin file: the query opens that file on the language
 * server itself when needed. Results carry each reference's line text so the
 * panel can show how the symbol is used there.
 */
import {
  languageIntelligenceSession,
  languageIntelligenceSocketUrl,
  workspaceFile,
} from "@utils/hostedApi";
import {
  languageIntelligenceDocumentText,
  requestLanguageIntelligence,
  viewerPathFromUri,
  withLanguageIntelligenceDocument,
  workspaceFileUri,
} from "@utils/languageIntelligenceClient";
import type { LspWebSocket } from "@utils/languageIntelligenceTransport";
import {
  useWorkspaceViewerStore,
  type LanguageReferencePosition,
  type LanguageReferenceResult,
  type LanguageReferenceSelection,
} from "@store/workspaceViewerStore";
import { WebviewLog } from "@utils/logger";
import { LSP_METHODS } from "@root/types/DashboardConstants";

interface LspLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

const UNAVAILABLE_MESSAGE =
  "Language intelligence is not available for this file.";

/** Results of recent queries, so back/forward does not re-run them. */
const RESULT_CACHE_LIMIT = 10;
const resultCache = new Map<string, LanguageReferenceResult[]>();

function originKey(origin: LanguageReferencePosition): string {
  return `${origin.path}:${origin.line}:${origin.character}`;
}

function cacheResults(
  origin: LanguageReferencePosition,
  results: LanguageReferenceResult[]
): void {
  const key = originKey(origin);
  resultCache.delete(key);
  resultCache.set(key, results);
  while (resultCache.size > RESULT_CACHE_LIMIT) {
    const oldest = resultCache.keys().next().value;
    if (oldest === undefined) break;
    resultCache.delete(oldest);
  }
}

/** Test hook: forget cached results between tests. */
export function clearLanguageReferenceCache(): void {
  resultCache.clear();
}

/** Current text of a file: an open editor first, then a draft, then disk. */
async function loadFileText(path: string): Promise<string> {
  const editorText = languageIntelligenceDocumentText(path);
  if (editorText !== null) return editorText;
  const draft = useWorkspaceViewerStore.getState().fileDrafts[path];
  if (draft) return draft.content;
  return (await workspaceFile(path)).content;
}

function toResult(location: LspLocation): LanguageReferenceResult | null {
  const path = viewerPathFromUri(location.uri);
  if (!path) return null;
  const { start, end } = location.range;
  return {
    path,
    line: start.line + 1,
    startCharacter: start.character,
    // A range ending on a later line still highlights only its first line.
    endCharacter:
      end.line === start.line ? end.character : Number.MAX_SAFE_INTEGER,
  };
}

/** Sorted by file, then position, like VS Code's references view. */
function compareResults(
  a: LanguageReferenceResult,
  b: LanguageReferenceResult
): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.line - b.line || a.startCharacter - b.startCharacter;
}

async function withPreviews(
  results: LanguageReferenceResult[]
): Promise<LanguageReferenceResult[]> {
  const paths = [...new Set(results.map((result) => result.path))];
  const linesByPath = new Map<string, string[]>();
  await Promise.all(
    paths.map(async (path) => {
      try {
        linesByPath.set(path, (await loadFileText(path)).split(/\r?\n/));
      } catch (error) {
        WebviewLog.warn(
          `[languageReferences] preview load failed for ${path}: ${String(error)}`
        );
      }
    })
  );
  return results.map((result) => {
    const preview = linesByPath.get(result.path)?.[result.line - 1];
    return preview === undefined ? result : { ...result, preview };
  });
}

async function queryLanguageReferences(
  origin: LanguageReferencePosition
): Promise<LanguageReferenceResult[] | null> {
  const { session } = await languageIntelligenceSession(origin.path);
  if (!session) return null;
  const locations = (await withLanguageIntelligenceDocument(
    session.id,
    session.languageId,
    origin.path,
    languageIntelligenceSocketUrl(session.id),
    (url) => new WebSocket(url) as unknown as LspWebSocket,
    () => loadFileText(origin.path),
    () =>
      requestLanguageIntelligence(session.id, LSP_METHODS.REFERENCES, {
        textDocument: { uri: workspaceFileUri(origin.path) },
        position: { line: origin.line - 1, character: origin.character },
        context: { includeDeclaration: true },
      })
  )) as LspLocation[] | null;
  const results = (locations ?? [])
    .map(toResult)
    .filter((result): result is LanguageReferenceResult => result !== null)
    .sort(compareResults);
  return withPreviews(results);
}

/**
 * Show the references for `origin`, running the query unless its results are
 * already shown or cached. `force` re-runs it, as an explicit Find All
 * References from the editor should.
 */
export async function openLanguageReferences(
  origin: LanguageReferencePosition,
  selected: LanguageReferenceSelection | null = null,
  { force = false }: { force?: boolean } = {}
): Promise<void> {
  const store = useWorkspaceViewerStore.getState();
  if (force) store.clearLanguageReferences();
  store.showLanguageReferences(origin, selected);
  if (!force) {
    if (useWorkspaceViewerStore.getState().languageReferences?.results) return;
    const cached = resultCache.get(originKey(origin));
    if (cached) {
      store.setLanguageReferenceResults(origin, cached);
      return;
    }
  }
  try {
    const results = await queryLanguageReferences(origin);
    if (results === null) {
      store.setLanguageReferenceResults(origin, [], UNAVAILABLE_MESSAGE);
      return;
    }
    cacheResults(origin, results);
    store.setLanguageReferenceResults(origin, results);
  } catch (error) {
    WebviewLog.warn(`[languageReferences] query failed: ${String(error)}`);
    store.setLanguageReferenceResults(origin, [], UNAVAILABLE_MESSAGE);
  }
}

/** The symbol's name, read from the origin's own reference. */
export function languageReferenceSymbolName(
  origin: LanguageReferencePosition,
  results: LanguageReferenceResult[]
): string | null {
  const own = results.find(
    (result) =>
      result.path === origin.path &&
      result.line === origin.line &&
      result.startCharacter <= origin.character &&
      origin.character <= result.endCharacter
  );
  const name = own?.preview?.slice(own.startCharacter, own.endCharacter);
  return name?.trim() ? name : null;
}
