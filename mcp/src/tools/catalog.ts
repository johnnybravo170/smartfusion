import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db.js';
import { errorResult, formatCad, textResult } from '../types.js';

export function registerCatalogTools(server: McpServer, tenantId: string) {
  server.tool(
    'list_catalog',
    'List the service catalog (surface types and pricing). Answers "What do I charge for driveways?" etc.',
    {},
    async () => {
      const sql = getDb();
      try {
        const rows = await sql`
          SELECT surface_type, label, price_per_sqft_cents, min_charge_cents, is_active
          FROM service_catalog
          WHERE tenant_id = ${tenantId}
          ORDER BY label ASC
        `;

        if (rows.length === 0) {
          return textResult('No service catalog entries found. Add pricing in the web app first.');
        }

        let output = `Service Catalog\n${'='.repeat(40)}\n\n`;
        for (const item of rows) {
          const status = item.is_active ? '' : ' [INACTIVE]';
          output += `${item.label} (${item.surface_type})${status}\n`;
          if (item.price_per_sqft_cents) {
            output += `  Price per sq ft: ${formatCad(item.price_per_sqft_cents)}\n`;
          }
          output += `  Minimum charge: ${formatCad(item.min_charge_cents)}\n\n`;
        }

        return textResult(output);
      } catch (e) {
        return errorResult(`Failed to list catalog: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
