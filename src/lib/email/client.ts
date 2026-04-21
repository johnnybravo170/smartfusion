import { Resend } from 'resend';

let _resend: Resend | null = null;

export function getResend(): Resend {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is required at runtime');
    }
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

// Transactional class — invoices, quotes, change orders, auth, account.
// Verified on mail.heyhenry.io. Falls back to legacy RESEND_FROM_EMAIL so
// existing Vercel envs keep working during the split-rollout.
export const FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL_TRANSACTIONAL ||
  process.env.RESEND_FROM_EMAIL ||
  'noreply@heyhenry.io';

// Marketing class — autoresponder sends. Verified on send.heyhenry.io so a
// marketing spam complaint can't tank transactional deliverability.
export const FROM_EMAIL_MARKETING = process.env.RESEND_FROM_EMAIL_MARKETING || FROM_EMAIL;
