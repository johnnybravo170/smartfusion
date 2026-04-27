/**
 * AR step executor.
 *
 * `runDueEnrollments()` — picked up by the cron route. Claims up to N due
 * enrollments, processes each one step at a time.
 *
 * Per enrollment, one tick does:
 *   1. Load sequence + steps at the enrolled version
 *   2. Look up step at current_position
 *   3. Dispatch by step.type
 *   4. Advance current_position and set next_run_at to now + next step's delay,
 *      OR mark completed if we ran past the last step.
 *
 * Kept deliberately simple: one step per enrollment per tick. The cron runs
 * every minute, so a sequence with zero-delay steps will walk through itself
 * a step/minute. That's fine for Phase 1 — we're not trying to be a bulk
 * broadcaster yet.
 */

import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  arContacts,
  arEnrollments,
  arSendLog,
  arSequences,
  arSteps,
  arTemplates,
} from '@/lib/db/schema/ar';
import { FROM_EMAIL_MARKETING } from '@/lib/email/client';
import { sendEmail } from '@/lib/email/send';
import { sendSms } from '@/lib/twilio/client';
import { type Channel, checkSendPolicy, defaultWindow, type SendWindow } from './policy';
import { renderTemplate } from './render';
import { signUnsubToken } from './unsub-token';

const CLAIM_LIMIT = 50;

export async function runDueEnrollments(now: Date = new Date()): Promise<{
  processed: number;
  errors: number;
}> {
  const db = getDb();

  const due = await db
    .select()
    .from(arEnrollments)
    .where(and(eq(arEnrollments.status, 'active'), lte(arEnrollments.nextRunAt, now)))
    .orderBy(asc(arEnrollments.nextRunAt))
    .limit(CLAIM_LIMIT);

  let processed = 0;
  let errors = 0;
  for (const enrollment of due) {
    try {
      await runOne(enrollment.id, now);
      processed++;
    } catch (e) {
      if (e instanceof DeferSignal) {
        // Policy deferred the send; next_run_at already updated. Not an error.
        continue;
      }
      errors++;
      const msg = e instanceof Error ? e.message : String(e);
      await db
        .update(arEnrollments)
        .set({ status: 'errored', lastError: msg })
        .where(eq(arEnrollments.id, enrollment.id));
    }
  }
  return { processed, errors };
}

async function runOne(enrollmentId: string, now: Date): Promise<void> {
  const db = getDb();

  const [enrollment] = await db
    .select()
    .from(arEnrollments)
    .where(eq(arEnrollments.id, enrollmentId));
  if (!enrollment || enrollment.status !== 'active') return;

  const [sequence] = await db
    .select()
    .from(arSequences)
    .where(eq(arSequences.id, enrollment.sequenceId));
  if (!sequence) throw new Error('sequence_not_found');
  if (sequence.status === 'paused' || sequence.status === 'archived') {
    // Don't progress while paused; retry in 5 min.
    await db
      .update(arEnrollments)
      .set({ nextRunAt: new Date(now.getTime() + 5 * 60 * 1000) })
      .where(eq(arEnrollments.id, enrollmentId));
    return;
  }

  const [step] = await db
    .select()
    .from(arSteps)
    .where(
      and(
        eq(arSteps.sequenceId, enrollment.sequenceId),
        eq(arSteps.version, enrollment.version),
        eq(arSteps.position, enrollment.currentPosition),
      ),
    );

  if (!step) {
    // No step at this position → sequence complete.
    await db
      .update(arEnrollments)
      .set({ status: 'completed', completedAt: now })
      .where(eq(arEnrollments.id, enrollmentId));
    return;
  }

  switch (step.type) {
    case 'email':
    case 'sms':
      await runChannelStep(enrollmentId, step.id, step.type, step.templateId, sequence, now);
      break;
    case 'wait':
      // No-op: the delay is honored by nextRunAt when we advance.
      break;
    case 'tag':
      await runTagStep(enrollment.contactId, step.config as { add?: string[]; remove?: string[] });
      break;
    case 'exit':
      await db
        .update(arEnrollments)
        .set({ status: 'completed', completedAt: now })
        .where(eq(arEnrollments.id, enrollmentId));
      return;
    case 'branch':
      // Phase 1 branch support deferred — advance straight through.
      break;
  }

  await advanceEnrollment(
    enrollmentId,
    enrollment.currentPosition,
    enrollment.sequenceId,
    enrollment.version,
    now,
  );
}

