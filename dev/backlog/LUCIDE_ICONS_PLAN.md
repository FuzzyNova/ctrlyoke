# Lucide Icons Plan

**Created:** October 6, 2026
**Status:** Backlog. Replacement icons picked (step 2); ready to implement.

## Context

The dashboard has two icon systems:

- **Codicons** (`@vscode/codicons`), rendered by `components/shared/Icon.tsx`. These are the default.
- **Custom icons**: `scripts/generate-custom-icons.mjs` turns every SVG in `src/ui/icons/` into a
  CSS mask class in `static/custom-icons.css`, used as `<i class="custom-icon icon-<name>">`. See
  `dev/implemented/CUSTOM_ICONS_SYSTEM.md`.

`lucide-react` is now a dependency. Its first use is the server QR-code button and the QR step
in the certificate install help (`ServerSection.tsx`). Lucide looks and feels close to the
codicons and has a much wider set, so it becomes the first choice for anything codicons don't
cover. It's ISC-licensed, supports React 19 and is tree-shakeable: each icon is a component,
and only the imported ones are bundled. It draws in `currentColor`, so it follows the theme like a
codicon.

The pipeline has four icons in use. Three move to Lucide (step 2). The fourth is the ctrlyoke
logo, so the pipeline stays for it and for any future icon neither set has. The harness logos
in `src/ui/icons/harnesses/` stay as they are: Lucide doesn't include brand logos, and they never
used the pipeline anyway (`HarnessIcon.tsx` imports them directly with `?raw`).

## 1. Add a shared wrapper so Lucide matches codicons

Lucide icons are 2px outlines drawn on a 24px grid, while codicons are filled 16px glyphs. Used
raw, a Lucide icon next to a codicon looks heavier and sizes differently. Add one wrapper (e.g.
`components/shared/LucideIcon.tsx`) that sets this once, instead of passing `size`/`strokeWidth`
at every use:

- **Size:** 16px by default, the same box as a codicon, with the same size variants the codebase
  already uses for codicons.
- **Stroke weight:** tune it to match a codicon's visual weight at 16px. `strokeWidth` around
  1.25–1.5, or `absoluteStrokeWidth` so the stroke stays constant across sizes. Pick by putting
  candidates next to codicons in light, dark and high-contrast themes, not by number.
- **Alignment:** match how `.codicon` sits in a line of text and inside buttons, so a swap doesn't
  shift layout.
- **Accessibility:** follow `Icon.tsx`'s contract. Decorative by default (`aria-hidden`), and an
  `aria-label` promotes it to `role="img"`. Note that Lucide only adds `aria-hidden` itself when
  no `aria-*`, `role` or `title` prop is passed, so the wrapper has to set it explicitly.
- **API:** take the Lucide component, e.g. `<LucideIcon icon={QrCode} />`, so imports stay named
  and tree-shakeable. Avoid looking icons up by name string; that defeats tree-shaking and loses
  static checking.

Then switch the two existing `QrCode` uses in `ServerSection.tsx` to the wrapper, and add a test
for the wrapper's accessibility contract.

## 2. Replace three custom icons with Lucide (decided)

| Custom icon       | Used in                                                                                               | Lucide icon (`lucide-react` export)         |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `from-template`   | `WorkflowControls.tsx`: "New From Template..." option                                                 | `notepad-text-dashed` (`NotepadTextDashed`) |
| `load-from-file`  | `WorkflowControls.tsx`: "Load from File..." option                                                    | `file-plus-corner` (`FilePlusCorner`)       |
| `queue-from-file` | `WorkflowControls.tsx`: "Queue from File..." ("Append and Continue from File..." while viewing a run) | `list-end` (`ListEnd`)                      |

All three exports exist in the installed `lucide-react`. Render each through the wrapper from
step 1.

`generate-commit-message` stays a custom icon: it's the ctrlyoke logo, not a Streamline icon.
`scripts/generate-app-icons.mjs` copies the logo master (`images/ctrlyoke-icon.svg`) verbatim to
`src/ui/icons/generate-commit-message.svg`, and the custom-icon generator turns that copy into
`.icon-generate-commit-message`. `npm run generate-icons` runs the app-icon script before the
custom-icon one, so the copy is always current. Leave this chain as it is.

## 3. Prune the custom-icon pipeline (keep it)

The pipeline stays. It still serves the ctrlyoke logo, and it's the place for any future icon
that neither codicons nor Lucide has. Only remove what's no longer used:

- Delete `src/ui/icons/from-template.svg`, `load-from-file.svg` and `queue-from-file.svg`.
- Delete `append.svg` and `append-next.svg`, which aren't referenced anywhere.
- Rewrite `src/ui/icons/README.md`, which still describes Streamline as the source and uses
  `icon-append` as its example. It should say the folder is for icons that neither codicons nor
  Lucide has, that the logo copy is generated (edit `images/ctrlyoke-icon.svg`, not the copy), and
  that `harnesses/` holds raw-imported brand logos the generator skips (it reads only the top
  level).
- Regenerate `src/ui/webview-react/static/custom-icons.css` (`npm run generate-custom-icons`) so
  the deleted icons' classes drop out.
- `dev/backlog/HARNESS_SESSION_IMPORT_PLAN.md`: its planned dropdown option uses
  `custom-icon icon-import-session`. Change it to a Lucide icon via the wrapper, to match the
  options next to it.

## 4. Record the convention

After step 3, add a short bullet to `.github/instructions/webview-react-components.instructions.md`
on which icon source to use:

- **Codicons** via `Icon` first.
- **Lucide** via the wrapper when no codicon fits.
- **The custom-icon pipeline** (`src/ui/icons/`) only for icons neither has, such as the ctrlyoke
  logo.
- **Brand logos** for harnesses as raw SVG imports (`HarnessIcon.tsx`).
- **Never** a hand-drawn inline `<svg>`. The old QR button was one.

## Out of scope

- Replacing codicons that already work. Codicons stay the default; Lucide fills gaps.
- Removing the custom-icon pipeline. It's kept on purpose (see step 3).
- The VS Code-native surfaces (tree views, `package.json` contributions), which use VS Code's own
  codicon references, not the dashboard's components.
