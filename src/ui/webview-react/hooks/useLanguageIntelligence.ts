import { useEffect, useState } from "react";
import type { Extension } from "@codemirror/state";
import {
  languageIntelligenceSession,
  languageIntelligenceSocketUrl,
} from "@utils/hostedApi";
import { acquireLanguageIntelligenceClient } from "@utils/languageIntelligenceClient";
import type { LspWebSocket } from "@utils/languageIntelligenceTransport";
import { WebviewLog } from "@utils/logger";

export interface LanguageIntelligenceState {
  filePath: string;
  extensions: Extension[];
  sessionId: string | null;
  capabilities: Record<string, unknown>;
}

export function useLanguageIntelligence(
  filePath: string
): LanguageIntelligenceState {
  const [state, setState] = useState<LanguageIntelligenceState>({
    filePath,
    extensions: [],
    sessionId: null,
    capabilities: {},
  });

  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    setState({ filePath, extensions: [], sessionId: null, capabilities: {} });

    void languageIntelligenceSession(filePath, controller.signal)
      .then(({ session }) => {
        if (!active || !session) return;
        const acquired = acquireLanguageIntelligenceClient(
          session.id,
          session.languageId,
          filePath,
          languageIntelligenceSocketUrl(session.id),
          (url) => new WebSocket(url) as unknown as LspWebSocket
        );
        release = acquired.release;
        if (active)
          setState({
            filePath,
            extensions: [acquired.extension],
            sessionId: session.id,
            capabilities: session.capabilities,
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
  }, [filePath]);

  return state.filePath === filePath
    ? state
    : { filePath, extensions: [], sessionId: null, capabilities: {} };
}
