# ctrlyoke Strategic Roadmap

**Last updated:** July 28, 2026

**Current version:** 0.1.0 (unreleased)

**Status:** Pre-release — no backward-compatibility constraints

---

## Product Direction

ctrlyoke is a workflow orchestrator for AI coding harnesses. Its durable product
boundary is:

- author and validate repeatable workflows;
- execute them across supported harnesses;
- control sessions, retries, conditions, permissions, and concurrency;
- expose live output, history, diffs, and recovery controls;
- make local and unattended automation safe and inspectable.

The product should not become a general-purpose source-code editor, a
harness-specific feature layer, or a branded methodology bundle. The custom
prompt editor is a core product surface. New work should strengthen
orchestration, automation, safety, observability, or workflow authoring across
harnesses.

The engine is already substantial. ctrlyoke supports Copilot CLI, Claude Code,
Codex CLI, OpenCode CLI, Qwen Code, and Antigravity CLI; sequential workflows;
parallel workflows; prompt and script steps; pre/end conditions; retries and
error behavior; dynamic queue extension; per-step sessions; agents, skills, MCP
servers, harness-specific permissions and hooks; a React dashboard; run history
and search; diffs and undo; a hosted browser dashboard; a standalone CLI; and an
MCP entrypoint. Shared workflow fields do not imply identical native harness
capabilities; unsupported and lossy translations must be visible before
execution.

The priority is no longer adding surface area before anyone can install the
product. Finish the release, then make the existing automation safer and easier
to drive.

---

## Priority Summary

### P0 — Ship 0.1.0

1. Finish the external launch checklist: production site/docs verification,
   Marketplace publisher setup, final VSIX smoke test, and publish.
2. Resolve the commercial-launch gate in
   [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md). The current strategy requires
   Pro at launch; if that work would materially delay release, make an explicit
   decision to ship a free public beta instead. Do not publish pricing and Pro
   promises that the extension cannot enforce.
3. Correct release artifacts that are populated but stale: `CHANGELOG.md` still
   claims a May 12 release date even though 0.1.0 has not shipped. (Its Copilot
   Chat support claim has been removed, along with the stale harness lists in
   `QUICK_START.md` and the landing/docs plans.)
4. Close release-critical accessibility, security, and regression gaps. Use
   [`TESTING_GAPS.md`](../backlog/TESTING_GAPS.md) as generated input, not as a
   percentage target that blocks forever.
5. Complete harness compatibility and tool-permission parity: **phase 1** of
   [`HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`](../backlog/HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md)
   plus all of
   [`TOOL_PERMISSION_PARITY_PLAN.md`](../backlog/TOOL_PERMISSION_PARITY_PLAN.md).
   ctrlyoke must not ship claiming granular Allowed/Denied Tools support that a
   harness does not enforce, and must not silently replace one running
   workflow's security policy with another's. This remains a
   full-implementation gate rather than an honest-messaging slice, so the
   capability registry, the cross-process permission-lease gate, and behavioral
   verification land before launch instead of the interim wording becoming the
   shipped behavior. Compatibility phase 2 (dry run, portability report,
   CLI/MCP serialization) was descoped to P1 on 2026-07-31: it makes existing
   truth more visible rather than preventing a dishonest claim or an unsafe
   mutation.
6. **Automation API structured results** — implement the versioned per-step JSON
   result contract in [`AUTOMATION_API_PLAN.md`](AUTOMATION_API_PLAN.md).
   Promoted from P1 because the CLI is now the _only_ sanctioned automation
   surface: the MCP lifecycle control surface was rejected on the explicit
   grounds that `ctrlyoke run --headless --json` already serves external
   automation. Shipping without the per-step contract would remove the
   alternative without delivering the replacement, leaving scripted callers to
   parse terminal text or ctrlyoke's private run storage — the exact coupling
   the rejection assumed they would not need.

### P1 — Stabilize and complete the automation foundation

These are the best post-launch investments. They improve the workflows users
already have instead of introducing new execution models.

Tool-permission parity and compatibility **phase 1** were previously listed here;
both are now P0 release gates (see above). Their capability registry, shared
compatibility analyzer, and pure effective-property resolver therefore already
exist for the items below — dry-run preview in particular consumes them rather
than reimplementing them. Compatibility **phase 2** is descoped to this list.

MCP lifecycle control was previously listed first here; it is now rejected (see
"Rejected and Removed Scope"). External automation is served by
`ctrlyoke run --headless --json`, and sub-workflow composition by
[`WORKFLOW_STEP_PLAN.md`](../backlog/WORKFLOW_STEP_PLAN.md).

