# Custom Tooltips Plan

**Status:** Proposed 2026-10-09. Not started.

**Goal:** replace the dashboard's native `title` tooltips with a themed tooltip component that can
show a bold heading, cap its width, and keep long help text easy to read. Start with the
schema-backed help, where tooltips are longest.

## 1. Why

Every tooltip in the React dashboard is a native `title` attribute: about 475 of them under
`src/ui/webview-react/components/`. The browser draws native tooltips, so we cannot:

- **bold a heading.** For a truncated dropdown row, the full name is the one thing the user is
  looking for. Today it is only the first plain-text paragraph.
- **cap the width.** Chromium on Windows makes long schema descriptions very wide, often half the
  panel.
- **theme them.** They ignore the VS Code colour tokens and look different in the hosted browser
  dashboard than in the webview.
- **control the delay or placement.** Inside the dropdown portals, the tooltip often covers the
  next rows.

The interim fix (2026-10-09) made the most of native tooltips. `schemaPropertyLabels.ts` now
builds every schema tooltip as blank-line-separated paragraphs with the same order:

1. the full label
2. the option's own description
3. the schema help
4. the `property:` line

The builders are `tooltipParagraphs`, `schemaTitle`, `schemaOptionTitle` and `schemaFieldTitle`.
That structured content is already the right input for a rich tooltip. Only the renderer is
missing.

## 2. Proposed design

### 2.1 Content model

Give tooltips a structured form instead of a flat string:

```ts
interface TooltipContent {
  heading?: string; // rendered bold
  paragraphs: string[];
  footer?: string; // "property: model = …", always shown (see §5.1)
}
```

The schema builders return `TooltipContent`. A `tooltipText(content)` helper turns it back into
the current paragraph string. The `aria-label`/`aria-describedby` text and any remaining native
`title` use that string, so the wording has one source.

### 2.2 Renderer

- One `TooltipLayer` per app root renders a single portal, reusing the `DropdownPortal`
  positioning approach. That keeps it above the resizable panels and the fullscreen drawers (see
  the "Shared dropdowns/portals" rule in `webview-react-components.instructions.md`).
- **Triggering:**
  - Elements opt in with a `useTooltip(content)` hook or a `data-tooltip-id` attribute.
  - The tooltip opens after hover-intent (about 500ms) or on keyboard focus, and closes on
    Escape, blur, pointer-leave or scroll.
  - Use one delegated listener on the root, not one per element. The dropdown lists can hold
    hundreds of rows.
- **Styling:**
  - Use Tailwind token classes from `globals.css`, not raw VS Code variables.
  - Cap the width at `max-w-xs` (about 320px).
  - Show the heading `font-semibold` and the footer `text-description-fg font-mono text-xxs`.
- **Placement:**
  - Prefer the right side of a dropdown row, so the next rows stay visible. Prefer below a field
    label.
  - Flip when there isn't room, and clamp to the visual viewport. `keyboardTooltipSpace.ts` has
    the iOS keyboard-viewport logic.

### 2.3 Accessibility

A native `title` currently becomes the element's accessible description. Keep that by setting
`aria-describedby` on the trigger to point at the open tooltip. While it's closed, point at a
visually hidden node holding `tooltipText(content)`. Accessible names stay as they are.
`schemaAriaLabel` already builds them, and `scripts/check-a11y-names.mjs` guards them.

### 2.4 Touch and the hosted dashboard

Hover doesn't exist on touch. Options:

- **(a)** a long-press on rows that don't also act on long-press;
- **(b)** an explicit info button on field labels only.

Recommend (b) for field labels. Dropdown rows on touch can keep the visible truncated
description and have no tooltip, which is today's behaviour, since mobile browsers ignore `title`.

## 3. Migration order

1. Add `TooltipContent`, `TooltipLayer` and `useTooltip`, with tests (open and close timing,
   keyboard focus, Escape, flipping, `aria-describedby`).
2. Move the schema-backed surfaces, where the long tooltips are:
   - `FormField` in `WorkflowPropertiesPanel`;
   - the `PropertiesDrawer` labels;
   - option rows in `CustomSelect`, `MultiCheckboxDropdown`, `SkillsSelect`, `HarnessDropdown` and
     `PriorContextSelect`;
   - the other callers of `schemaTitle` (`ScriptConditionEditor`, `ErrorBehaviorEditor`,
     `McpServerForm`, `HooksEditor`, the settings rows).
3. Move other multi-sentence tooltips, such as the token/cost hovers built in `TokenFormatting`
   and the step chip hovers.
4. Leave short single-phrase `title`s (icon buttons like "Hide this option") as native titles
   unless consistency becomes the bigger issue. Converting all ~475 isn't the goal.

## 4. Test impact

About 24 UI test files read tooltips through `getByTitle` or `toHaveAttribute("title", …)`.
Migrated surfaces need those assertions moved to `aria-describedby`/`toHaveAccessibleDescription`.
Add a small test helper that resolves a trigger's tooltip content, so tests don't depend on how
the tooltip is rendered.

Note: Testing Library's default normalizer collapses whitespace in `getByTitle`. Tests that check
paragraph structure must assert on the attribute or pass `normalizer: (t) => t`. The current
tests already do this.

## 5. Decisions

### 5.1 Always show the `property:` footer

The footer stays on for every dashboard user. There is no setting to hide it. It teaches the YAML
property name and value behind each control, so users can move to writing workflow files by hand.

That matters more than it first appears. Templates can only be fully authored in YAML or JSON
today. `TemplateManager` reads `_templateMeta.variables` (type, options, default, description,
`autoFillFilename`, and so on) and the `{placeholder}` / `{file:name}` tokens straight from the
file. The dashboard has no way to declare template variables or place them in step fields. Until
it does, anyone writing templates has to know the YAML property names, and the footer is how
dashboard users learn them.

Render the footer muted and in monospace, so it reads as a reference line rather than prose.

### 5.2 Leave the field's help out of dropdown rows

A dropdown row's tooltip leaves out the field's schema help, because the field label's tooltip
already shows it. A row shows:

- **heading:** the option's full label (it is often truncated on screen);
- **paragraph:** the option's own description, if it has one (agents, skills);
- **pseudo-options:** for None/Inherit, the YAML the option writes (`agent: null`,
  `omit skills`), in place of a description;
- **footer:** `property: <path> = <value>`.

This makes the most common row tooltips (models, agents, skills) much shorter. The field-level
help, including step-only wording such as "On a step, null (None in the step properties)…", stays
on the field label's tooltip.

**Done 2026-10-09** on native `title`s: `schemaOptionTitle` passes an empty description to
`schemaTitle`, so rows never pull in the field's help. The rows of `HarnessDropdown` and
`PriorContextSelect` now go through it too.

Options that select a schema `oneOf` branch carry a `variant` key in `SchemaUiMetadata`.
`toSelectOptions` then fills in the option's description from `SCHEMA_VARIANT_DESCRIPTIONS`,
which `generate-schema-ui-descriptions.mjs` builds from each branch's description. That is how
the Worktree None/Managed/Named rows explain themselves. To give another option a description,
write it on the schema branch, not in the UI.

## 6. Related gap (out of scope)

The dashboard can't author templates: it can't declare `_templateMeta.variables` or insert
`{placeholder}` tokens into step fields. `dev/backlog/TEMPLATE_REQUIRED_VARIABLES_PLAN.md` only
covers enforcing `required` variables. Dashboard template authoring would need its own plan. If it
ships, the reason for §5.1 gets weaker but doesn't go away: the footer would still teach the file
format.
