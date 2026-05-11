import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDb } from '../db.js';
import { errorResult, formatCad, textResult } from '../types.js';

export function registerCatalogTools(server: McpServer, tenantId: string) {
  server.tool(
    'list_catalog',
    'List the pricebook (services, parts, labour rates, project-priced work). Supports flat-rate, per-unit, hourly, and time-and-materials pricing.',
    {},
    async () => {
      const sql = getDb();
      try {
        const rows = await sql`
          SELECT name, description, pricing_model, unit_label, unit_price_cents,
                 min_charge_cents, category, is_active
          FROM catalog_items
          WHERE tenant_id = ${tenantId}
          ORDER BY name ASC
        `;

        if (rows.length === 0) {
          return textResult('No pricebook items found. Add items in /settings/pricebook first.');
        }

        let output = `Pricebook\n${'='.repeat(40)}\n\n`;
        for (const item of rows) {
          const status = item.is_active ? '' : ' [INACTIVE]';
          const category = item.category ? ` · ${item.category}` : '';
          output += `${item.name}${status}${category}\n`;

          switch (item.pricing_model) {
            case 'fixed':
              if (item.unit_price_cents != null) {
                output += `  Flat rate: ${formatCad(item.unit_price_cents)}\n`;
              }
              break;
            case 'per_unit':
              if (item.unit_price_cents != null) {
                output += `  Per ${item.unit_label ?? 'unit'}: ${formatCad(item.unit_price_cents)}\n`;
              }
              if (item.min_charge_cents != null && item.min_charge_cents > 0) {
                output += `  Minimum charge: ${formatCad(item.min_charge_cents)}\n`;
              }
              break;
            case 'hourly':
              if (item.unit_price_cents != null) {
                output += `  Hourly rate: ${formatCad(item.unit_price_cents)}/hr\n`;
              }
              break;
            case 'time_and_materials':
              output += `  Time & materials (priced per job)\n`;
              break;
          }
          if (item.description) {
            output += `  Note: ${item.description}\n`;
          }
          output += `\n`;
        }

        return textResult(output);
      } catch (e) {
        return errorResult(
          `Failed to list pricebook: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );
}