1. **Secrets and redaction** — runtime secret references plus centralized
   redaction across logs, history, previews, exports, and remote transports.
   ([plan](../backlog/SECRETS_AND_REDACTION_PLAN.md))
2. **Dry-run preview** — show the categorized payload, provider translation,
   compatibility diagnostics, workspace side effects, and command without
   invoking a harness.
   ([plan](../backlog/DRY_RUN_PREVIEW_PLAN.md))
3. **Compatibility phase 2** — integrate the shipped analyzer with dry-run
   preview and CLI validation, add the installed-harness portability report, and
   serialize capability data for MCP consumers. Descoped from P0 on 2026-07-31;
   pairs with dry-run preview above.
   ([plan](../backlog/HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md))
4. **Template required variables + Feature-Driven Loop** — fix unresolved
   optional placeholders, validate required template input, and add the
   idea-to-plan orchestrator template without arbitrary setup scripts.
   ([plan](../backlog/TEMPLATE_REQUIRED_VARIABLES_PLAN.md))
5. **Native diagnostics gates** — implement phases 1–2 only: VS Code diagnostics
   as an end condition and retry context. Defer the generic IDE MCP bridge.
   ([plan](../backlog/VSCODE_LSP_MCP_PLAN.md))
6. **Attention-needed notifications** — add the canonical harness
   `notification` event so remote/unfocused users know when a workflow is
   waiting for input.
   ([plan](../backlog/NOTIFICATION_HOOK_EVENT_PLAN.md))
7. **Accessibility and semantic testability** — keyboard parity, accessible
   names/states, landmarks, and resilient role-based tests.
   ([plan](../backlog/ACCESSIBILITY_AND_TESTABILITY_PLAN.md))
8. **Expand capability domains** — phase 3 of the compatibility plan: hooks,
   MCP injection/tool filtering, images, and usage metadata, plus generated
   compatibility documentation.
   ([plan](../backlog/HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md))

### P2 — Strategic differentiators

Start these after real launch feedback and the P1 safety contracts exist.

1. **Worktree isolation** — the strongest next product differentiator. Safely
   isolate concurrent or unattended work, preserve results as branches, and
   avoid agents trampling one checkout.
   ([plan](../backlog/WORKTREE_SUPPORT_PLAN.md))
2. **Workflow variants / lightweight harness comparison** — duplicate a draft
   or fork an exact stored run into a new independent workflow, optionally
   changing harness/model, then use existing run navigation and hosted browser
   tabs for comparison. Do not add a native split view; coordinated racing
   waits for worktree isolation.
   ([plan](../backlog/WORKFLOW_VARIANTS_PLAN.md))
3. **Global execution-limit hardening** — consolidate and test the existing
   settings-level prompt, script, queue-size, and workflow-time enforcement.
   Do not add workflow or per-step limit properties.
   ([plan](../backlog/EXECUTION_GUARDRAILS_PLAN.md))
4. **Standalone server** — reuse the shipped hosted dashboard without requiring
   VS Code. The hosted server is implemented; `ctrlyoke server` is not.
   ([plan](../backlog/STANDALONE_SERVER_PLAN.md))
5. **Workflow scheduling** — use the existing global execution limits and
   secrets. Keep the decided orchestrator-bound model; ctrlyoke must be running.
   ([plan](../backlog/WORKFLOW_SCHEDULING_PLAN.md))
6. **Parallel steps** — valuable for independent research/test branches, but
   only after worktree isolation and a feature-owned global concurrency cap
   define safe concurrency.
   ([plan](../backlog/PARALLEL_STEPS_PLAN.md))
7. **Cumulative prompt and workflow usage** — distinguish current context
   fullness from total usage across compactions, then surface each run's
   observed workflow total in the workflow list for lightweight comparison.
   ([plan](../backlog/PROMPT_TOTAL_TOKEN_USAGE_PLAN.md))
8. **Harness usage/quota view** — show observed usage and clearly labeled
   last-known quota; never fabricate precision.
   ([plan](../backlog/HARNESS_USAGE_TRACKING_PLAN.md))
9. **Privacy-respecting telemetry** — ship only after public release, preserve
   VS Code's telemetry controls, and never collect user content or paths.
   ([plan](../backlog/TELEMETRY_PLAN.md))
