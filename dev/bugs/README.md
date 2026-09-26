# ctrlyoke Bug Tracking

Repository-scoped bug tracking for ctrlyoke development and agent workflows.

## Directory Structure

```
dev/bugs/
├── README.md           # This guide and template
├── backlog/            # Open, confirmed bugs awaiting a fix
├── implemented/        # Resolved bugs (moved here by the fixing commit)
└── rejected/           # Investigated bugs closed as won't-fix, duplicate, or as-designed
```

## Lifecycle & Conventions

1. **File-per-bug**: Each bug lives in its own markdown document.
2. **Kebab-case naming**: Use descriptive slugs without numeric IDs (e.g. `dev/bugs/backlog/coordination-claim-paths-directory-containment.md`). Numeric sequences collide when multiple agents or worktrees work in parallel.
3. **Preserve filenames across transitions**: When resolving or rejecting a bug, move the file with `git mv dev/bugs/backlog/<name>.md dev/bugs/implemented/` (or `dev/bugs/rejected/`). Keeping the original slug ensures commit history and document links remain unbroken.
4. **Add a resolution note when moving**: Replace the `**Severity:**` line with `**Resolution:**`. For a fixed bug, write `**Resolution:** fixed in this commit` when the move is part of the fixing commit, or give the fixing commit hash when the move comes later (e.g. `**Resolution:** fixed in 1a2b3c4d`). For a rejected bug, give a one-line reason, e.g. `**Resolution:** rejected: as designed, claims are advisory`.
5. **Coordination**: In parallel workflows or multi-agent execution roots, claim your target filename via `claim_paths` before authoring.

---

## Bug Template

When filing a new bug under `dev/bugs/backlog/<slug>.md`, use this structure:

```markdown
# <Descriptive Bug Title>

- **Found:** YYYY-MM-DD by <agent / step / harness / user>
- **Area:** `<path/to/component>`
- **Severity:** <critical | high | medium | low>

## Symptom

What happens? Include observable error messages, unexpected tool outputs, or UI glitches.

## Steps to Reproduce

1. Step one
2. Step two
3. Observable outcome

## Root Cause

Technical explanation of why the bug occurs in the codebase (reference specific files and line numbers).

## Suggested Fix

Proposed solution, architectural considerations, or alternative approaches.
```
