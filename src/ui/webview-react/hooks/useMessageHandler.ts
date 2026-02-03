import { useEffect } from "react";

type MessageHandler = (message: any) => void;
type MessageHandlerMap = Record<string, MessageHandler>;

export function useMessageHandler(handlers: MessageHandlerMap) {
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      const handler = handlers[message.type];

      if (handler) {
        handler(message);
      } else {
        console.warn(`Unhandled message: ${message.type}`);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handlers]);
}