10. **Prompt authoring suggestions** — manual continuation first, followed by
    opt-in automatic ghost text. Keep the service provider-neutral and
    `CodeMirrorEditor.tsx` as a thin integration point.
    ([plan](../backlog/PROMPT_AUTHORING_SUGGESTIONS_PLAN.md))

### P3 — Demand-driven parking lot

Do not schedule these until users demonstrate the pain:

| Candidate                                                                       | Disposition                                                                                                            |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| [Skill `/skill:` syntax](../backlog/SKILL_SLASH_COMMANDS_PLAN.md)               | Useful shorthand, but the existing `skills:` property works.                                                           |
| [Script-field completions](../backlog/SCRIPT_FIELD_COMPLETIONS_PLAN.md)         | Pleasant authoring polish after preview and template validation.                                                       |
| [Quick-picker scope improvements](../backlog/QUICK_PICKER_IMPROVEMENTS_PLAN.md) | Low-risk polish; validate demand for workflow-scope edits first.                                                       |
| [Harness session import](../backlog/HARNESS_SESSION_IMPORT_PLAN.md)             | Powerful but parser-heavy and dependent on unstable native logs.                                                       |
| [Workflow-step composition](../backlog/WORKFLOW_STEP_PLAN.md)                   | The plan itself recommends waiting; scripts and orchestrator templates cover current cases.                            |
| [Cline integration](../backlog/CLINE_INTEGRATION_PLAN.md)                       | Add another harness only when user demand justifies its maintenance matrix.                                            |
| [VS Code LM API features](../backlog/VSCODE_LM_API_FEATURES.md)                 | Keep ctrlyoke harness-neutral; revisit focused uses such as prompt improvement.                                        |
| [E2E automation via MCP](../backlog/VSCODE_TESTING_E2E_MCP.md)                  | Engineering investment, not a product feature; pursue when current integration tests stop finding release regressions. |

`TRADEMARK_FILING_GUIDE.md` is business/legal reference material, not a product
roadmap item. `TESTING_GAPS.md` is generated engineering input, not a feature.

---

## Launch Readiness

### Implemented or verified

- Production package installation and smoke verification — marked done.
- macOS testing — marked done.
- Marketplace description, keywords, and gallery banner are populated.
- `CHANGELOG.md` is populated, though its release date and feature list need a
  final correction.
- Astro landing site, VitePress docs, deploy workflows, pricing, privacy, terms,
  and Pro documentation exist.
- Native Getting Started walkthrough, harness preflight, built-in template
  cleanup, tech-support agent, and Antigravity harness work are implemented.
- The hosted browser dashboard is implemented with token access, TLS options,
  mobile layout, push notifications, and workspace-viewer support.

### Remaining ship gates

