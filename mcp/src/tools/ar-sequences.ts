/**
 * AR sequence tools — workflow definitions with versioned steps.
 *
 * Versioning: editing steps calls `ar_set_sequence_steps`, which bumps the
 * sequence's `version`, inserts all new steps at the new version, and leaves
 * old versions intact so active enrollments keep walking their pinned path.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { errorResult, formatDateTime, textResult } from '../types.js';

type Scope = string | null;

const StepInput = z.object({
  type: z.enum(['email', 'sms', 'wait', 'branch', 'tag', 'exit']),
  delay_minutes: z.number().int().min(0).default(0),
  template_id: z.string().uuid().optional().describe('Required for email/sms steps'),
  config: z
    .record(z.string(), z.any())
    .optional()
    .describe(
      'Step-type-specific config. For tag: {add:[], remove:[]}. For branch: {if:..., then_position, else_position}',
    ),
});

export function registerArSequenceTools(server: McpServer, scope: Scope) {
  server.tool(
    'ar_list_sequences',
    'List autoresponder sequences in the active scope. Shows status, current version, active enrollment count, and trigger type.',
    {
      status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    },
    async ({ status, limit }) => {
      const sql = getDb();
      try {
        const conditions = [sql`tenant_id IS NOT DISTINCT FROM ${scope}`];
        if (status) conditions.push(sql`status = ${status}`);
        const where = conditions.reduce((a, b) => sql`${a} AND ${b}`);
        const rows = await sql`
          SELECT s.id, s.name, s.status, s.version, s.trigger_type, s.created_at,
                 (SELECT COUNT(*)::int FROM ar_enrollments e
                    WHERE e.sequence_id = s.id AND e.status = 'active') AS active_count,
                 (SELECT COUNT(*)::int FROM ar_steps WHERE sequence_id = s.id AND version = s.version) AS step_count
          FROM ar_sequences s
          WHERE ${where}
          ORDER BY s.updated_at DESC
          LIMIT ${limit}
        `;
        if (rows.length === 0) return textResult('No sequences found.');
        let out = `Found ${rows.length} sequence(s):\n\n`;
        for (const r of rows) {
          out += `• ${r.name} [${r.status}]  v${r.version} · ${r.step_count} step(s) · ${r.active_count} active enrollment(s) · trigger: ${r.trigger_type}\n`;
          out += `  ID: ${r.id}\n\n`;
        }
        return textResult(out.trimEnd());
      } catch (e) {
        return errorResult(`list_sequences failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'ar_get_sequence',
    'Get a sequence with its steps at the current version. Use this before editing to see what the sequence currently looks like.',
    { id: z.string().uuid() },
    async ({ id }) => {
      const sql = getDb();
      try {
        const [seq] = await sql`
          SELECT * FROM ar_sequences
          WHERE id = ${id} AND tenant_id IS NOT DISTINCT FROM ${scope}
        `;
        if (!seq) return errorResult('Sequence not found.');
        const steps = await sql`
          SELECT s.position, s.type, s.delay_minutes, s.template_id, s.config, t.name AS template_name
          FROM ar_steps s
          LEFT JOIN ar_templates t ON t.id = s.template_id
          WHERE s.sequence_id = ${id} AND s.version = ${seq.version}
          ORDER BY s.position ASC
        `;
        let out = `${seq.name} [${seq.status}] v${seq.version}\n`;
        if (seq.description) out += `${seq.description}\n`;
        out += `Trigger: ${seq.trigger_type}\n`;
        out += `Allow re-enrollment: ${seq.allow_reenrollment}\n`;
        out += `Created: ${formatDateTime(seq.created_at)}\n\n`;
        out += `Steps (${steps.length}):\n`;
        for (const s of steps) {
          const delay = s.delay_minutes > 0 ? ` (+${s.delay_minutes} min)` : '';
          const tpl = s.template_name ? ` → ${s.template_name}` : '';
          out += `  ${s.position}. [${s.type}]${delay}${tpl}\n`;
          if (Object.keys(s.config ?? {}).length > 0) {
            out += `     config: ${JSON.stringify(s.config)}\n`;
          }
        }
        return textResult(out);
      } catch (e) {
        return errorResult(`get_sequence failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'ar_create_sequence',
    'Create a new sequence in draft state. After creating, add steps via ar_set_sequence_steps, then activate with ar_set_sequence_status.',
    {
      name: z.string().min(1),
      description: z.string().optional(),
      trigger_type: z.enum(['manual', 'tag_added', 'event', 'signup']).default('manual'),
      trigger_config: z.record(z.string(), z.any()).optional(),
      allow_reenrollment: z.boolean().default(false),
      email_quiet_start: z.number().int().min(0).max(23).optional(),
      email_quiet_end: z.number().int().min(0).max(23).optional(),
      sms_quiet_start: z.number().int().min(0).max(23).optional(),
      sms_quiet_end: z.number().int().min(0).max(23).optional(),
    },
    async (input) => {
      const sql = getDb();
      try {
        const [row] = await sql`
          INSERT INTO ar_sequences (
            tenant_id, name, description, trigger_type, trigger_config, allow_reenrollment,
            email_quiet_start, email_quiet_end, sms_quiet_start, sms_quiet_end
          ) VALUES (
            ${scope}, ${input.name}, ${input.description ?? null},
            ${input.trigger_type}, ${JSON.stringify(input.trigger_config ?? {})}::jsonb,
            ${input.allow_reenrollment},
            ${input.email_quiet_start ?? null}, ${input.email_quiet_end ?? null},
            ${input.sms_quiet_start ?? null}, ${input.sms_quiet_end ?? null}
          )
          RETURNING id
        `;
        return textResult(
          `Created draft sequence ${row.id}. Add steps with ar_set_sequence_steps.`,
        );
      } catch (e) {
        return errorResult(`create_sequence failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'ar_set_sequence_steps',
    'Replace the entire step list of a sequence. Bumps the sequence version: active enrollments keep running against their pinned old version, new enrollments get the new steps. Pass steps in order; position is inferred from array index.',
    {
      sequence_id: z.string().uuid(),
      steps: z.array(StepInput).min(1),
    },
    async ({ sequence_id, steps }) => {
      const sql = getDb();
      try {
        const [seq] = await sql`
          SELECT id, version FROM ar_sequences
          WHERE id = ${sequence_id} AND tenant_id IS NOT DISTINCT FROM ${scope}
        `;
        if (!seq) return errorResult('Sequence not found in this scope.');

        // Validate per-step constraints.
        for (let i = 0; i < steps.length; i++) {
          const s = steps[i];
          if ((s.type === 'email' || s.type === 'sms') && !s.template_id) {
            return errorResult(`Step ${i} (${s.type}) requires template_id.`);
          }
        }

        const newVersion = (seq.version ?? 1) + 1;

        await sql.begin(async (tx) => {
          await tx`UPDATE ar_sequences SET version = ${newVersion}, updated_at = now() WHERE id = ${sequence_id}`;
          for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            await tx`
              INSERT INTO ar_steps (sequence_id, version, position, type, delay_minutes, template_id, config)
              VALUES (
                ${sequence_id}, ${newVersion}, ${i},
                ${s.type}, ${s.delay_minutes}, ${s.template_id ?? null},
                ${JSON.stringify(s.config ?? {})}::jsonb
              )
            `;
          }
        });

        return textResult(
          `Saved ${steps.length} step(s) at version ${newVersion}. New enrollments will use this version; existing active enrollments continue on their pinned version.`,
        );
      } catch (e) {
        return errorResult(
          `set_sequence_steps failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.tool(
    'ar_set_sequence_status',
    'Change a sequence status. draft → active publishes it. active → paused freezes enrollments (they resume when you unpause). active → archived stops accepting new enrollments and cancels active ones.',
    {
      sequence_id: z.string().uuid(),
      status: z.enum(['draft', 'active', 'paused', 'archived']),
    },
    async ({ sequence_id, status }) => {
      const sql = getDb();
      try {
        const [seq] = await sql`
          SELECT id, version FROM ar_sequences
          WHERE id = ${sequence_id} AND tenant_id IS NOT DISTINCT FROM ${scope}
        `;
        if (!seq) return errorResult('Sequence not found in this scope.');

        if (status === 'active') {
          const [{ count }] = await sql`
            SELECT COUNT(*)::int AS count FROM ar_steps
            WHERE sequence_id = ${sequence_id} AND version = ${seq.version}
          `;
          if (count === 0) {
            return errorResult('Cannot activate a sequence with no steps. Add steps first.');
          }
        }

        await sql`
          UPDATE ar_sequences SET status = ${status}, updated_at = now()
          WHERE id = ${sequence_id}
        `;

        if (status === 'archived') {
          await sql`
            UPDATE ar_enrollments SET status = 'cancelled'
            WHERE sequence_id = ${sequence_id} AND status = 'active'
          `;
        }

        return textResult(`Sequence ${sequence_id} status → ${status}`);
      } catch (e) {
        return errorResult(
          `set_sequence_status failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );
}
