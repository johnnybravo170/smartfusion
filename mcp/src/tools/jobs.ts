import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { errorResult, formatDate, formatDateTime, jobStatusLabels, textResult } from '../types.js';

export function registerJobTools(server: McpServer, tenantId: string) {
  server.tool(
    'list_jobs',
    'List jobs. Filter by status (booked/in_progress/complete/cancelled) or customer.',
    {
      status: z
        .enum(['booked', 'in_progress', 'complete', 'cancelled'])
        .optional()
        .describe('Filter by job status'),
      customer_id: z.string().uuid().optional().describe('Filter by customer UUID'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
    },
    async ({ status, customer_id, limit }) => {
      const sql = getDb();
      try {
        const conditions = [sql`j.tenant_id = ${tenantId}`, sql`j.deleted_at IS NULL`];
        if (status) conditions.push(sql`j.status = ${status}`);
        if (customer_id) conditions.push(sql`j.customer_id = ${customer_id}`);

        const where = conditions.reduce((a, b) => sql`${a} AND ${b}`);
        const rows = await sql`
          SELECT j.id, j.status, j.scheduled_at, j.completed_at, j.notes,
                 c.name AS customer_name
          FROM jobs j
          LEFT JOIN customers c ON c.id = j.customer_id
          WHERE ${where}
          ORDER BY COALESCE(j.scheduled_at, j.created_at) DESC
          LIMIT ${limit}
        `;

        if (rows.length === 0) {
          return textResult('No jobs found matching your criteria.');
        }

        let output = `Found ${rows.length} job(s):\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const j = rows[i];
          output += `${i + 1}. ${j.customer_name || 'No customer'}\n`;
          output += `   Status: ${jobStatusLabels[j.status] || j.status}`;
          if (j.scheduled_at) output += ` | Scheduled: ${formatDateTime(j.scheduled_at)}`;
          if (j.completed_at) output += ` | Completed: ${formatDate(j.completed_at)}`;
          output += `\n`;
          if (j.notes) output += `   Notes: ${j.notes}\n`;
          output += `   ID: ${j.id}\n\n`;
        }

        return textResult(output);
      } catch (e) {
        return errorResult(`Failed to list jobs: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'get_job',
    'Get full job details including customer, quote link, invoice link, and recent worklog entries.',
    {
      id: z.string().uuid().describe('Job UUID'),
    },
    async ({ id }) => {
      const sql = getDb();
      try {
        const [job] = await sql`
          SELECT j.*,
                 c.name AS customer_name, c.phone AS customer_phone,
                 q.total_cents AS quote_total,
                 i.id AS invoice_id, i.status AS invoice_status, i.amount_cents AS invoice_amount,
                 i.tax_cents AS invoice_tax
          FROM jobs j
          LEFT JOIN customers c ON c.id = j.customer_id
          LEFT JOIN quotes q ON q.id = j.quote_id
          LEFT JOIN invoices i ON i.job_id = j.id AND i.deleted_at IS NULL
          WHERE j.id = ${id} AND j.tenant_id = ${tenantId} AND j.deleted_at IS NULL
        `;

        if (!job) {
          return errorResult('Job not found.');
        }

        const worklog = await sql`
          SELECT title, body, entry_type, created_at
          FROM worklog_entries
          WHERE tenant_id = ${tenantId}
            AND related_type = 'job'
            AND related_id = ${id}
          ORDER BY created_at DESC
          LIMIT 5
        `;

        let output = `Job Details\n${'='.repeat(40)}\n\n`;
        output += `Customer: ${job.customer_name || 'N/A'}`;
        if (job.customer_phone) output += ` (${job.customer_phone})`;
        output += `\nStatus: ${jobStatusLabels[job.status] || job.status}\n`;
        if (job.scheduled_at) output += `Scheduled: ${formatDateTime(job.scheduled_at)}\n`;
        if (job.started_at) output += `Started: ${formatDateTime(job.started_at)}\n`;
        if (job.completed_at) output += `Completed: ${formatDateTime(job.completed_at)}\n`;
        if (job.notes) output += `Notes: ${job.notes}\n`;

        if (job.quote_id) {
          const { formatCad } = await import('../types.js');
          output += `\nLinked Quote: ${job.quote_id}\n`;
          if (job.quote_total != null) output += `  Quote Total: ${formatCad(job.quote_total)}\n`;
        }

        if (job.invoice_id) {
          const { formatCad, invoiceStatusLabels } = await import('../types.js');
          output += `\nLinked Invoice: ${job.invoice_id}\n`;
          output += `  Invoice Status: ${invoiceStatusLabels[job.invoice_status] || job.invoice_status}\n`;
          output += `  Invoice Amount: ${formatCad(job.invoice_amount + job.invoice_tax)}\n`;
        }

        if (worklog.length > 0) {
          output += `\nRecent Worklog\n${'-'.repeat(30)}\n`;
          for (const w of worklog) {
            output += `  [${formatDate(w.created_at)}] ${w.title || '(no title)'}`;
            if (w.body) output += ` - ${w.body}`;
            output += '\n';
          }
        }

        return textResult(output);
      } catch (e) {
        return errorResult(`Failed to get job: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'update_job_status',
    "Change a job's status and log the transition to the worklog. Sets started_at/completed_at timestamps automatically.",
    {
      id: z.string().uuid().describe('Job UUID'),
      status: z.enum(['booked', 'in_progress', 'complete', 'cancelled']).describe('New status'),
    },
    async ({ id, status: newStatus }) => {
      const sql = getDb();
      try {
        // Load current job
        const [job] = await sql`
          SELECT j.id, j.status, j.started_at, j.completed_at, c.name AS customer_name
          FROM jobs j
          LEFT JOIN customers c ON c.id = j.customer_id
          WHERE j.id = ${id} AND j.tenant_id = ${tenantId} AND j.deleted_at IS NULL
        `;

        if (!job) {
          return errorResult('Job not found.');
        }

        const oldStatus = job.status as string;
        if (oldStatus === newStatus) {
          return textResult(
            `Job is already ${jobStatusLabels[newStatus] || newStatus}. No change needed.`,
          );
        }

        // Build update
        const now = new Date().toISOString();
        const updates: Record<string, string> = {
          status: newStatus,
          updated_at: now,
        };
        if (newStatus === 'in_progress' && !job.started_at) {
          updates.started_at = now;
        }
        if (newStatus === 'complete' && !job.completed_at) {
          updates.completed_at = now;
        }

        // Update job status
        if (newStatus === 'in_progress' && !job.started_at) {
          await sql`
            UPDATE jobs SET status = ${newStatus}, updated_at = ${now}, started_at = ${now}
            WHERE id = ${id} AND deleted_at IS NULL
          `;
        } else if (newStatus === 'complete' && !job.completed_at) {
          await sql`
            UPDATE jobs SET status = ${newStatus}, updated_at = ${now}, completed_at = ${now}
            WHERE id = ${id} AND deleted_at IS NULL
          `;
        } else {
          await sql`
            UPDATE jobs SET status = ${newStatus}, updated_at = ${now}
            WHERE id = ${id} AND deleted_at IS NULL
          `;
        }

        // Log to worklog
        const customerName = job.customer_name || 'customer';
        await sql`
          INSERT INTO worklog_entries (tenant_id, entry_type, title, body, related_type, related_id)
          VALUES (
            ${tenantId}, 'system', 'Job status changed',
            ${`Job for ${customerName} moved from ${jobStatusLabels[oldStatus] || oldStatus} to ${jobStatusLabels[newStatus] || newStatus}.`},
            'job', ${id}
          )
        `;

        return textResult(
          `Job status updated: ${jobStatusLabels[oldStatus] || oldStatus} -> ${jobStatusLabels[newStatus] || newStatus}\n` +
            `Customer: ${customerName}\nJob ID: ${id}`,
        );
      } catch (e) {
        return errorResult(
          `Failed to update job status: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );
}
