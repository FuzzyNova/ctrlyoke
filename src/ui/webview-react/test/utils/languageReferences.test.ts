import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearLanguageReferenceCache,
  languageReferenceSymbolName,
  openLanguageReferences,
} from "@utils/languageReferences";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { languageIntelligenceSession, workspaceFile } from "@utils/hostedApi";
import {
  requestLanguageIntelligence,
  withLanguageIntelligenceDocument,
} from "@utils/languageIntelligenceClient";
import { LSP_VIEWER_URI_PREFIX } from "@root/types/HostedWorkspaceViewerTypes";

vi.mock("@utils/hostedApi", () => ({
  languageIntelligenceSession: vi.fn(),
  languageIntelligenceSocketUrl: vi.fn(() => "ws://lsp"),
  workspaceFile: vi.fn(),
}));

vi.mock("@utils/languageIntelligenceClient", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@utils/languageIntelligenceClient")>();
  return {
    ...actual,
    languageIntelligenceDocumentText: vi.fn(() => null),
    requestLanguageIntelligence: vi.fn(),
    withLanguageIntelligenceDocument: vi.fn(
      async (
        _id: string,
        _languageId: string,
        _path: string,
        _url: string,
        _socket: unknown,
        loadContent: () => Promise<string>,
        request: () => Promise<unknown>
      ) => {
        await loadContent();
        return request();
      }
    ),
  };
});

const ORIGIN = { path: "src/a.ts", line: 2, character: 18 };

function location(path: string, line: number, start: number, end: number) {
  return {
    uri: `${LSP_VIEWER_URI_PREFIX}${path}`,
    range: {
      start: { line: line - 1, character: start },
      end: { line: line - 1, character: end },
    },
  };
}

const FILES: Record<string, string> = {
  "src/a.ts": "const x = 1;\nexport function isMobile() {}\n",
  "src/b.ts": "import { isMobile } from './a';\nisMobile();\n",
};

describe("openLanguageReferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearLanguageReferenceCache();
    useWorkspaceViewerStore.getState().reset();
    vi.mocked(languageIntelligenceSession).mockResolvedValue({
      session: { id: "ts", languageId: "typescript", capabilities: {} },
    } as never);
    vi.mocked(workspaceFile).mockImplementation(
      async (path: string) => ({ content: FILES[path] }) as never
    );
    vi.mocked(requestLanguageIntelligence).mockResolvedValue([
      location("src/b.ts", 2, 0, 8),
      location("src/a.ts", 2, 16, 24),
      location("src/b.ts", 1, 9, 17),
    ]);
  });

  it("sorts results by file and line and attaches line previews", async () => {
    await openLanguageReferences(ORIGIN);

    const view = useWorkspaceViewerStore.getState().languageReferences;
    expect(view?.results).toEqual([
      {
        path: "src/a.ts",
        line: 2,
        startCharacter: 16,
        endCharacter: 24,
        preview: "export function isMobile() {}",
      },
      {
        path: "src/b.ts",
        line: 1,
        startCharacter: 9,
        endCharacter: 17,
        preview: "import { isMobile } from './a';",
      },
      {
        path: "src/b.ts",
        line: 2,
        startCharacter: 0,
        endCharacter: 8,
        preview: "isMobile();",
      },
    ]);
    expect(requestLanguageIntelligence).toHaveBeenCalledWith(
      "ts",
      "textDocument/references",
      expect.objectContaining({
        position: { line: 1, character: 18 },
        context: { includeDeclaration: true },
      })
    );
    expect(languageReferenceSymbolName(ORIGIN, view?.results ?? [])).toBe(
      "isMobile"
    );
  });

  it("reuses cached results when a route restores the same origin", async () => {
    await openLanguageReferences(ORIGIN);
    useWorkspaceViewerStore.getState().clearLanguageReferences();

    await openLanguageReferences(ORIGIN, { path: "src/b.ts", line: 2 });

    expect(withLanguageIntelligenceDocument).toHaveBeenCalledTimes(1);
    const view = useWorkspaceViewerStore.getState().languageReferences;
    expect(view?.results).toHaveLength(3);
    expect(view?.selected).toEqual({ path: "src/b.ts", line: 2 });
  });

  it("re-runs the query when forced", async () => {
    await openLanguageReferences(ORIGIN);
    await openLanguageReferences(ORIGIN, null, { force: true });
    expect(withLanguageIntelligenceDocument).toHaveBeenCalledTimes(2);
  });

  it("reports when no language server serves the origin", async () => {
    vi.mocked(languageIntelligenceSession).mockResolvedValue({
      session: null,
    } as never);
    await openLanguageReferences(ORIGIN);
    const view = useWorkspaceViewerStore.getState().languageReferences;
    expect(view?.results).toEqual([]);
    expect(view?.error).toMatch(/not available/);
  });
});
