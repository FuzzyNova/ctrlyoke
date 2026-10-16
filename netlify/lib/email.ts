// Resend transactional-email helper shared by the Netlify functions.

export const RESEND_FROM = "ctrlyoke <licensing@ctrlyoke.dev>";
export const BILLING_EMAIL = "billing@ctrlyoke.dev";
export const SALES_EMAIL = "sales@ctrlyoke.dev";
export const SUPPORT_EMAIL = "support@ctrlyoke.dev";

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Buyer-supplied text (names, checkout fields) must be escaped before it goes into an HTML body. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  replyTo?: string
): Promise<void> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to,
      subject,
      html,
      ...(replyTo && { reply_to: replyTo }),
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}
