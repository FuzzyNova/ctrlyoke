/**
 * Public Lemon Squeezy identifiers shared by the landing site and the Netlify
 * functions in `netlify/`. None of these are credentials. Lemon Squeezy scopes
 * products per mode, so each product has a live and a test variant; see
 * dev/active/RELEASE_CHECKLIST.md §5.1 for where the ids come from.
 */
export const LS_STORE_URL = "https://ctrlyoke.lemonsqueezy.com";

/** Store-level customer portal: buyers sign in by email link to manage or cancel. */
export const LS_CUSTOMER_PORTAL_URL = `${LS_STORE_URL}/billing`;

export const LS_PRODUCT = {
  PRO: "pro",
  ENTERPRISE: "enterprise",
} as const;
export type LsProduct = (typeof LS_PRODUCT)[keyof typeof LS_PRODUCT];

/** Each product's single ("Default") variant id, which webhooks carry as `variant_id`. */
export const LS_VARIANT_IDS: Readonly<
  Record<"live" | "test", Readonly<Record<LsProduct, number>>>
> = {
  live: { [LS_PRODUCT.PRO]: 2256371, [LS_PRODUCT.ENTERPRISE]: 2256370 },
  test: { [LS_PRODUCT.PRO]: 2059579, [LS_PRODUCT.ENTERPRISE]: 2105478 },
};

/** Hosted checkout links (each product's Share → checkout link). */
export const LS_CHECKOUT_URLS: Readonly<
  Record<"live" | "test", Readonly<Record<LsProduct, string>>>
> = {
  live: {
    [LS_PRODUCT.PRO]: `${LS_STORE_URL}/checkout/buy/5216b82f-8571-4ce4-9e8f-37659c88aea1`,
    [LS_PRODUCT.ENTERPRISE]: `${LS_STORE_URL}/checkout/buy/f8f7299d-2e90-4bcd-9c3c-b9f946f0bb83`,
  },
  test: {
    [LS_PRODUCT.PRO]: `${LS_STORE_URL}/checkout/buy/42b28b35-c63d-4fdd-9a65-e782bb103cde`,
    [LS_PRODUCT.ENTERPRISE]: `${LS_STORE_URL}/checkout/buy/d7ea080b-0432-4b94-b37c-36d0b0475b19`,
  },
};

/**
 * Keys of the checkout custom data (`checkout[custom][<key>]`) the Enterprise
 * checkout page on ctrlyoke.dev attaches to the Lemon Squeezy checkout. Lemon
 * Squeezy stores them on the order, which makes the order the Enterprise
 * terms-acceptance record (PRIVACY.md §3.3 and ENTERPRISE_TERMS.md §2), and echoes
 * them back to the webhook as `meta.custom_data`.
 */
export const ENTERPRISE_CHECKOUT_FIELD = {
  LEGAL_NAME: "customer_legal_name",
  BUSINESS_ADDRESS: "customer_business_address",
  REGISTRATION_NUMBER: "customer_registration_number",
  SIGNER_NAME: "accepted_by_name",
  SIGNER_EMAIL: "accepted_by_email",
  ACCEPTED_AT: "terms_accepted_at",
  ACCEPTED_VERSIONS: "terms_versions",
  ACCEPTANCE_METHOD: "terms_acceptance_method",
} as const;

/** Fields the webhook requires before it treats an Enterprise order as having a complete acceptance record. */
export const ENTERPRISE_CHECKOUT_REQUIRED_FIELDS = [
  ENTERPRISE_CHECKOUT_FIELD.LEGAL_NAME,
  ENTERPRISE_CHECKOUT_FIELD.BUSINESS_ADDRESS,
  ENTERPRISE_CHECKOUT_FIELD.SIGNER_NAME,
  ENTERPRISE_CHECKOUT_FIELD.SIGNER_EMAIL,
  ENTERPRISE_CHECKOUT_FIELD.ACCEPTED_AT,
  ENTERPRISE_CHECKOUT_FIELD.ACCEPTED_VERSIONS,
  ENTERPRISE_CHECKOUT_FIELD.ACCEPTANCE_METHOD,
] as const;

export const ENTERPRISE_ACCEPTANCE_METHOD =
  "checkbox+checkout:ctrlyoke.dev/enterprise/checkout";

/** Days of advance notice ENTERPRISE_TERMS.md §4(b) promises before each annual renewal. */
export const ENTERPRISE_RENEWAL_NOTICE_DAYS = 30;

/**
 * Reads the `**Version:** x.y` line every legal document in the repo root
 * carries, so the accepted versions recorded at checkout always match the
 * documents the site is serving. Throws so a reformatted document fails the
 * build instead of recording a blank version.
 */
export function readLegalDocumentVersion(
  markdown: string,
  documentName: string
): string {
  const match = /^\*\*Version:\*\*\s*(\S+)\s*$/m.exec(markdown);
  if (!match) {
    throw new Error(`${documentName} has no "**Version:** x.y" line`);
  }
  return match[1];
}
