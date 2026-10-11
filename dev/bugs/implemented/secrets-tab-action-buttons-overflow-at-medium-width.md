# Secrets tab action buttons overflow their borders at medium widths

- **Found:** 2026-10-11 while capturing docs screenshot D23 (hosted dashboard, 1280 px window)
- **Area:** `src/ui/webview-react/components/settings/SecretsSection.tsx`
- **Resolution:** fixed in this commit

## Symptom

On a "From environment · not found" row, the **Set value** and **Remove declaration**
buttons wrap onto two lines, and "declaration" spills past the right edge of its button
border. The published screenshot `images/screenshots/secrets-tab-828x440.png` shows it.

## Steps to Reproduce

1. Open the hosted dashboard in a 1280 px wide window.
2. Load a workflow that grants a secret name that is neither set nor in the environment.
3. Open **Settings → Secrets**: the row's action buttons overflow.

## Root Cause

The Actions column is narrower than the longest button label, and the buttons wrap their
text without growing to fit.

## Suggested Fix

Give the Actions column a minimum width that fits **Remove declaration**, or stop the
labels from wrapping (`whitespace-nowrap`) and let the column size to its content.
Re-capture the D23 screenshot afterwards.
