/**
 * Per-template injection assertions. For each template that interpolates
 * user-controllable input, feed a tagged payload (`<script>`, javascript:
 * URL, quote-injecting email) and verify the rendered HTML does not contain
 * the unescaped attack and DOES contain the safe-encoded form.
 *
 * Coverage matrix is one test per template. The shared escape primitive is
 * covered exhaustively in email-escape.test.ts; this file is the
 * end-to-end "did the template wire it up" check.
 */

import { describe, expect, it } from 'vitest';
import { changeOrderApprovalEmailHtml } from '@/lib/email/templates/change-order-approval';
import { estimateAcceptedEmailHtml } from '@/lib/email/templates/estimate-accepted-notification';
import { estimateApprovalEmailHtml } from '@/lib/email/templates/estimate-approval';
import { estimateFeedbackEmailHtml } from '@/lib/email/templates/estimate-feedback-notification';
import { estimateViewedEmailHtml } from '@/lib/email/templates/estimate-viewed-notification';
import { invoiceEmailHtml } from '@/lib/email/templates/invoice-email';
import { bookingEmailHtml, cancellationEmailHtml } from '@/lib/email/templates/job-booking';
import { leadNotificationHtml } from '@/lib/email/templates/lead-notification';
import { projectMessageOperatorNotificationHtml } from '@/lib/email/templates/project-message-operator-notification';
import { pulseUpdateEmailHtml } from '@/lib/email/templates/pulse-update';
import { quoteEmailHtml } from '@/lib/email/templates/quote-email';
import { quoteResponseEmailHtml } from '@/lib/email/templates/quote-response';
import { referralInviteHtml } from '@/lib/email/templates/referral-invite';
import { refundConfirmationEmailHtml } from '@/lib/email/templates/refund-confirmation';

const TAG = '<script>alert(1)</script>';
const ENCODED = '&lt;script&gt;alert(1)&lt;/script&gt;';
const JS_URL = 'javascript:alert(1)';

