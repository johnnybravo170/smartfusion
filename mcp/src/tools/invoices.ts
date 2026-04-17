import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { errorResult, formatCad, formatDate, invoiceStatusLabels, textResult } from '../types.js';

export function registerInvoiceTools(server: McpServer, tenantId: string) {
  server.tool(
    'list_invoices',
    'List invoices. Filter by status (draft/sent/paid/void).',
    {
      status: z
        .enum(['draft', 'sent', 'paid', 'void'])
        .optional()
        .describe('Filter by invoice status'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
    },
    async ({ status, limit }) => {
      const sql = getDb();
      try {
        const conditions = [sql`inv.tenant_id = ${tenantId}`, sql`inv.deleted_at IS NULL`];
        if (status) conditions.push(sql`inv.status = ${status}`);

        const where = conditions.reduce((a, b) => sql`${a} AND ${b}`);
        const rows = await sql`
          SELECT inv.id, inv.status, inv.amount_cents, inv.tax_cents,
                 inv.sent_at, inv.paid_at, inv.created_at,
                 c.name AS customer_name
          FROM invoices inv
          LEFT JOIN customers c ON c.id = inv.customer_id
          WHERE ${where}
          ORDER BY inv.created_at DESC
          LIMIT ${limit}
        `;

        if (rows.length === 0) {
          return textResult('No invoices found matching your criteria.');
        }

        let output = `Found ${rows.length} invoice(s):\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const inv = rows[i];
          const total = inv.amount_cents + inv.tax_cents;
          output += `${i + 1}. ${inv.customer_name || 'No customer'} - ${formatCad(total)}\n`;
          output += `   Status: ${invoiceStatusLabels[inv.status] || inv.status}`;
          output += ` | Created: ${formatDate(inv.created_at)}`;
          if (inv.sent_at) output += ` | Sent: ${formatDate(inv.sent_at)}`;
          if (inv.paid_at) output += ` | Paid: ${formatDate(inv.paid_at)}`;
          output += `\n   ID: ${inv.id}\n\n`;
        }

        return textResult(output);
      } catch (e) {
        return errorResult(
          `Failed to list invoices: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.tool(
    'get_revenue_summary',
    'Revenue summary: total revenue (paid invoices), count, average, and outstanding amount. Group by period.',
    {
      period: z
        .enum(['week', 'month', 'quarter', 'year'])
        .default('month')
        .describe('Time period for revenue'),
    },
    async ({ period }) => {
      const sql = getDb();
      try {
        const truncExpr =
          period === 'week'
            ? sql`date_trunc('week', now())`
            : period === 'quarter'
              ? sql`date_trunc('quarter', now())`
              : period === 'year'
                ? sql`date_trunc('year', now())`
                : sql`date_trunc('month', now())`;

        const [revenue] = await sql`
          SELECT
            COUNT(*)::int AS invoice_count,
            COALESCE(SUM(amount_cents + tax_cents), 0)::int AS total_cents,
            COALESCE(AVG(amount_cents + tax_cents), 0)::int AS avg_cents
          FROM invoices
          WHERE tenant_id = ${tenantId}
            AND status = 'paid'
            AND paid_at >= ${truncExpr}
            AND deleted_at IS NULL
        `;

        const [outstanding] = await sql`
          SELECT
            COUNT(*)::int AS count,
            COALESCE(SUM(amount_cents + tax_cents), 0)::int AS total_cents
          FROM invoices
          WHERE tenant_id = ${tenantId}
            AND status = 'sent'
            AND deleted_at IS NULL
        `;

        const periodLabel = period.charAt(0).toUpperCase() + period.slice(1);

        let output = `Revenue Summary (This ${periodLabel})\n${'='.repeat(40)}\n\n`;
        output += `Paid Invoices: ${revenue.invoice_count}\n`;
        output += `Total Revenue: ${formatCad(revenue.total_cents)}\n`;
        output += `Average Invoice: ${formatCad(revenue.avg_cents)}\n`;
        output += `\nOutstanding (Sent, Unpaid)\n${'-'.repeat(30)}\n`;
        output += `Unpaid Invoices: ${outstanding.count}\n`;
        output += `Outstanding Amount: ${formatCad(outstanding.total_cents)}\n`;

        return textResult(output);
      } catch (e) {
        return errorResult(
          `Failed to get revenue summary: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );
}
