import { useEffect, useState } from "react";
import type { Extension } from "@codemirror/state";
import {
  languageIntelligenceSession,
  languageIntelligenceSocketUrl,
} from "@utils/hostedApi";
import { acquireLanguageIntelligenceClient } from "@utils/languageIntelligenceClient";
import type { LspWebSocket } from "@utils/languageIntelligenceTransport";
import { WebviewLog } from "@utils/logger";

interface HookState {
  filePath: string;
  extensions: Extension[];
}

export function useLanguageIntelligence(filePath: string): Extension[] {
  const [state, setState] = useState<HookState>({
    filePath,
    extensions: [],
  });

  useEffect(() => {
    let active = true;
    let release: (() => void) | undefined;
    const controller = new AbortController();
    setState({ filePath, extensions: [] });

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
        if (active) setState({ filePath, extensions: [acquired.extension] });
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

  return state.filePath === filePath ? state.extensions : [];
}
