import {
  LS_CHECKOUT_URLS,
  LS_PRODUCT,
} from "../../src/license/LemonSqueezyConstants";

/**
 * Single pre-launch switch for the ctrlyoke site.
 *
 * While `LAUNCHED` is `false`:
 *  - Install / Buy CTAs render as disabled "Coming soon" controls (see components/Cta.astro)
 *  - the Enterprise checkout form at /enterprise/checkout/ is disabled (except under `astro dev`)
 *  - a pre-launch banner is shown and the site is set to `noindex` (see layouts/Layout.astro;
 *    the VitePress docs merged in at /docs/ read this too, in docs/.vitepress/config.mts)
 *
 * At launch, flip this to `true` (one change) to restore all CTAs, drop the banner,
 * and allow search indexing.
 */
export const LAUNCHED = false;

/** VS Code Marketplace listing — live once the extension is published. */
export const MARKETPLACE_URL =
  "https://marketplace.visualstudio.com/items?itemName=fuzzynova.ctrlyoke";

/**
 * `astro dev` uses Lemon Squeezy's test-mode checkouts so purchases can be
 * exercised end to end with a test card; every built site uses live mode.
 */
const LS_CHECKOUT_MODE = import.meta.env?.DEV === true ? "test" : "live";

/** Lemon Squeezy checkout for ctrlyoke Pro (only rendered once `LAUNCHED`, via Cta.astro). */
export const CHECKOUT_URL = LS_CHECKOUT_URLS[LS_CHECKOUT_MODE][LS_PRODUCT.PRO];

/**
 * Lemon Squeezy checkout for ctrlyoke Enterprise. Buyers reach it only through
 * the terms-acceptance form at `ENTERPRISE_CHECKOUT_PATH`, which appends the
 * acceptance record as checkout custom data; never link to it directly.
 */
export const ENTERPRISE_LS_CHECKOUT_URL =
  LS_CHECKOUT_URLS[LS_CHECKOUT_MODE][LS_PRODUCT.ENTERPRISE];

/** ctrlyoke.dev page that collects Enterprise terms acceptance before checkout. */
export const ENTERPRISE_CHECKOUT_PATH = "/enterprise/checkout/";

/** Whether the Enterprise checkout form accepts submissions (always on under `astro dev` for testing). */
export const ENTERPRISE_CHECKOUT_ENABLED =
  LAUNCHED || import.meta.env?.DEV === true;
