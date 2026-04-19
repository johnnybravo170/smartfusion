/**
 * AR template tools — reusable email/SMS content with merge tags.
 *
 * Bodies support {{merge_tag}} substitution. Standard tags: first_name,
 * last_name, email, phone, plus any keys on contact.attributes.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { errorResult, textResult } from '../types.js';

type Scope = string | null;

export function registerArTemplateTools(server: McpServer, scope: Scope) {
  server.tool(
    'ar_list_templates',
    'List autoresponder templates in the active scope. Returns id, name, channel (email/sms), and subject line for email templates.',
    {
      channel: z.enum(['email', 'sms']).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    async ({ channel, limit }) => {
      const sql = getDb();
      try {
        const conditions = [sql`tenant_id IS NOT DISTINCT FROM ${scope}`];
        if (channel) conditions.push(sql`channel = ${channel}`);
        const where = conditions.reduce((a, b) => sql`${a} AND ${b}`);
        const rows = await sql`
          SELECT id, name, channel, subject, updated_at
          FROM ar_templates
          WHERE ${where}
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `;
        if (rows.length === 0) return textResult('No templates found.');
        let out = `Found ${rows.length} template(s):\n\n`;
        for (const r of rows) {
          out += `• [${r.channel}] ${r.name}\n`;
          if (r.subject) out += `    subject: ${r.subject}\n`;
          out += `    ID: ${r.id}\n\n`;
        }
        return textResult(out.trimEnd());
      } catch (e) {
        return errorResult(`list_templates failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'ar_get_template',
    'Get the full body of a template by id. Use this before editing to see current content.',
    { id: z.string().uuid() },
    async ({ id }) => {
      const sql = getDb();
      try {
        const [row] = await sql`
          SELECT * FROM ar_templates
          WHERE id = ${id} AND tenant_id IS NOT DISTINCT FROM ${scope}
        `;
        if (!row) return errorResult('Template not found.');
        let out = `[${row.channel}] ${row.name}\n`;
        if (row.subject) out += `Subject: ${row.subject}\n`;
        if (row.from_email)
          out += `From: ${row.from_name ? `${row.from_name} <${row.from_email}>` : row.from_email}\n`;
        if (row.reply_to) out += `Reply-To: ${row.reply_to}\n`;
        if (row.body_html) out += `\n--- HTML ---\n${row.body_html}\n`;
        if (row.body_text) out += `\n--- TEXT ---\n${row.body_text}\n`;
        return textResult(out);
      } catch (e) {
        return errorResult(`get_template failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'ar_upsert_template',
    'Create or update a template. Pass `id` to update an existing one, omit it to create. For email: subject + body_html and/or body_text. For sms: body_text only. Merge tags: {{first_name}}, {{email}}, etc.',
    {
      id: z.string().uuid().optional(),
      name: z.string().min(1),
      channel: z.enum(['email', 'sms']),
      subject: z.string().optional(),
      body_html: z.string().optional(),
      body_text: z.string().optional(),
      from_name: z.string().optional(),
      from_email: z.string().email().optional(),
      reply_to: z.string().email().optional(),
    },
    async (input) => {
      const sql = getDb();
      try {
        if (input.channel === 'email' && !input.subject) {
          return errorResult('Email templates require a subject.');
        }
        if (input.channel === 'email' && !input.body_html && !input.body_text) {
          return errorResult('Email templates require body_html or body_text.');
        }
        if (input.channel === 'sms' && !input.body_text) {
          return errorResult('SMS templates require body_text.');
        }

        if (input.id) {
          const [existing] = await sql`
            SELECT id FROM ar_templates
            WHERE id = ${input.id} AND tenant_id IS NOT DISTINCT FROM ${scope}
          `;
          if (!existing) return errorResult('Template not found in this scope.');
          await sql`
            UPDATE ar_templates SET
              name = ${input.name},
              channel = ${input.channel},
              subject = ${input.subject ?? null},
              body_html = ${input.body_html ?? null},
              body_text = ${input.body_text ?? null},
              from_name = ${input.from_name ?? null},
              from_email = ${input.from_email ?? null},
              reply_to = ${input.reply_to ?? null},
              updated_at = now()
            WHERE id = ${input.id}
          `;
          return textResult(`Updated template ${input.id}`);
        }

        const [row] = await sql`
          INSERT INTO ar_templates (tenant_id, name, channel, subject, body_html, body_text, from_name, from_email, reply_to)
          VALUES (
            ${scope}, ${input.name}, ${input.channel},
            ${input.subject ?? null}, ${input.body_html ?? null}, ${input.body_text ?? null},
            ${input.from_name ?? null}, ${input.from_email ?? null}, ${input.reply_to ?? null}
          )
          RETURNING id
        `;
        return textResult(`Created template ${row.id}`);
      } catch (e) {
        return errorResult(`upsert_template failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