function assertSafe(html: string) {
  // No raw injection survives.
  expect(html).not.toContain(TAG);
  // No javascript: scheme leaked into any href.
  expect(html).not.toMatch(/href="\s*javascript:/i);
}

describe('change-order-approval template', () => {
  it('escapes user-controlled fields and rejects javascript: in approveUrl', () => {
    const html = changeOrderApprovalEmailHtml({
      businessName: TAG,
      projectName: TAG,
      changeOrderTitle: TAG,
      description: TAG,
      costImpactFormatted: '$0',
      managementFeeFormatted: '$5',
      managementFeePct: TAG,
      totalImpactFormatted: '$10',
      timelineImpactDays: 0,
      approveUrl: JS_URL,
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });
});

describe('estimate-accepted-notification template', () => {
  it('escapes customer name + business name and rejects javascript: in projectUrl', () => {
    const html = estimateAcceptedEmailHtml({
      customerName: TAG,
      projectName: TAG,
      projectUrl: JS_URL,
      businessName: TAG,
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });
});

describe('estimate-approval template', () => {
  it('escapes name/project/note and rejects javascript: in approveUrl', () => {
    const html = estimateApprovalEmailHtml({
      businessName: TAG,
      projectName: TAG,
      approveUrl: JS_URL,
      customerName: TAG,
      note: TAG,
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });
});

describe('estimate-feedback-notification template', () => {
  it('escapes customer name and comment bodies', () => {
    const html = estimateFeedbackEmailHtml({
      customerName: TAG,
      projectName: TAG,
      projectUrl: JS_URL,
      comments: [
        { body: TAG, isLineItem: false },
        { body: TAG, isLineItem: true },
      ],
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });
});

describe('estimate-viewed-notification template', () => {
  it('escapes customer name + business name', () => {
    const html = estimateViewedEmailHtml({
      customerName: TAG,
      projectName: TAG,
      projectUrl: JS_URL,
      businessName: TAG,
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });
});

describe('invoice-email template', () => {
  it('escapes business/customer/note/terms/policies and rejects javascript: in payUrl', () => {
    const html = invoiceEmailHtml({
      customerName: TAG,
      businessName: TAG,
      invoiceNumber: TAG,
      totalFormatted: TAG,
      payUrl: JS_URL,
      customerNote: TAG,
      paymentInstructions: TAG,
      terms: TAG,
      policies: TAG,
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });
});

describe('job-booking templates', () => {
  it('booking confirm: escapes customer/business/date/time/address', () => {
    const html = bookingEmailHtml({
      customerName: TAG,
      businessName: TAG,
      date: TAG,
      time: TAG,
      address: TAG,
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });

  it('cancellation: escapes customer/business/date/time', () => {
    const html = cancellationEmailHtml({
      customerName: TAG,
      businessName: TAG,
      date: TAG,
      time: TAG,
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });
});

describe('lead-notification template', () => {
  it('escapes name/email/phone/total/surfaces; rejects javascript: in dashboardUrl', () => {
    const html = leadNotificationHtml({
      businessName: TAG,
      customerName: TAG,
      // Email contains both injection AND attribute-breakout — should be rejected
      // by safeMailtoHref so the link is omitted but the text still escapes.
      customerEmail: `evil@b.com"><script>alert(1)</script>`,
      customerPhone: TAG,
      totalFormatted: TAG,
      surfaceSummary: TAG,
      dashboardUrl: JS_URL,
    });
    assertSafe(html);
    // The script tag from email + phone tag from phone both appear escaped.
    expect(html).toContain(ENCODED);
    // The mailto link must not contain the raw injection.
    expect(html).not.toMatch(/<a href="mailto:[^"]*<script/);
    // The tel link must not contain the raw injection (digits stripped).
    expect(html).not.toMatch(/<a href="tel:[^"]*<script/);
  });

  it('renders a mailto link when the email is well-formed', () => {
    const html = leadNotificationHtml({
      businessName: 'Acme',
      customerName: 'Jane',
      customerEmail: 'jane@example.com',
      customerPhone: '+1 (555) 123-4567',
      totalFormatted: '$1,000',
      surfaceSummary: 'Bathroom',
      dashboardUrl: 'https://app.heyhenry.io/dashboard',
    });
    expect(html).toContain('href="mailto:jane@example.com"');
    expect(html).toContain('href="tel:+15551234567"');
    expect(html).toContain('href="https://app.heyhenry.io/dashboard"');
  });
});

describe('project-message-operator-notification template', () => {
  it('escapes customer name, project name, and message body', () => {
    const html = projectMessageOperatorNotificationHtml({
      customerName: TAG,
      projectName: TAG,
      projectUrl: JS_URL,
      body: TAG,
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });
});

describe('pulse-update template', () => {
  it('escapes project name, business name, and body text', () => {
    const html = pulseUpdateEmailHtml({
      businessName: TAG,
      projectName: TAG,
      bodyText: TAG,
      publicUrl: JS_URL,
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });
});

describe('quote-email template', () => {
  it('escapes business/customer/quote number/total and rejects javascript: in viewUrl', () => {
    const html = quoteEmailHtml({
      customerName: TAG,
      businessName: TAG,
      quoteNumber: TAG,
      totalFormatted: TAG,
      viewUrl: JS_URL,
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });
});

describe('quote-response template', () => {
  it('accepted: escapes name/quoteNumber/total and rejects javascript: in viewUrl', () => {
    const html = quoteResponseEmailHtml({
      type: 'accepted',
      customerName: TAG,
      quoteNumber: TAG,
      totalFormatted: TAG,
      viewUrl: JS_URL,
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });

  it('declined: escapes name + reason text', () => {
    const html = quoteResponseEmailHtml({
      type: 'declined',
      customerName: TAG,
      quoteNumber: TAG,
      totalFormatted: TAG,
      reason: TAG,
      viewUrl: JS_URL,
    });
    assertSafe(html);
    expect(html).toContain(ENCODED);
  });
});

describe('referral-invite template', () => {
  it('escapes referrer name (used in heading + body + signature) and rejects javascript: in URL', () => {
    const html = referralInviteHtml({
      referrerName: TAG,
      referralUrl: JS_URL,
    });
    assertSafe(html);
    // Name appears 3x in the template — confirm at least 2 escaped instances.
    // ENCODED contains regex metacharacters ( and ), so use plain split-count.
    const occurrences = html.split(ENCODED).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });
});

describe('refund-confirmation template', () => {
  it('escapes first name, amount, card last4, end date — both trial and paid variants', () => {
    const trial = refundConfirmationEmailHtml({
      firstName: TAG,
      refundAmountFormatted: TAG,
      cardLast4: TAG,
      accessEndsAtFormatted: TAG,
      isTrial: true,
    });
    assertSafe(trial);
    expect(trial).toContain(ENCODED);

    const paid = refundConfirmationEmailHtml({
      firstName: TAG,
      refundAmountFormatted: TAG,
      cardLast4: TAG,
      accessEndsAtFormatted: TAG,
      isTrial: false,
    });
    assertSafe(paid);
    expect(paid).toContain(ENCODED);
  });
});
