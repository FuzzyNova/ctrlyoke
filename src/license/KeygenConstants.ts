/** Public Keygen identifiers shared by the extension and the landing site. */
export const KEYGEN_ACCOUNT_ID = "6ed6209c-6633-4444-9d43-ab4a473e2f28";
export const KEYGEN_PRODUCT_ID = "f4af3c3b-4350-4a6e-af09-744797abb4b0";
export const KEYGEN_PRO_POLICY_ID = "da0764ce-6577-419a-862d-128efdbfc329";
export const KEYGEN_ENTERPRISE_POLICY_ID =
  "1700d3bb-06b7-4087-96ce-e08aa6c6a817";

/** Both policies live on the same product and share the account's Ed25519 key. */
export const KEYGEN_VALID_POLICY_IDS = [
  KEYGEN_PRO_POLICY_ID,
  KEYGEN_ENTERPRISE_POLICY_ID,
] as const;

/**
 * The Keygen account's Ed25519 verification key. It verifies license files in
 * the extension and webhook signatures in the Netlify functions. It is public
 * and safe to ship.
 */
export const KEYGEN_ACCOUNT_PUBLIC_KEY_HEX =
  "4cf46fe061bf97080094f14430fa2a1563f1b245cd600ccb99039bfff43836fa";

export const KEYGEN_API_BASE_URL = `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}`;

/** The extension's short fallback TTL for a checked-out license file. */
export const LICENSE_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Keygen license-validation codes ctrlyoke branches on. Shared because the
 * self-serve page in `landing/` must accept exactly the same set the extension
 * does — a key that is merely unactivated or at its machine limit can still
 * legitimately mint a license file.
 */
export const LICENSE_VALIDATION_CODES = {
  NO_MACHINES: "NO_MACHINES",
  FINGERPRINT_SCOPE_MISMATCH: "FINGERPRINT_SCOPE_MISMATCH",
  TOO_MANY_MACHINES: "TOO_MANY_MACHINES",
  MACHINE_LIMIT_EXCEEDED: "MACHINE_LIMIT_EXCEEDED",
} as const;

/**
 * Validation outcomes that still permit a license-file checkout. Checkout is a
 * read-style action and never consumes an activation slot, so an exhausted or
 * unset machine count must not block minting a file.
 */
export const CHECKOUT_ELIGIBLE_VALIDATION_CODES = [
  LICENSE_VALIDATION_CODES.NO_MACHINES,
  LICENSE_VALIDATION_CODES.FINGERPRINT_SCOPE_MISMATCH,
  LICENSE_VALIDATION_CODES.TOO_MANY_MACHINES,
] as const;

/**
 * The envelope Keygen wraps a signed license file in. `parseCertificate`
 * accepts only this form, so anything that produces a file for import — the
 * extension's own checkout or the self-serve page — must emit it verbatim.
 */
export const LICENSE_CERTIFICATE_BEGIN = "-----BEGIN LICENSE FILE-----";
export const LICENSE_CERTIFICATE_END = "-----END LICENSE FILE-----";
