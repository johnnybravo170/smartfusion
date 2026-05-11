import { listCatalogItems } from '@/lib/db/queries/catalog-items';
import { formatCad } from '../format';
import type { AiTool } from '../types';

export const catalogTools: AiTool[] = [
  {
    definition: {
      name: 'list_catalog',
      description:
        'List the pricebook (services, parts, labour rates, project-priced work). Answers "What do I charge for X?" — supports flat-rate, per-unit, hourly, and time-and-materials pricing.',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    handler: async () => {
      try {
        const rows = await listCatalogItems({ activeOnly: false });

        if (rows.length === 0) {
          return 'No pricebook items found. Add items in /settings/pricebook first.';
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

        return output;
      } catch (e) {
        return `Failed to list pricebook: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
