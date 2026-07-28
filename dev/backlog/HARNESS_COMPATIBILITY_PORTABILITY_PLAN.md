# Harness Compatibility and Workflow Portability Plan

> **Status:** Proposed
>
> **Priority:** P1 — core product promise
>
> **First implementation consumer:** Tool-permission honesty and parity

---

## Problem

ctrlyoke presents one workflow model across several AI coding harnesses, but the
harnesses do not implement identical capabilities. Today those differences are
encoded in several disconnected places:

- provider implementations and mappers;
- UI-specific switches such as `getPermissionHarnessSupport()`;
- hook-event metadata;
- warnings written to logs during command construction;
- documentation and marketing caveats;
- `.ctrlyoke/capabilities.json`, which currently reports availability and models
  rather than workflow-feature compatibility.

This means a workflow can look valid in the editor while containing properties a
selected harness will ignore, approximate, or reject. The failure or degradation
often becomes visible only after execution starts.

That weakens ctrlyoke's central promise: users should be able to switch harnesses
without having to rediscover hidden behavioral differences.

## Product Decision

Create one typed, provider-owned capability registry and one shared compatibility
analyzer. Every product surface must consume that same model rather than
maintaining its own harness switch.

The layer does **not** pretend the harnesses are identical. It makes differences
explicit, detects lossy translations before execution, and gives provider work a
clear parity backlog.

## Support Vocabulary

Each capability must use explicit support semantics:

- `native` — the harness directly supports the ctrlyoke behavior.
- `translated` — ctrlyoke can preserve the intended behavior through a lossless
  provider-specific translation.
- `workspace-config` — ctrlyoke can apply the behavior by changing a
  harness-owned project setting; this has workspace-wide side effects.
- `partial` — only a documented subset can be translated.
- `mode-only` — the coarse mode works but granular configuration does not.
- `unsupported` — the harness cannot provide the behavior.
- `unknown` — support has not been verified for the detected harness version.

Do not collapse these states to a boolean. `workspace-config`, `partial`, and
`unknown` need different UX and execution behavior.

## Capability Contract

Add shared contracts keyed by `HarnessId`. The exact file placement should follow
the existing types/provider boundaries, but there must be only one runtime source
of truth.

```typescript
interface HarnessCapabilityDescriptor {
  harnessId: HarnessId;
  verifiedVersions?: HarnessVersionRange;
  execution: {
    headless: CapabilitySupport;
    interactive: CapabilitySupport;
  };
  sessions: {
    resume: CapabilitySupport;
    continuation: CapabilitySupport;
  };
  promptInputs: {
    images: CapabilitySupport;
    categorizedFiles: CapabilitySupport;
  };
  permissions: {
    mode: CapabilitySupport;
    allowedTools: CapabilitySupport;
    deniedTools: CapabilitySupport;
    application: "cli-args" | "workspace-config" | "mixed" | "none";
  };
  hooks: Partial<Record<HookEvent, CapabilitySupport>>;
  mcp: {
    injection: CapabilitySupport;
    perServerToolFiltering: CapabilitySupport;
  };
  agents: CapabilitySupport;
  skills: CapabilitySupport;
  usage: {
    contextWindow: CapabilitySupport;
    turnTokens: CapabilitySupport;
    cumulativeTokens: CapabilitySupport;
  };
}
```

The registry should allow a provider to add a short, stable caveat and remediation
code, but user-facing prose belongs in shared diagnostic-message helpers rather
than being copied into React components.

## Compatibility Diagnostics

The analyzer accepts a parsed workflow, its resolved properties, the selected
target harness or harnesses, installed harness versions, and workspace state. It
returns structured diagnostics:

```typescript
interface CompatibilityDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  harnessId: HarnessId;
  capability: string;
  workflowPath?: string;
  support: CapabilitySupport;
  message: string;
  remediation?: string;
}
```

Initial checks:

- selected harness and model availability;
- headless versus interactive support;
- session resume and continuation;
- allowed/denied tool rules and permission modes;
- requested hook events;
- MCP injection and per-server tool filtering;
- agent and skill availability;
- image inputs;
- context/usage reporting;
- required workspace configuration and its side effects.

Diagnostics must distinguish:

