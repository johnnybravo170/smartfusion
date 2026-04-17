import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { errorResult, formatCad, formatDate, quoteStatusLabels, textResult } from '../types.js';

export function registerQuoteTools(server: McpServer, tenantId: string) {
  server.tool(
    'list_quotes',
    'List quotes. Filter by status (draft/sent/accepted/rejected/expired) or customer.',
    {
      status: z
        .enum(['draft', 'sent', 'accepted', 'rejected', 'expired'])
        .optional()
        .describe('Filter by status'),
      customer_id: z.string().uuid().optional().describe('Filter by customer UUID'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max results'),
    },
    async ({ status, customer_id, limit }) => {
      const sql = getDb();
      try {
        const conditions = [sql`q.tenant_id = ${tenantId}`, sql`q.deleted_at IS NULL`];
        if (status) conditions.push(sql`q.status = ${status}`);
        if (customer_id) conditions.push(sql`q.customer_id = ${customer_id}`);

        const where = conditions.reduce((a, b) => sql`${a} AND ${b}`);
        const rows = await sql`
          SELECT
            q.id, q.status, q.total_cents, q.created_at, q.sent_at,
            c.name AS customer_name,
            (SELECT COUNT(*)::int FROM quote_surfaces qs WHERE qs.quote_id = q.id) AS surface_count
          FROM quotes q
          LEFT JOIN customers c ON c.id = q.customer_id
          WHERE ${where}
          ORDER BY q.created_at DESC
          LIMIT ${limit}
        `;

        if (rows.length === 0) {
          return textResult('No quotes found matching your criteria.');
        }

        let output = `Found ${rows.length} quote(s):\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const q = rows[i];
          output += `${i + 1}. ${q.customer_name || 'No customer'} - ${formatCad(q.total_cents)}\n`;
          output += `   Status: ${quoteStatusLabels[q.status] || q.status}`;
          output += ` | Surfaces: ${q.surface_count}`;
          output += ` | Created: ${formatDate(q.created_at)}`;
          if (q.sent_at) output += ` | Sent: ${formatDate(q.sent_at)}`;
          output += `\n   ID: ${q.id}\n\n`;
        }

        return textResult(output);
      } catch (e) {
        return errorResult(`Failed to list quotes: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'get_quote',
    'Get full quote details including surfaces breakdown, pricing, and customer info.',
    {
      id: z.string().uuid().describe('Quote UUID'),
    },
    async ({ id }) => {
      const sql = getDb();
      try {
        const [quote] = await sql`
          SELECT q.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email
          FROM quotes q
          LEFT JOIN customers c ON c.id = q.customer_id
          WHERE q.id = ${id} AND q.tenant_id = ${tenantId} AND q.deleted_at IS NULL
        `;

        if (!quote) {
          return errorResult('Quote not found.');
        }

        const surfaces = await sql`
          SELECT surface_type, sqft, price_cents, notes
          FROM quote_surfaces
          WHERE quote_id = ${id}
          ORDER BY created_at ASC
        `;

        let output = `Quote Details\n${'='.repeat(40)}\n\n`;
        output += `Customer: ${quote.customer_name || 'N/A'}\n`;
        if (quote.customer_phone) output += `Phone: ${quote.customer_phone}\n`;
        if (quote.customer_email) output += `Email: ${quote.customer_email}\n`;
        output += `Status: ${quoteStatusLabels[quote.status] || quote.status}\n`;
        output += `Created: ${formatDate(quote.created_at)}\n`;
        if (quote.sent_at) output += `Sent: ${formatDate(quote.sent_at)}\n`;
        if (quote.accepted_at) output += `Accepted: ${formatDate(quote.accepted_at)}\n`;
        if (quote.notes) output += `Notes: ${quote.notes}\n`;

        output += `\nSurfaces\n${'-'.repeat(30)}\n`;
        if (surfaces.length === 0) {
          output += '  No surfaces on this quote.\n';
        } else {
          for (const s of surfaces) {
            output += `  ${s.surface_type}`;
            if (s.sqft) output += ` (${s.sqft} sq ft)`;
            output += ` - ${formatCad(s.price_cents)}`;
            if (s.notes) output += ` -- ${s.notes}`;
            output += '\n';
          }
        }

        output += `\nPricing\n${'-'.repeat(30)}\n`;
        output += `  Subtotal: ${formatCad(quote.subtotal_cents)}\n`;
        output += `  Tax:      ${formatCad(quote.tax_cents)}\n`;
        output += `  Total:    ${formatCad(quote.total_cents)}\n`;

        return textResult(output);
      } catch (e) {
        return errorResult(`Failed to get quote: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
