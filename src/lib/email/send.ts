import { FROM_EMAIL, getResend } from './client';

export async function sendEmail({
  to,
  subject,
  html,
  from,
  replyTo,
}: {
  to: string;
  subject: string;
  html: string;
  from?: string;
  replyTo?: string;
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const resend = getResend();
    const { error } = await resend.emails.send({
      from: from || FROM_EMAIL,
      to,
      subject,
      html,
      replyTo,
    });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Unknown email error' };
  }
}
