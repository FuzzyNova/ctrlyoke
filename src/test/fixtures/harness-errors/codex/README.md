# Codex capture attempt

Codex CLI 0.166.0 was probed in a fresh scratch workspace. With an isolated home it stopped at first-run sign-in; with the existing home and `OPENAI_API_KEY=invalid`, it used the stored ChatGPT sign-in and answered the prompt successfully. A gpt-5.4 probe was rejected because that model is no longer available. No API-error turn or session-error log was captured, so Stop behavior remains unresolved for R4.
