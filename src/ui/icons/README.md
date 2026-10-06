# Custom Icons

This folder is for dashboard icons that **neither codicons nor Lucide has**. Check those first:

1. **Codicons** via `components/shared/Icon.tsx`: the default.
2. **Lucide** via `components/shared/LucideIcon.tsx` (`<LucideIcon icon={QrCode} />`) when no
   codicon fits.
3. **This folder** only when neither set has the icon. Today that's just the ctrlyoke logo.

## How it works

`scripts/generate-custom-icons.mjs` turns every `.svg` at the **top level** of this folder into a
CSS mask class in `src/ui/webview-react/static/custom-icons.css`:

1. Add `my-icon.svg` here.
2. Run `npm run generate-custom-icons` (or `npm run generate-icons`, which `npm run compile` also
   runs).
3. Use it as `<i className="custom-icon icon-my-icon" />`.

The SVG is drawn with `mask-image`, so it takes `currentColor` and follows the theme like a
codicon. The generator strips `fill` and `stroke` colors, so use a monochrome icon with simple, filled
shapes.
Size variants are `icon-large` (20px) and `icon-extra-large` (24px); the default box is 16px.

The SVG sources aren't shipped. Only the generated CSS (with the SVGs embedded as data URIs) is.

## Current icons

- `generate-commit-message.svg`: the ctrlyoke logo, used on the workspace viewer's generate
  commit message button. **This file is generated.** `scripts/generate-app-icons.mjs` copies it
  verbatim from the logo master `images/ctrlyoke-icon.svg`, and `npm run generate-icons` runs that
  before the custom-icon generator. Edit `images/ctrlyoke-icon.svg`, not the copy.

## `harnesses/`

Brand logos for the harnesses. Lucide has no brand logos, so these live here, but they don't use
the pipeline: the generator reads only the top level of this folder, and `HarnessIcon.tsx` imports
each logo directly with `?raw`.
