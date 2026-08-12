/**
 * Local ESLint plugin for ctrlyoke-specific rules.
 *
 * Rules here exist to catch defects that are cheap to make, expensive to
 * diagnose, and invisible to the test suite. Wired up in `eslint.config.mjs`.
 */
import stableStoreSelector from "./stable-store-selector.mjs";

export default {
  meta: { name: "ctrlyoke" },
  rules: {
    "stable-store-selector": stableStoreSelector,
  },
};
