import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db.js';
import { errorResult, formatCad, textResult } from '../types.js';

export function registerDashboardTools(server: McpServer, tenantId: string) {
  server.tool(
    'get_dashboard',
    "Today's business snapshot: quotes sent this week, open jobs, unpaid invoices, and revenue this month.",
    {},
    async () => {
      const sql = getDb();
      try {
        // Quotes sent this week
        const [quotesThisWeek] = await sql`
          SELECT COUNT(*)::int AS count
          FROM quotes
          WHERE tenant_id = ${tenantId}
            AND deleted_at IS NULL
            AND sent_at >= date_trunc('week', now())
        `;

        // Open jobs (booked or in_progress)
        const [openJobs] = await sql`
          SELECT COUNT(*)::int AS count
          FROM jobs
          WHERE tenant_id = ${tenantId}
            AND deleted_at IS NULL
            AND status IN ('booked', 'in_progress')
        `;

        // Unpaid invoices (sent but not paid)
        const [unpaidInvoices] = await sql`
          SELECT
            COUNT(*)::int AS count,
            COALESCE(SUM(amount_cents + tax_cents), 0)::int AS total_cents
          FROM invoices
          WHERE tenant_id = ${tenantId}
            AND deleted_at IS NULL
            AND status = 'sent'
        `;

        // Revenue this month (paid invoices)
        const [revenueThisMonth] = await sql`
          SELECT
            COUNT(*)::int AS count,
            COALESCE(SUM(amount_cents + tax_cents), 0)::int AS total_cents
          FROM invoices
          WHERE tenant_id = ${tenantId}
            AND deleted_at IS NULL
            AND status = 'paid'
            AND paid_at >= date_trunc('month', now())
        `;

        // Upcoming jobs this week
        const upcomingJobs = await sql`
          SELECT j.id, c.name AS customer_name, j.status, j.scheduled_at
          FROM jobs j
          LEFT JOIN customers c ON c.id = j.customer_id
          WHERE j.tenant_id = ${tenantId}
            AND j.deleted_at IS NULL
            AND j.status IN ('booked', 'in_progress')
            AND j.scheduled_at >= now()
            AND j.scheduled_at < now() + interval '7 days'
          ORDER BY j.scheduled_at ASC
          LIMIT 5
        `;

        // Open todos
        const [openTodos] = await sql`
          SELECT COUNT(*)::int AS count
          FROM todos
          WHERE tenant_id = ${tenantId}
            AND done = false
        `;

        let output = `Dashboard Snapshot\n${'='.repeat(40)}\n\n`;
        output += `Quotes sent this week: ${quotesThisWeek.count}\n`;
        output += `Open jobs: ${openJobs.count}\n`;
        output += `Unpaid invoices: ${unpaidInvoices.count} (${formatCad(unpaidInvoices.total_cents)} outstanding)\n`;
        output += `Revenue this month: ${formatCad(revenueThisMonth.total_cents)} from ${revenueThisMonth.count} paid invoice(s)\n`;
        output += `Open todos: ${openTodos.count}\n`;

        if (upcomingJobs.length > 0) {
          output += `\nUpcoming Jobs This Week\n${'-'.repeat(30)}\n`;
          for (const job of upcomingJobs) {
            const when = job.scheduled_at
              ? new Date(job.scheduled_at).toLocaleDateString('en-CA', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })
              : 'Unscheduled';
            output += `  ${job.customer_name || 'Unknown'} - ${when} (${job.status})\n`;
          }
        }

        return textResult(output);
      } catch (e) {
        return errorResult(`Dashboard query failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
