import { useEffect, useState } from "react";
import type { Extension } from "@codemirror/state";
import {
  languageIntelligenceSession,
  languageIntelligenceSocketUrl,
} from "@utils/hostedApi";
import { acquireLanguageIntelligenceClient } from "@utils/languageIntelligenceClient";
import type { LspWebSocket } from "@utils/languageIntelligenceTransport";
import { WebviewLog } from "@utils/logger";
import { LSP_SESSION_LOOKUP_REASONS } from "../../../types/DashboardConstants";

export interface LanguageIntelligenceState {
  filePath: string;
  extensions: Extension[];
  sessionId: string | null;
  capabilities: Record<string, unknown>;
  statusHint: string | null;
}

export function useLanguageIntelligence(
  filePath: string
): LanguageIntelligenceState {
  const [state, setState] = useState<LanguageIntelligenceState>({
    filePath,
    extensions: [],
    sessionId: null,
    capabilities: {},
    statusHint: null,
  });
  const [sessionGeneration, setSessionGeneration] = useState(0);

  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    setState({
      filePath,
      extensions: [],
      sessionId: null,
      capabilities: {},
      statusHint: null,
    });

    void languageIntelligenceSession(filePath, controller.signal)
      .then(({ session, reason }) => {
        if (!active) return;
        if (!session) {
          const statusHint =
            (
              {
                [LSP_SESSION_LOOKUP_REASONS.STOPPED]:
                  "Language server is stopped. Restart it in Language Servers settings.",
                [LSP_SESSION_LOOKUP_REASONS.LIMIT_REACHED]:
                  "Language server limit reached. Close another editor or raise the running server limit.",
                [LSP_SESSION_LOOKUP_REASONS.NEEDS_APPROVAL]:
                  "This workspace needs approval to start its language server. Review it in Language Servers settings.",
                [LSP_SESSION_LOOKUP_REASONS.UNTRUSTED]:
                  "Trust this workspace to enable language intelligence.",
              } as Record<string, string>
            )[reason ?? ""] ?? null;
          setState({
            filePath,
            extensions: [],
            sessionId: null,
            capabilities: {},
            statusHint,
          });
          return;
        }
        const acquired = acquireLanguageIntelligenceClient(
          session.id,
          session.languageId,
          filePath,
          languageIntelligenceSocketUrl(session.id),
          (url) => new WebSocket(url) as unknown as LspWebSocket,
          () => setSessionGeneration((generation) => generation + 1)
        );
        release = acquired.release;
        if (active)
          setState({
            filePath,
            extensions: [acquired.extension],
            sessionId: session.id,
            capabilities: session.capabilities,
            statusHint: null,
          });
        else acquired.release();
      })
      .catch((error: unknown) => {
        if (active) {
          WebviewLog.warn(
            `[useLanguageIntelligence] session lookup failed for ${filePath}: ${String(error)}`
          );
        }
      });

    return () => {
      active = false;
      controller.abort();
      release?.();
    };
  }, [filePath, sessionGeneration]);

  return state.filePath === filePath
    ? state
    : {
        filePath,
        extensions: [],
        sessionId: null,
        capabilities: {},
        statusHint: null,
      };
}
