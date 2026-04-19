/**
 * AR contact tools — subscriber CRUD + tagging + enrollment.
 *
 * `scope`: either a tenant UUID (non-null) or `null` for the platform marketing
 * list. All queries match on that scope via `tenant_id IS NOT DISTINCT FROM`.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { errorResult, formatDateTime, textResult } from '../types.js';

type Scope = string | null;

export function registerArContactTools(server: McpServer, scope: Scope) {
  server.tool(
    'ar_list_contacts',
    'List autoresponder contacts in the active scope. Filter by search term (name/email/phone) or tag. Returns the contact id, name, email, phone, subscription status, and tags.',
    {
      search: z.string().optional().describe('Match against name, email, or phone (partial)'),
      tag: z.string().optional().describe('Only contacts carrying this tag'),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async ({ search, tag, limit }) => {
      const sql = getDb();
      try {
        const conditions = [sql`tenant_id IS NOT DISTINCT FROM ${scope}`];
        if (search) {
          const p = `%${search}%`;
          conditions.push(
            sql`(first_name ILIKE ${p} OR last_name ILIKE ${p} OR email ILIKE ${p} OR phone ILIKE ${p})`,
          );
        }
        if (tag) {
          conditions.push(sql`id IN (SELECT contact_id FROM ar_contact_tags WHERE tag = ${tag})`);
        }
        const where = conditions.reduce((a, b) => sql`${a} AND ${b}`);
        const rows = await sql`
          SELECT id, email, phone, first_name, last_name, email_subscribed, sms_subscribed,
                 unsubscribed_at, created_at,
                 (SELECT array_agg(tag ORDER BY tag) FROM ar_contact_tags WHERE contact_id = ar_contacts.id) AS tags
          FROM ar_contacts
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `;
        if (rows.length === 0) return textResult('No contacts found.');

        let out = `Found ${rows.length} contact(s):\n\n`;
        for (const r of rows) {
          const name = [r.first_name, r.last_name].filter(Boolean).join(' ') || '(no name)';
          const channels = [
            r.email ? `📧 ${r.email}${r.email_subscribed ? '' : ' [unsub]'}` : null,
            r.phone ? `📱 ${r.phone}${r.sms_subscribed ? '' : ' [unsub]'}` : null,
          ]
            .filter(Boolean)
            .join('  ');
          const tags = (r.tags ?? []).length > 0 ? ` · tags: ${(r.tags ?? []).join(', ')}` : '';
          out += `• ${name}  ${channels}${tags}\n  ID: ${r.id}\n\n`;
        }
        return textResult(out.trimEnd());
      } catch (e) {
        return errorResult(`list_contacts failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'ar_upsert_contact',
    'Create or update an autoresponder contact. Matches on email (case-insensitive) or phone within the active scope. Returns the resulting contact id.',
    {
      email: z.string().email().optional(),
      phone: z.string().optional().describe('E.164 format preferred, e.g. +16045551234'),
      first_name: z.string().optional(),
      last_name: z.string().optional(),
      timezone: z.string().optional().describe('IANA tz, e.g. America/Vancouver'),
      locale: z.string().optional(),
      source: z
        .string()
        .optional()
        .describe('Where this contact came from (signup_form, import_2026_04, etc.)'),
      attributes: z
        .record(z.string(), z.any())
        .optional()
        .describe('Free-form JSON for merge tags'),
    },
    async (input) => {
      const sql = getDb();
      if (!input.email && !input.phone) {
        return errorResult('Either email or phone is required.');
      }
      try {
        // Look up existing.
        const matchCond = input.email
          ? sql`lower(email) = ${input.email.toLowerCase()}`
          : sql`phone = ${input.phone as string}`;
        const [existing] = await sql`
          SELECT id FROM ar_contacts
          WHERE tenant_id IS NOT DISTINCT FROM ${scope} AND ${matchCond}
          LIMIT 1
        `;

        if (existing) {
          await sql`
            UPDATE ar_contacts SET
              email = COALESCE(${input.email ?? null}, email),
              phone = COALESCE(${input.phone ?? null}, phone),
              first_name = COALESCE(${input.first_name ?? null}, first_name),
              last_name = COALESCE(${input.last_name ?? null}, last_name),
              timezone = COALESCE(${input.timezone ?? null}, timezone),
              locale = COALESCE(${input.locale ?? null}, locale),
              source = COALESCE(${input.source ?? null}, source),
              attributes = COALESCE(attributes, '{}'::jsonb) || ${JSON.stringify(input.attributes ?? {})}::jsonb,
              updated_at = now()
            WHERE id = ${existing.id}
          `;
          return textResult(`Updated contact ${existing.id}`);
        }

        const [row] = await sql`
          INSERT INTO ar_contacts (tenant_id, email, phone, first_name, last_name, timezone, locale, source, attributes)
          VALUES (
            ${scope},
            ${input.email ?? null},
            ${input.phone ?? null},
            ${input.first_name ?? null},
            ${input.last_name ?? null},
            ${input.timezone ?? 'America/Vancouver'},
            ${input.locale ?? 'en'},
            ${input.source ?? null},
            ${JSON.stringify(input.attributes ?? {})}::jsonb
          )
          RETURNING id
        `;
        return textResult(`Created contact ${row.id}`);
      } catch (e) {
        return errorResult(`upsert_contact failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'ar_tag_contact',
    'Add and/or remove tags on an autoresponder contact. Tags are free-form lowercase strings used for segmentation and triggering sequences.',
    {
      contact_id: z.string().uuid(),
      add: z.array(z.string()).optional(),
      remove: z.array(z.string()).optional(),
    },
    async ({ contact_id, add, remove }) => {
      const sql = getDb();
      try {
        // Confirm contact is in scope.
        const [c] = await sql`
          SELECT id FROM ar_contacts
          WHERE id = ${contact_id} AND tenant_id IS NOT DISTINCT FROM ${scope}
        `;
        if (!c) return errorResult('Contact not found in this scope.');

        for (const tag of add ?? []) {
          await sql`
            INSERT INTO ar_contact_tags (contact_id, tag)
            VALUES (${contact_id}, ${tag.toLowerCase()})
            ON CONFLICT DO NOTHING
          `;
        }
        if ((remove ?? []).length > 0) {
          const lowered = (remove ?? []).map((t) => t.toLowerCase());
          await sql`
            DELETE FROM ar_contact_tags
            WHERE contact_id = ${contact_id} AND tag = ANY(${lowered}::text[])
          `;
        }
        return textResult(
          `Contact ${contact_id}: +${(add ?? []).length} tag(s), -${(remove ?? []).length} tag(s)`,
        );
      } catch (e) {
        return errorResult(`tag_contact failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'ar_enroll_contact',
    "Enroll a contact into an active sequence. Pins the enrollment to the sequence's current version; editing the sequence later will not change this enrollment's path.",
    {
      contact_id: z.string().uuid(),
      sequence_id: z.string().uuid(),
      start_at: z
        .string()
        .datetime()
        .optional()
        .describe('ISO timestamp to start. Defaults to now.'),
    },
    async ({ contact_id, sequence_id, start_at }) => {
      const sql = getDb();
      try {
        const [contact] = await sql`
          SELECT id FROM ar_contacts
          WHERE id = ${contact_id} AND tenant_id IS NOT DISTINCT FROM ${scope}
        `;
        if (!contact) return errorResult('Contact not found in this scope.');

        const [seq] = await sql`
          SELECT id, version, status, allow_reenrollment FROM ar_sequences
          WHERE id = ${sequence_id} AND tenant_id IS NOT DISTINCT FROM ${scope}
        `;
        if (!seq) return errorResult('Sequence not found in this scope.');
        if (seq.status !== 'active') {
          return errorResult(`Sequence is ${seq.status}, not active.`);
        }

        if (!seq.allow_reenrollment) {
          const [prior] = await sql`
            SELECT id, status FROM ar_enrollments
            WHERE contact_id = ${contact_id} AND sequence_id = ${sequence_id}
            LIMIT 1
          `;
          if (prior) {
            return errorResult(
              `Contact already has an enrollment (${prior.status}) and sequence.allow_reenrollment = false`,
            );
          }
        }

        const runAt = start_at ? new Date(start_at) : new Date();
        const [row] = await sql`
          INSERT INTO ar_enrollments (contact_id, sequence_id, version, next_run_at)
          VALUES (${contact_id}, ${sequence_id}, ${seq.version}, ${runAt})
          RETURNING id
        `;
        return textResult(
          `Enrolled contact ${contact_id} into sequence ${sequence_id} (v${seq.version}), next run at ${formatDateTime(runAt)}. Enrollment id: ${row.id}`,
        );
      } catch (e) {
        return errorResult(`enroll_contact failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
