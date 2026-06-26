/**
 * Single pre-launch switch for the FlightPath site.
 *
 * While `LAUNCHED` is `false`:
 *  - Install / Buy CTAs render as disabled "Coming soon" controls (see components/Cta.astro)
 *  - a pre-launch banner is shown and the site is set to `noindex` (see layouts/Layout.astro)
 *
 * At launch, flip this to `true` (one change) to restore all CTAs, drop the banner,
 * and allow search indexing.
 */
export const LAUNCHED = false;

/** VS Code Marketplace listing — live once the extension is published. */
export const MARKETPLACE_URL =
  "https://marketplace.visualstudio.com/items?itemName=fuzzynova.flightpath";

/** Lemon Squeezy checkout URL — set at launch (see PRO_LICENSE_PLAN.md). */
export const CHECKOUT_URL = "#";
