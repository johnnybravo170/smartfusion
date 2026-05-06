/**
 * Outbound email helpers for customer-facing sends.
 *
 * Phase 2 of PROJECT_MESSAGING_PLAN.md routes customer replies into the
 * project_messages thread. To make that work, every customer-facing
 * email needs three things:
 *
 *   1. `reply-to: henry@heyhenry.io` — so Reply lands on our inbound
 *      webhook instead of the operator's personal Gmail.
 *   2. A custom `Message-ID` header derived from the message row id —
 *      so `In-Reply-To` on the customer's reply walks straight back to
 *      a project_messages row regardless of how many tenants share the
 *      customer's email.
 *   3. A `[Ref: P-xxxxxx]` footer in the body — redundant fallback for
 *      header mangling (Apple Mail, third-party forwards, etc.).
 *
 * Use these helpers at every customer-facing sendEmail callsite. Don't
 * roll your own; consistency is what makes the inbound resolver work.
 */

import { projectRefFooter } from './project-ref';

/** All customer-facing reply traffic lands here (webhook routes by sender). */
export const CUSTOMER_REPLY_TO = 'henry@heyhenry.io';

/**
 * Build the custom Message-ID for an outbound email tied to a specific
 * project_messages row. The same id is written to that row's
 * external_id BEFORE the send so the inbound resolver can match it.
 */
export function outboundMessageId(messageRowId: string): string {
  return `<msg-${messageRowId}@heyhenry.io>`;
}

/**
 * Strip the angle brackets from a Message-ID for storage. We store the
 * bare form on project_messages.external_id so In-Reply-To matches via
 * the same normalization on inbound.
 */
export function bareMessageId(angleBracketed: string): string {
  return angleBracketed.replace(/^<|>$/g, '');
}

/**
 * Append the project ref footer to an HTML email body. Looks for a
 * conventional `</body>` tag and inserts before it; falls back to
 * appending. The footer is small grey text with a leading separator —
 * unobtrusive but copy-paste-safe through forwards.
 */
export function appendCustomerEmailFooter(html: string, projectId: string): string {
  const ref = projectRefFooter(projectId);
  const footerHtml = `<p style="margin:24px 0 0;padding-top:12px;border-top:1px solid #eee;font-size:11px;color:#888;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">${ref}</p>`;
  if (html.includes('</body>')) {
    return html.replace('</body>', `${footerHtml}\n</body>`);
  }
  return `${html}\n${footerHtml}`;
}

/**
 * Build the headers blob for a customer-facing send. Always returns a
 * Message-ID; callers add anything else they need.
 */
export function customerOutboundHeaders(messageRowId: string): Record<string, string> {
  return {
    'Message-ID': outboundMessageId(messageRowId),
  };
}
