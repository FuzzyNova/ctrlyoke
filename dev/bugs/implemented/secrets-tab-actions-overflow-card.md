# Secrets tab Actions buttons overflow past the secret's card

- **Found:** 2026-10-11 by Claude while re-capturing `secrets-tab-828x440.png` in the hosted dashboard
- **Area:** `src/ui/webview-react/components/settings/SecretsSection.tsx`
- **Resolution:** fixed in this commit

## Symptom

At a normal desktop width (hosted dashboard at 1280 CSS px, settings column about 640 px), each
secret row's **Set value** / **Remove declaration** or **Replace** / **Delete** buttons extend
about 60–80 px past the right border of the row's card. They also stick out past the
**Set secret** button and the section's right edge.

## Steps to Reproduce

1. Open the hosted dashboard in a 1280×800 window.
2. Open **Settings → Secrets** with at least one declared secret.
3. The Actions column runs past each row's border.

## Root Cause

The row (`SecretsSection.tsx:121`) and the header (`:515`) use
`md:grid-cols-[minmax(10rem,1fr)_minmax(12rem,1fr)_minmax(11rem,1.2fr)_minmax(9rem,auto)]`.
The four minimums add up to 42 rem (672 px). With three `gap-3` gaps and `px-3` padding, a row
needs about 732 px. That is wider than the settings content column the `md` breakpoint
applies to, so the grid overflows its container instead of shrinking. The minimum Actions width
added with the one-line action buttons (see `SCREENSHOTS_AND_MEDIA_PLAN.md`, "Recapture needed")
pushed the total over the column width.

## Suggested Fix

Lower the minimums so they fit the settings column, for example by letting Name and Used by
shrink (`minmax(0,1fr)` with `min-w-0` cells, as Name already has). Or switch to the stacked
layout below a container width rather than a viewport breakpoint. Then re-capture
`images/screenshots/secrets-tab-828x440.png`.
