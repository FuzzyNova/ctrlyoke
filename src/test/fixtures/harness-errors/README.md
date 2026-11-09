# Harness error capture fixtures

These fixtures are redacted excerpts from real local CLI runs. Per-harness READMEs record versions, capture methods, outcomes, and unavailable probes. The associated investigation ledger is in `dev/implemented/ERROR_HANDLING_CONSISTENCY_PLAN.md` §6. No product code was changed for Phase 0. The second capture pass used a local stub server that returns provider-shaped, non-retryable errors (and 429-then-success sequences for Qwen), with isolated config homes or scratch-only hooks; nothing in a fixture is synthesized.
