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

export const KEYGEN_API_BASE_URL = `https://api.keygen.sh/v1/accounts/${KEYGEN_ACCOUNT_ID}`;

/** The extension's short fallback TTL for a checked-out license file. */
export const LICENSE_FILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