- **invalid** — execution cannot honor the workflow;
- **lossy** — execution can continue, but a field is ignored or approximated;
- **side-effecting** — execution requires a workspace-scoped config mutation;
- **unverified** — the installed version is outside the tested range.

## Product Surfaces

### Workflow and prompt authoring

- Show relevant diagnostics beside the property that causes them.
- Show a compact portability summary for the effective harness.
- When changing harnesses, immediately recalculate warnings.
- Never leave an enabled field looking effective when the chosen harness will
  ignore it.

### Workflow-level portability report

Add a report that can evaluate one workflow against every installed harness:

| Harness | Ready | Lossy | Unsupported | Workspace side effects |
| ------- | ----- | ----- | ----------- | ---------------------- |

Selecting a row reveals step/property-level findings and remediations.

### Dry-run preview

The dry-run result must include compatibility diagnostics and the provider
translation that will actually be applied. Preview is the final pre-execution
truth surface, not a second capability implementation.

### CLI and automation

Extend validation with an optional target harness:

```text
ctrlyoke validate workflow.ctrlyoke.yaml --harness qwen-cli
ctrlyoke validate workflow.ctrlyoke.yaml --all-installed-harnesses --json
```

Use stable diagnostic codes and structured JSON. CI must be able to fail on
errors and optionally on lossy or unverified behavior.

### MCP capabilities

Evolve `.ctrlyoke/capabilities.json` without making it the source of truth. It
should serialize the installed-version-aware subset of the shared registry for
external tools while retaining the existing availability/model data.

## Version Awareness

Harness CLIs evolve independently. A mapper unit test proves only that ctrlyoke
emits an argument; it does not prove that an installed CLI accepts or enforces
it.

- Record the version range against which each nontrivial capability was
  integration-tested.
- Treat an unknown/newer major capability shape as `unknown`, not silently
  `native`.
- Add a provider-owned probe where the CLI exposes machine-readable capabilities.
- Do not parse human-readable `--help` output at normal runtime unless no stable
  interface exists; it can remain an integration-test oracle.

## Architecture Rules

- Provider declarations own facts; UI components only render them.
- The compatibility analyzer must remain platform-neutral so the VS Code
  extension, standalone CLI, hosted dashboard, and MCP entrypoint agree.
- Capability metadata does not replace actual provider validation. Command
  builders and workspace-config writers still reject unsafe or impossible
  translations.
- Warnings emitted during execution must reuse the same diagnostic codes/messages
  shown before execution.
- A capability declaration cannot claim `native` or `translated` without a
  behavioral integration test or an explicitly recorded manual verification.
- Marketing documentation should describe the shared workflow surface and link
  to a generated/current compatibility table rather than hand-maintaining parity
  claims.

## Phases

### Phase 1 — Registry and permission vertical slice

- Add the support vocabulary and provider-owned descriptors.
- Migrate permission support out of
  `components/shared/permissionUtils.ts`.
- Implement tool-permission diagnostics in both property editors and defaults.
- Expose compatibility findings through workflow validation.
- Implement the immediate honesty work in
  `TOOL_PERMISSION_PARITY_PLAN.md`.

### Phase 2 — Dry run and complete workflow report

- Add the shared analyzer.
- Integrate it with dry-run preview and CLI validation.
- Add the installed-harness portability report.
- Serialize the relevant capability data for MCP consumers.

### Phase 3 — Expand capability domains

- Hooks and notifications.
- MCP injection and tool filtering.
- Session/continuation behavior.
- agents, skills, images, and usage metadata.
- Generate customer-facing compatibility documentation from the registry.

## Acceptance Criteria

- No React component contains a hardcoded harness list for permission support.
- Selecting a harness that ignores a configured workflow property produces an
  author-time diagnostic.
- CLI validation and dashboard validation return the same diagnostic codes.
- Dry run shows every lossy translation and workspace-scoped side effect.
- Installed versions outside the verified range are identified as unverified.
- The registry is covered by a completeness test for every `HarnessId`.
- At least the permission domain has behavioral tests that prove restrictions are
  enforced, not merely that arguments/config files were generated.

## Non-goals

- Identical behavior from every harness.
- Blocking all execution merely because a translation is lossy.
- Automatically changing a workflow when its harness changes.
- Scraping release notes or remotely downloading capability definitions at
  runtime.
- Adding another harness before the existing compatibility model is trustworthy.