async function runChannelStep(
  enrollmentId: string,
  stepId: string,
  channel: Channel,
  templateId: string | null,
  sequence: typeof arSequences.$inferSelect,
  now: Date,
): Promise<void> {
  const db = getDb();
  if (!templateId) throw new Error('channel_step_missing_template');

  const [enrollment] = await db
    .select()
    .from(arEnrollments)
    .where(eq(arEnrollments.id, enrollmentId));
  if (!enrollment) throw new Error('enrollment_vanished');

  const [contact] = await db
    .select()
    .from(arContacts)
    .where(eq(arContacts.id, enrollment.contactId));
  if (!contact) throw new Error('contact_not_found');

  const [template] = await db.select().from(arTemplates).where(eq(arTemplates.id, templateId));
  if (!template) throw new Error('template_not_found');

  const window = mergeWindow(channel, sequence);
  const decision = await checkSendPolicy(db, {
    contactId: contact.id,
    channel,
    window,
    now,
  });

  if (!decision.send && decision.defer) {
    // Defer the whole enrollment; do NOT advance.
    await db
      .update(arEnrollments)
      .set({ nextRunAt: decision.retryAt })
      .where(eq(arEnrollments.id, enrollmentId));
    // Re-throw-ish: signal to caller NOT to advance. We do that by throwing a
    // sentinel caught upstream.
    throw new DeferSignal();
  }

  const toAddress = channel === 'email' ? contact.email : contact.phone;

  if (!decision.send) {
    // Skip: log it, advance.
    await db.insert(arSendLog).values({
      tenantId: contact.tenantId,
      contactId: contact.id,
      enrollmentId,
      stepId,
      channel,
      toAddress: toAddress ?? '',
      subject: template.subject,
      status: 'suppressed',
      errorMessage: decision.reason,
    });
    return;
  }

  // Render + send. Merge order: enrollment metadata (event payload) first,
  // then contact fields on top — so event-provided values set the stage but
  // a contact's name still wins for {{first_name}}, etc.
  const vars = buildMergeVars(contact, enrollment.metadata);
  const [logRow] = await db
    .insert(arSendLog)
    .values({
      tenantId: contact.tenantId,
      contactId: contact.id,
      enrollmentId,
      stepId,
      channel,
      toAddress: toAddress ?? '',
      subject: template.subject,
      status: 'queued',
    })
    .returning({ id: arSendLog.id });

  // CASL category for this send. Read from sequence trigger_config; default
  // to express_consent for legacy sequences without an explicit category.
  // Per-sequence categorization matters because not every AR send is bulk
  // marketing — quote follow-up is response_to_request, review requests are
  // transactional, etc.
  const sequenceCfg = (sequence.triggerConfig as Record<string, unknown> | null) ?? {};
  const sequenceCaslCategory =
    (sequenceCfg.casl_category as
      | 'transactional'
      | 'response_to_request'
      | 'implied_consent_inquiry'
      | 'implied_consent_ebr'
      | 'express_consent'
      | undefined) ?? 'express_consent';

  if (channel === 'email') {
    const html = template.bodyHtml ? renderTemplate(template.bodyHtml, vars) : undefined;
    const subject = template.subject ? renderTemplate(template.subject, vars) : '';
    // Build a proper RFC 5322 From header so Resend renders a display name
    // (e.g. "Jon's Amazing Service <hello@mail.heyhenry.io>") instead of a
    // bare email. Escape quotes in the display name just in case.
    // AR is marketing-class — default to send.heyhenry.io unless the template
    // pins its own verified address. Never fall through to transactional.
    const fromAddress = template.fromEmail || FROM_EMAIL_MARKETING;
    const fromHeader = template.fromName
      ? `"${template.fromName.replace(/"/g, '')}" <${fromAddress}>`
      : fromAddress;
    // RFC 8058 one-click unsubscribe. Gmail/Yahoo require these on bulk mail.
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://app.heyhenry.io').replace(
      /\/$/,
      '',
    );
    const unsubToken = signUnsubToken(contact.id, 'all');
    const unsubUrl = `${appUrl}/unsubscribe/${unsubToken}`;
    const result = await sendEmail({
      to: toAddress as string,
      subject,
      html: html ?? '',
      from: fromHeader,
      replyTo: template.replyTo || undefined,
      headers: {
        'List-Unsubscribe': `<${unsubUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
      caslCategory: sequenceCaslCategory,
      caslEvidence: {
        enrollmentId,
        stepId,
        contactId: contact.id,
        arSendLogId: logRow.id,
        sequenceId: sequence.id,
      },
      relatedType: 'platform',
      relatedId: enrollmentId,
    });
    await db
      .update(arSendLog)
      .set({
        status: result.ok ? 'sent' : 'failed',
        sentAt: result.ok ? now : null,
        providerId: result.ok ? (result.id ?? null) : null,
        errorMessage: result.ok ? null : result.error,
      })
      .where(eq(arSendLog.id, logRow.id));
    if (!result.ok) throw new Error(`email_send_failed: ${result.error}`);
  } else {
    if (!contact.tenantId) {
      // sendSms requires tenantId. Platform-level SMS is a Phase 2 concern.
      await db
        .update(arSendLog)
        .set({ status: 'failed', errorMessage: 'sms_requires_tenant' })
        .where(eq(arSendLog.id, logRow.id));
      throw new Error('sms_requires_tenant');
    }
    const body = template.bodyText ? renderTemplate(template.bodyText, vars) : '';
    const result = await sendSms({
      tenantId: contact.tenantId,
      to: toAddress as string,
      body,
      identity: 'platform',
      relatedType: 'platform',
      caslCategory: sequenceCaslCategory,
      caslEvidence: {
        enrollmentId,
        stepId,
        contactId: contact.id,
        arSendLogId: logRow.id,
        sequenceId: sequence.id,
      },
    });
    await db
      .update(arSendLog)
      .set({
        status: result.ok ? 'sent' : 'failed',
        sentAt: result.ok ? now : null,
        providerId: result.ok ? result.sid : null,
        errorMessage: result.ok ? null : result.error,
      })
      .where(eq(arSendLog.id, logRow.id));
    if (!result.ok) throw new Error(`sms_send_failed: ${result.error}`);
  }
}

async function runTagStep(
  contactId: string,
  config: { add?: string[]; remove?: string[] },
): Promise<void> {
  const db = getDb();
  const add = config.add ?? [];
  const remove = config.remove ?? [];
  for (const tag of add) {
    await db.execute(sql`
      INSERT INTO public.ar_contact_tags (contact_id, tag)
      VALUES (${contactId}::uuid, ${tag})
      ON CONFLICT DO NOTHING
    `);
  }
  if (remove.length > 0) {
    await db.execute(sql`
      DELETE FROM public.ar_contact_tags
      WHERE contact_id = ${contactId}::uuid AND tag = ANY(${remove}::text[])
    `);
  }
}

async function advanceEnrollment(
  enrollmentId: string,
  currentPosition: number,
  sequenceId: string,
  version: number,
  now: Date,
): Promise<void> {
  const db = getDb();
  const nextPosition = currentPosition + 1;

  const [nextStep] = await db
    .select()
    .from(arSteps)
    .where(
      and(
        eq(arSteps.sequenceId, sequenceId),
        eq(arSteps.version, version),
        eq(arSteps.position, nextPosition),
      ),
    );

  if (!nextStep) {
    await db
      .update(arEnrollments)
      .set({ status: 'completed', completedAt: now, currentPosition: nextPosition })
      .where(eq(arEnrollments.id, enrollmentId));
    return;
  }

  const nextRunAt = new Date(now.getTime() + nextStep.delayMinutes * 60 * 1000);
  await db
    .update(arEnrollments)
    .set({ currentPosition: nextPosition, nextRunAt })
    .where(eq(arEnrollments.id, enrollmentId));
}

function mergeWindow(channel: Channel, sequence: typeof arSequences.$inferSelect): SendWindow {
  const defaults = defaultWindow(channel);
  if (channel === 'email') {
    return {
      quietStart: sequence.emailQuietStart ?? defaults.quietStart,
      quietEnd: sequence.emailQuietEnd ?? defaults.quietEnd,
      daysOfWeek: sequence.emailDaysOfWeek ?? defaults.daysOfWeek,
    };
  }
  return {
    quietStart: sequence.smsQuietStart ?? defaults.quietStart,
    quietEnd: sequence.smsQuietEnd ?? defaults.quietEnd,
    daysOfWeek: sequence.smsDaysOfWeek ?? defaults.daysOfWeek,
  };
}

function buildMergeVars(
  contact: typeof arContacts.$inferSelect,
  enrollmentMetadata?: unknown,
): Record<string, unknown> {
  const metadata =
    typeof enrollmentMetadata === 'object' && enrollmentMetadata !== null
      ? (enrollmentMetadata as Record<string, unknown>)
      : {};
  return {
    ...metadata, // event payload becomes the baseline (e.g. gallery_url)
    first_name: contact.firstName ?? metadata.first_name ?? '',
    last_name: contact.lastName ?? metadata.last_name ?? '',
    email: contact.email ?? '',
    phone: contact.phone ?? '',
    ...(typeof contact.attributes === 'object' && contact.attributes !== null
      ? (contact.attributes as Record<string, unknown>)
      : {}),
  };
}

class DeferSignal extends Error {
  constructor() {
    super('deferred');
    this.name = 'DeferSignal';
  }
}
