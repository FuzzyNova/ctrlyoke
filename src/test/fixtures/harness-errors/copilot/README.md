# Copilot CLI error captures

Captured with GitHub Copilot CLI 1.0.105 in fresh scratch workspace directories. The hook fixture came from a registered `errorOccurred` command while a trusted headless prompt used the local OpenAI-compatible provider at `127.0.0.1:9` to force a connection-refused model error. The headless JSONL fixture is the corresponding event excerpt from stdout; it includes `session.error`, `assistant.idle`, and the final `result`.

Redactions replace session and event IDs, traceparent, and the scratch workspace path. The hook input has `sessionId` as a string and `error` as an object containing `message`, `name`, and `stack`. The headless process exited 1 after emitting `session.error`.