| Gate                                                                      | Status                                         | Source                                                                                                             |
| ------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Harness capability registry and compatibility diagnostics (phase 1)       | Not implemented                                | [`HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`](../backlog/HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md)                |
| Tool-permission honesty, Qwen/OpenCode parity, behavioral verification    | Not implemented                                | [`TOOL_PERMISSION_PARITY_PLAN.md`](../backlog/TOOL_PERMISSION_PARITY_PLAN.md)                                      |
| Cross-process permission-lease gate (step-scoped, atomic acquisition)     | Partial — lease exists, acquisition not atomic | [`TOOL_PERMISSION_PARITY_PLAN.md`](../backlog/TOOL_PERMISSION_PARITY_PLAN.md)                                      |
| Per-step CLI `--json` result contract                                     | Not implemented                                | [`AUTOMATION_API_PLAN.md`](AUTOMATION_API_PLAN.md)                                                                 |
| Final release artifact audit                                              | In progress                                    | [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md), [`RELEASE_PLAN.md`](RELEASE_PLAN.md)                               |
| Landing/docs production deployment and DNS verification                   | In progress                                    | [`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md), [`DOCUMENTATION_STRATEGY_PLAN.md`](DOCUMENTATION_STRATEGY_PLAN.md) |
| Pro license provider, entitlement service, activation, and feature gating | Not implemented                                | [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md)                                                                       |
| Rebrand/external identity cutover                                         | In progress                                    | [`CTRLYOKE_REBRAND_CUTOVER.md`](CTRLYOKE_REBRAND_CUTOVER.md)                                                       |
| Marketplace/Open VSX publisher authentication and publish                 | Not done                                       | [`RELEASE_PLAN.md`](RELEASE_PLAN.md)                                                                               |
| Separate npm CLI packaging                                                | Deferred unless required for launch messaging  | [`RELEASE_PLAN.md`](RELEASE_PLAN.md)                                                                               |

### Launch sequence

1. Decide commercial launch versus free public beta.
2. Finish or explicitly defer Pro activation/gating based on that decision.
3. Land the capability registry and permission parity gates, including
   behavioral allow/deny verification for Qwen and OpenCode.
4. Correct CHANGELOG, README, supported-harness claims, screenshots, and demo.
5. Deploy and verify `ctrlyoke.dev` plus `/docs/`.
6. Build the final VSIX, repeat the short smoke matrix, publish to Marketplace
   and Open VSX, then tag the actual release.
7. Publish the npm CLI separately only after its package contents and support
   promise are verified; it must not hold the VS Code release hostage.

---

## Implemented Roadmap Items

The roadmap tracks outcomes, while completed implementation plans live in
`dev/implemented/`.

| Outcome                                      | Evidence                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Completion notifications                     | [`COMPLETION_NOTIFICATIONS_PLAN.md`](../implemented/COMPLETION_NOTIFICATIONS_PLAN.md)         |
| Backtick context suppression                 | [`BACKTICK_CONTEXT_SUPPRESSION_PLAN.md`](../implemented/BACKTICK_CONTEXT_SUPPRESSION_PLAN.md) |
| Workflow favorites                           | [`WORKFLOW_FAVORITES_PLAN.md`](../implemented/WORKFLOW_FAVORITES_PLAN.md)                     |
| SCM commit-message action                    | [`SCM_COMMIT_MESSAGE_BUTTON.md`](../implemented/SCM_COMMIT_MESSAGE_BUTTON.md)                 |
| Error behavior and failure routing           | [`ERROR_BEHAVIOR_PLAN.md`](../implemented/ERROR_BEHAVIOR_PLAN.md)                             |
| Inline prior context                         | [`INLINE_PRIOR_CONTEXT_PLAN.md`](../implemented/INLINE_PRIOR_CONTEXT_PLAN.md)                 |
| Dropdown/multi-select validation styling     | [`DROPDOWN_VALIDATION_STYLING_PLAN.md`](../implemented/DROPDOWN_VALIDATION_STYLING_PLAN.md)   |
| Terminal follow-up tracking                  | [`TERMINAL_FOLLOWUP_TRACKING_PLAN.md`](../implemented/TERMINAL_FOLLOWUP_TRACKING_PLAN.md)     |
| Generic hook-event notification pipeline     | [`HOOK_EVENT_NOTIFICATIONS_PLAN.md`](../implemented/HOOK_EVENT_NOTIFICATIONS_PLAN.md)         |
| Native onboarding walkthrough                | [`ONBOARDING_TOUR_PLAN.md`](../implemented/ONBOARDING_TOUR_PLAN.md)                           |
| Harness preflight                            | [`HARNESS_PREFLIGHT_PLAN.md`](../implemented/HARNESS_PREFLIGHT_PLAN.md)                       |
| Hosted browser server and security hardening | [`SERVER_SECURITY_PLAN.md`](../implemented/SERVER_SECURITY_PLAN.md)                           |

Known limitation: Antigravity's available logs do not currently provide reliable
context-window usage, so ctrlyoke cannot display that metric with the same
confidence as other harnesses.

---

## Rejected and Removed Scope

Rejected plans remain in `dev/rejected/` so decisions and prior research are not
lost.

| Removed item                                                                   | Reason                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [BMAD templates](../rejected/BMAD_FOR_CTRLYOKE.md)                             | Built-in linear and orchestrator templates cover the patterns without third-party methodology/trademark coupling.                                                                                                                                                          |
| [Raw prompt mode](../rejected/RAW_PROMPT_MODE_PLAN.md)                         | A bypass execution path weakens consistent preparation; fenced suppression and dry-run preview address the real needs.                                                                                                                                                     |
| [Template setup scripts](../rejected/TEMPLATE_SETUP_SCRIPTS.md)                | Arbitrary template code creates avoidable trust and portability costs; typed variables are sufficient.                                                                                                                                                                     |
| [AGENTS.md generation/injection](../rejected/AGENTS_MD_GENERATION.md)          | Risks duplicate harness-native instructions; generation can remain a template/workflow concern.                                                                                                                                                                            |
| [Additional instructions channel](../rejected/ADDITIONAL_INSTRUCTIONS_PLAN.md) | Duplicates agents, skills, workflow defaults, and project instruction files.                                                                                                                                                                                               |
| [Native mobile app](../rejected/NATIVE_MOBILE_APP.md)                          | The responsive hosted dashboard is the mobile client.                                                                                                                                                                                                                      |
| [Conditional steps](../rejected/CONDITIONAL_STEPS_PLAN.md)                     | External scripts and programmatic orchestration avoid a workflow expression language.                                                                                                                                                                                      |
| [Mobile header redesign](../rejected/MOBILE_HEADER_REDESIGN_PLAN.md)           | Superseded by the implemented mobile layout.                                                                                                                                                                                                                               |
| [MCP lifecycle control surface](../rejected/MCP_CONTROL_SURFACE_PLAN.md)       | The built-in MCP server is blanket auto-approved and scoped to its own run; auto-approved start/cancel/pause would be an unbounded spawn and DoS primitive and duplicate the CLI's control plane. Cursor-based output paging was harvested to `MCP_OUTPUT_PAGING_PLAN.md`. |

AI-generated workflow scaffolding is also removed as a separate roadmap feature:
the built-in workflow-composer/spec-orchestrator agents and
`spec-driven-loop.ctrlyoke.yaml` already provide the useful behavior without a
new core subsystem.

---

## Dependencies and Sequencing

```text
0.1.0 release
  ├─ commercial launch? ── yes ─► Pro activation + gating
  │                       no  ─► explicit free-beta messaging
  ├─ pure effective-property resolver ─► capability registry + analyzer
  │                                        ├─► honest permission UI
  │                                        ├─► permission parity (Qwen/OpenCode
  │                                        │    workspace config + behavioral tests)
  │                                        └─► portability report
  └─ site/docs + release artifacts + publisher setup ─► publish

Post-launch automation foundation
  ├─ secrets/redaction ───────────────────────────┐
  ├─ global execution-limit hardening ────────────┼─► scheduling
  ├─ MCP lifecycle control ───────────────────────┴─► standalone server
  ├─ redaction (registry already shipped) ──► dry-run preview
  └─ required template variables + diagnostics gates

Safe concurrency
  worktree isolation ─────────────┐
  feature-owned concurrency cap ──┼─► parallel steps
  cumulative usage ───────────────┘
```

---

## Milestones

| Milestone                                    | Outcome                                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **0.1.0 — Public launch**                    | Installable, documented, correctly licensed, and published with capability diagnostics and behaviorally verified permission parity. |
| **0.1.x — Trust and automation**             | Secrets and redaction, dry-run preview, required template input, and MCP lifecycle control.                                         |
| **0.2 — Authoring and comparison**           | Prompt suggestions, workflow variants, complete MCP lifecycle control, and rich CLI JSON results.                                   |
| **0.3 — Isolated execution**                 | Worktree-backed workflows with clear recovery and branch landing.                                                                   |
| **0.4 — Long-running automation**            | Hardened global limits, standalone server, and orchestrator-bound scheduling.                                                       |
| **0.5 — Safe concurrency and observability** | Parallel steps plus cumulative usage/quota views, driven by adoption data.                                                          |

No calendar dates are assigned until 0.1.0 is published. Sequence and exit
criteria matter more than speculative dates.

---

## Plan Index

### Active

| Plan                                                               | Current outcome                                                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md)                     | Canonical external launch checklist                                            |
| [`RELEASE_PLAN.md`](RELEASE_PLAN.md)                               | Marketplace/package release work                                               |
| [`LANDING_PAGE_PLAN.md`](LANDING_PAGE_PLAN.md)                     | Implementation mostly complete; production verification remains                |
| [`DOCUMENTATION_STRATEGY_PLAN.md`](DOCUMENTATION_STRATEGY_PLAN.md) | Infrastructure/content exists; freshness and deployment remain                 |
| [`PRO_LICENSE_PLAN.md`](PRO_LICENSE_PLAN.md)                       | Architecture decided; provider and extension implementation remain             |
| [`CTRLYOKE_REBRAND_CUTOVER.md`](CTRLYOKE_REBRAND_CUTOVER.md)       | External cutover work remains                                                  |
| [`AUTOMATION_API_PLAN.md`](AUTOMATION_API_PLAN.md)                 | **P0 release gate.** Per-step JSON ready to implement; SDK/MCP launch rejected |

### Prioritized backlog

| Plan                                                                                                | Priority                  |
| --------------------------------------------------------------------------------------------------- | ------------------------- |
| [`EXECUTION_GUARDRAILS_PLAN.md`](../backlog/EXECUTION_GUARDRAILS_PLAN.md)                           | P2 (reduced scope)        |
| [`HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md`](../backlog/HARNESS_COMPATIBILITY_PORTABILITY_PLAN.md) | P0 phase 1; P1 phases 2–3 |
| [`TOOL_PERMISSION_PARITY_PLAN.md`](../backlog/TOOL_PERMISSION_PARITY_PLAN.md)                       | P0                        |
| [`SECRETS_AND_REDACTION_PLAN.md`](../backlog/SECRETS_AND_REDACTION_PLAN.md)                         | P1                        |
| [`DRY_RUN_PREVIEW_PLAN.md`](../backlog/DRY_RUN_PREVIEW_PLAN.md)                                     | P1                        |
| [`TEMPLATE_REQUIRED_VARIABLES_PLAN.md`](../backlog/TEMPLATE_REQUIRED_VARIABLES_PLAN.md)             | P1                        |
| [`VSCODE_LSP_MCP_PLAN.md`](../backlog/VSCODE_LSP_MCP_PLAN.md)                                       | P1 (phases 1–2)           |
| [`NOTIFICATION_HOOK_EVENT_PLAN.md`](../backlog/NOTIFICATION_HOOK_EVENT_PLAN.md)                     | P1                        |
| [`ACCESSIBILITY_AND_TESTABILITY_PLAN.md`](../backlog/ACCESSIBILITY_AND_TESTABILITY_PLAN.md)         | P1                        |
| [`WORKTREE_SUPPORT_PLAN.md`](../backlog/WORKTREE_SUPPORT_PLAN.md)                                   | P2                        |
| [`WORKFLOW_VARIANTS_PLAN.md`](../backlog/WORKFLOW_VARIANTS_PLAN.md)                                 | P2                        |
| [`STANDALONE_SERVER_PLAN.md`](../backlog/STANDALONE_SERVER_PLAN.md)                                 | P2                        |
| [`WORKFLOW_SCHEDULING_PLAN.md`](../backlog/WORKFLOW_SCHEDULING_PLAN.md)                             | P2                        |
| [`MCP_OUTPUT_PAGING_PLAN.md`](../backlog/MCP_OUTPUT_PAGING_PLAN.md)                                 | P2                        |
| [`PARALLEL_STEPS_PLAN.md`](../backlog/PARALLEL_STEPS_PLAN.md)                                       | P2                        |
| [`PROMPT_TOTAL_TOKEN_USAGE_PLAN.md`](../backlog/PROMPT_TOTAL_TOKEN_USAGE_PLAN.md)                   | P2                        |
| [`HARNESS_USAGE_TRACKING_PLAN.md`](../backlog/HARNESS_USAGE_TRACKING_PLAN.md)                       | P2                        |
| [`TELEMETRY_PLAN.md`](../backlog/TELEMETRY_PLAN.md)                                                 | P2                        |
| [`PROMPT_AUTHORING_SUGGESTIONS_PLAN.md`](../backlog/PROMPT_AUTHORING_SUGGESTIONS_PLAN.md)           | P2                        |
| [`SKILL_SLASH_COMMANDS_PLAN.md`](../backlog/SKILL_SLASH_COMMANDS_PLAN.md)                           | P3                        |
| [`SCRIPT_FIELD_COMPLETIONS_PLAN.md`](../backlog/SCRIPT_FIELD_COMPLETIONS_PLAN.md)                   | P3                        |
| [`QUICK_PICKER_IMPROVEMENTS_PLAN.md`](../backlog/QUICK_PICKER_IMPROVEMENTS_PLAN.md)                 | P3                        |
| [`HARNESS_SESSION_IMPORT_PLAN.md`](../backlog/HARNESS_SESSION_IMPORT_PLAN.md)                       | P3                        |
| [`WORKFLOW_STEP_PLAN.md`](../backlog/WORKFLOW_STEP_PLAN.md)                                         | P3                        |
| [`CLINE_INTEGRATION_PLAN.md`](../backlog/CLINE_INTEGRATION_PLAN.md)                                 | P3                        |
| [`VSCODE_LM_API_FEATURES.md`](../backlog/VSCODE_LM_API_FEATURES.md)                                 | P3                        |
| [`VSCODE_TESTING_E2E_MCP.md`](../backlog/VSCODE_TESTING_E2E_MCP.md)                                 | P3 engineering            |

### Operational references

- [`TESTING_GAPS.md`](../backlog/TESTING_GAPS.md)
- [`TRADEMARK_FILING_GUIDE.md`](../backlog/TRADEMARK_FILING_GUIDE.md)
