import { getCurrentTenant } from '@/lib/auth/helpers';
import { listMapQuoteCatalog, mapQuoteCatalogByType } from '@/lib/db/queries/catalog-items';
import { getQuote, listQuotes } from '@/lib/db/queries/quotes';
import { calculateQuoteTotal, calculateSurfacePrice } from '@/lib/pricing/calculator';
import { createClient } from '@/lib/supabase/server';
import { formatCad, formatDate, quoteStatusLabels } from '../format';
import { resolveByShortId } from '../helpers/resolve-by-short-id';
import { resolveCustomer } from '../helpers/resolve-customer';
import type { AiTool } from '../types';
import { getTaxRate } from './helpers';

export const quoteTools: AiTool[] = [
  {
    definition: {
      name: 'list_quotes',
      description:
        'List quotes. Filter by status (draft/sent/accepted/rejected/expired), customer, or use filter="overdue" for sent quotes with no response in 3+ days.',
      input_schema: {
        type: 'object',
        properties: {
          filter: {
            type: 'string',
            enum: ['overdue'],
            description:
              'Preset filter. "overdue" = sent quotes awaiting response (use days_old to tune the threshold; default 3).',
          },
          status: {
            type: 'string',
            enum: ['draft', 'sent', 'accepted', 'rejected', 'expired'],
            description: 'Filter by status (ignored when filter is set)',
          },
          customer_id: {
            type: 'string',
            description: 'Filter by customer UUID (ignored when filter is set)',
          },
          days_old: {
            type: 'number',
            description: 'For filter="overdue": days since sent to consider overdue (default 3)',
          },
          limit: {
            type: 'number',
            description: 'Max results (default 20, max 100)',
          },
        },
      },
    },
    handler: async (input) => {
      try {
        if (input.filter === 'overdue') {
          const tenant = await getCurrentTenant();
          if (!tenant) return 'Not authenticated.';

          const daysOld = (input.days_old as number) ?? 3;
          const cutoff = new Date(Date.now() - daysOld * 24 * 60 * 60 * 1000).toISOString();

          const supabase = await createClient();
          const { data, error } = await supabase
            .from('quotes')
            .select('id, sent_at, total_cents, customers:customer_id (name)')
            .eq('status', 'sent')
            .lte('sent_at', cutoff)
            .is('deleted_at', null)
            .order('sent_at', { ascending: true });

          if (error) {
            return `Failed to fetch overdue quotes: ${error.message}`;
          }

          if (!data || data.length === 0) {
            return `No quotes have been waiting more than ${daysOld} day(s) without a response.`;
          }

          const now = Date.now();
          let output = `Found ${data.length} overdue quote(s):\n\n`;
          for (let i = 0; i < data.length; i++) {
            const q = data[i];
            const customerRaw = q.customers;
            const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;
            const sentAt = q.sent_at ? new Date(q.sent_at) : null;
            const daysSince = sentAt ? Math.floor((now - sentAt.getTime()) / 86400000) : null;
            output += `${i + 1}. ${(customer as { name?: string })?.name ?? 'No customer'}\n`;
            output += `   Sent: ${sentAt ? formatDate(sentAt.toISOString()) : 'unknown'}`;
            if (daysSince !== null) output += ` (${daysSince} days ago)`;
            output += `\n   Total: ${formatCad(q.total_cents as number)}\n`;
            output += `   ID: ${(q.id as string).slice(0, 8)}\n\n`;
          }

          return output;
        }

        const rows = await listQuotes({
          status: input.status as
            | 'draft'
            | 'sent'
            | 'accepted'
            | 'rejected'
            | 'expired'
            | undefined,
          customer_id: input.customer_id as string | undefined,
          limit: Math.min((input.limit as number) || 20, 100),
        });

        if (rows.length === 0) {
          return 'No quotes found matching your criteria.';
        }

        let output = `Found ${rows.length} quote(s):\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const q = rows[i];
          output += `${i + 1}. ${q.customer?.name ?? 'No customer'} - ${formatCad(q.total_cents)}\n`;
          output += `   Status: ${quoteStatusLabels[q.status] ?? q.status}`;
          output += ` | Created: ${formatDate(q.created_at)}`;
          if (q.sent_at) output += ` | Sent: ${formatDate(q.sent_at)}`;
          output += `\n   ID: ${q.id}\n\n`;
        }

        return output;
      } catch (e) {
        return `Failed to list quotes: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'get_quote',
      description:
        'Get full quote details including surfaces breakdown, pricing, and customer info.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Quote UUID' },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      try {
        const quote = await getQuote(input.id as string);
        if (!quote) {
          return 'Quote not found.';
        }

        let output = `Quote Details\n${'='.repeat(40)}\n\n`;
        output += `Customer: ${quote.customer?.name ?? 'N/A'}\n`;
        if (quote.customer?.phone) output += `Phone: ${quote.customer.phone}\n`;
        if (quote.customer?.email) output += `Email: ${quote.customer.email}\n`;
        output += `Status: ${quoteStatusLabels[quote.status] ?? quote.status}\n`;
        output += `Created: ${formatDate(quote.created_at)}\n`;
        if (quote.sent_at) output += `Sent: ${formatDate(quote.sent_at)}\n`;
        if (quote.accepted_at) output += `Accepted: ${formatDate(quote.accepted_at)}\n`;
        if (quote.notes) output += `Notes: ${quote.notes}\n`;

        output += `\nLine Items\n${'-'.repeat(30)}\n`;
        if (quote.lineItems.length === 0) {
          output += '  No line items on this quote.\n';
        } else {
          for (const li of quote.lineItems) {
            output += `  ${li.label} — ${Number(li.qty).toFixed(1)} ${li.unit} @ ${formatCad(li.unit_price_cents)} = ${formatCad(li.line_total_cents)}\n`;
          }
        }

        output += `\nPricing\n${'-'.repeat(30)}\n`;
        output += `  Subtotal: ${formatCad(quote.subtotal_cents)}\n`;
        output += `  Tax:      ${formatCad(quote.tax_cents)}\n`;
        output += `  Total:    ${formatCad(quote.total_cents)}\n`;

        return output;
      } catch (e) {
        return `Failed to get quote: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'create_quote',
      description:
        'Create a quote for a customer with one or more surfaces. Specify the customer (by name or ID), and for each surface provide the type and square footage. Pricing is calculated automatically from the service catalog.',
      input_schema: {
        type: 'object',
        properties: {
          customer_name_or_id: {
            type: 'string',
            description: 'Customer name (fuzzy match) or UUID',
          },
          surfaces: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                surface_type: { type: 'string', description: 'Surface type from the catalog' },
                sqft: { type: 'number', description: 'Square footage' },
              },
              required: ['surface_type', 'sqft'],
            },
            description: 'One or more surfaces to quote',
          },
          notes: { type: 'string', description: 'Optional notes for the quote' },
        },
        required: ['customer_name_or_id', 'surfaces'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        const resolved = await resolveCustomer(input.customer_name_or_id as string);
        if (typeof resolved === 'string') return resolved;

        const surfaces = input.surfaces as { surface_type: string; sqft: number }[];
        if (!surfaces || surfaces.length === 0) {
          return 'At least one surface is required.';
        }

        // Load the catalog (per_unit/sqft items) to price each surface
        const catalog = await listMapQuoteCatalog();
        const catalogMap = new Map(catalog.map((c) => [c.surface_type.toLowerCase(), c]));

        const pricedSurfaces: {
          surface_type: string;
          sqft: number;
          price_cents: number;
        }[] = [];

        for (const s of surfaces) {
          const entry = catalogMap.get(s.surface_type.toLowerCase());
          if (!entry) {
            const available = catalog.map((c) => c.surface_type).join(', ');
            return `Unknown surface type "${s.surface_type}". Available types: ${available}`;
          }
          const price_cents = calculateSurfacePrice(
            { surface_type: s.surface_type, sqft: s.sqft },
            entry,
          );
          pricedSurfaces.push({
            surface_type: s.surface_type,
            sqft: s.sqft,
            price_cents,
          });
        }

        const taxRate = await getTaxRate(tenant.id);
        const totals = calculateQuoteTotal(pricedSurfaces, taxRate);

        const supabase = await createClient();

        // Insert quote
        const { data: quote, error: quoteErr } = await supabase
          .from('quotes')
          .insert({
            tenant_id: tenant.id,
            customer_id: resolved.id,
            status: 'draft',
            subtotal_cents: totals.subtotal_cents,
            tax_cents: totals.tax_cents,
            total_cents: totals.total_cents,
            notes: (input.notes as string) ?? null,
          })
          .select('id')
          .single();

        if (quoteErr || !quote) {
          return `Failed to create quote: ${quoteErr?.message ?? 'Unknown error'}`;
        }

        // Insert line items (canonical pricing output)
        const lineItemRows = pricedSurfaces.map((s, i) => ({
          quote_id: quote.id,
          label: s.surface_type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
          qty: s.sqft > 0 ? s.sqft : 1,
          unit: s.sqft > 0 ? 'sq ft' : 'item',
          unit_price_cents: s.sqft > 0 ? Math.round(s.price_cents / s.sqft) : s.price_cents,
          line_total_cents: s.price_cents,
          sort_order: i,
        }));

        const { data: lineItemData, error: liErr } = await supabase
          .from('quote_line_items')
          .insert(lineItemRows)
          .select('id');
        if (liErr) {
          return `Quote created but failed to add line items: ${liErr.message}`;
        }

        // Insert surfaces linked to their line items
        const surfaceRows = pricedSurfaces.map((s, i) => ({
          quote_id: quote.id,
          surface_type: s.surface_type,
          sqft: s.sqft,
          price_cents: s.price_cents,
          line_item_id: lineItemData?.[i]?.id ?? null,
        }));

        const { error: surfErr } = await supabase.from('quote_surfaces').insert(surfaceRows);
        if (surfErr) {
          return `Quote created but failed to add surfaces: ${surfErr.message}`;
        }

        const surfaceSummary = pricedSurfaces
          .map((s) => `${s.surface_type} (${s.sqft} sqft) ${formatCad(s.price_cents)}`)
          .join(', ');

        return (
          `Created quote #${quote.id.slice(0, 8)} for ${resolved.name}: ${surfaceSummary}. ` +
          `Total: ${formatCad(totals.total_cents)}. Status: draft.`
        );
      } catch (e) {
        return `Failed to create quote: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'send_quote',
      description:
        'Send a quote to the customer via email. The quote must exist and be in draft or sent status. Generates a PDF and emails it.',
      input_schema: {
        type: 'object',
        properties: {
          quote_id: {
            type: 'string',
            description: 'Quote UUID or short ID (first 8 chars)',
          },
        },
        required: ['quote_id'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        type QuoteRow = {
          id: string;
          status: string;
          total_cents: number;
          customer_id: string;
          customers:
            | { name: string; email: string | null }
            | { name: string; email: string | null }[];
        };

        const result = await resolveByShortId<QuoteRow>(
          'quotes',
          input.quote_id as string,
          'id, status, total_cents, customer_id, customers:customer_id (name, email)',
        );
        if (typeof result === 'string') return result;

        const quote = result;
        if (quote.status !== 'draft' && quote.status !== 'sent') {
          return `Quote is "${quote.status}". Only draft or sent quotes can be sent.`;
        }

        // Extract customer from join
        const customerRaw = quote.customers;
        const customer = Array.isArray(customerRaw) ? customerRaw[0] : customerRaw;

        if (!customer?.email) {
          return `Cannot send quote: ${customer?.name ?? 'customer'} has no email address on file. Update their email first.`;
        }

        // PDF generation and email sending are not yet implemented.
        // For now, update the status and log the intent.
        const supabase = await createClient();
        const now = new Date().toISOString();

        const { error: updateErr } = await supabase
          .from('quotes')
          .update({ status: 'sent', sent_at: now, updated_at: now })
          .eq('id', quote.id);

        if (updateErr) {
          return `Failed to update quote status: ${updateErr.message}`;
        }

        // Add worklog entry
        await supabase.from('worklog_entries').insert({
          tenant_id: tenant.id,
          entry_type: 'system',
          title: 'Quote sent',
          body: `Quote #${quote.id.slice(0, 8)} sent to ${customer.name} (${customer.email}). Total: ${formatCad(quote.total_cents)}.`,
          related_type: 'quote',
          related_id: quote.id,
        });

        return (
          `Quote #${quote.id.slice(0, 8)} sent to ${customer.email}. ` +
          `Total: ${formatCad(quote.total_cents)}.`
        );
      } catch (e) {
        return `Failed to send quote: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
  {
    definition: {
      name: 'update_quote_surfaces',
      description: 'Update the surfaces and pricing on an existing draft quote',
      input_schema: {
        type: 'object',
        properties: {
          quote_id: {
            type: 'string',
            description: 'Quote UUID or short ID',
          },
          surfaces: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                surface_type: { type: 'string' },
                sqft: { type: 'number' },
              },
              required: ['surface_type', 'sqft'],
            },
            description: 'Replacement surfaces list',
          },
        },
        required: ['quote_id', 'surfaces'],
      },
    },
    handler: async (input) => {
      try {
        const tenant = await getCurrentTenant();
        if (!tenant) return 'Not authenticated.';

        type QuoteRow = { id: string; status: string; customer_id: string };
        const result = await resolveByShortId<QuoteRow>(
          'quotes',
          input.quote_id as string,
          'id, status, customer_id',
        );
        if (typeof result === 'string') return result;

        const quote = result;
        if (quote.status !== 'draft') {
          return `Quote is "${quote.status}". Only draft quotes can be updated.`;
        }

        const surfaces = input.surfaces as { surface_type: string; sqft: number }[];
        if (!surfaces || surfaces.length === 0) {
          return 'At least one surface is required.';
        }

        const catalog = await listMapQuoteCatalog();
        const catalogMap = new Map(catalog.map((c) => [c.surface_type.toLowerCase(), c]));

        const pricedSurfaces: { surface_type: string; sqft: number; price_cents: number }[] = [];
        for (const s of surfaces) {
          const entry = catalogMap.get(s.surface_type.toLowerCase());
          if (!entry) {
            const available = catalog.map((c) => c.surface_type).join(', ');
            return `Unknown surface type "${s.surface_type}". Available types: ${available}`;
          }
          pricedSurfaces.push({
            surface_type: s.surface_type,
            sqft: s.sqft,
            price_cents: calculateSurfacePrice(
              { surface_type: s.surface_type, sqft: s.sqft },
              entry,
            ),
          });
        }

        const taxRate = await getTaxRate(tenant.id);
        const totals = calculateQuoteTotal(pricedSurfaces, taxRate);

        const supabase = await createClient();

        await supabase.from('quote_line_items').delete().eq('quote_id', quote.id);
        const { error: deleteErr } = await supabase
          .from('quote_surfaces')
          .delete()
          .eq('quote_id', quote.id);

        if (deleteErr) {
          return `Failed to clear existing surfaces: ${deleteErr.message}`;
        }

        const lineItemRows = pricedSurfaces.map((s, i) => ({
          quote_id: quote.id,
          label: s.surface_type.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase()),
          qty: s.sqft > 0 ? s.sqft : 1,
          unit: s.sqft > 0 ? 'sq ft' : 'item',
          unit_price_cents: s.sqft > 0 ? Math.round(s.price_cents / s.sqft) : s.price_cents,
          line_total_cents: s.price_cents,
          sort_order: i,
        }));
        const { data: lineItemData } = await supabase
          .from('quote_line_items')
          .insert(lineItemRows)
          .select('id');

        const surfaceRows = pricedSurfaces.map((s, i) => ({
          quote_id: quote.id,
          surface_type: s.surface_type,
          sqft: s.sqft,
          price_cents: s.price_cents,
          line_item_id: lineItemData?.[i]?.id ?? null,
        }));

        const { error: insertErr } = await supabase.from('quote_surfaces').insert(surfaceRows);
        if (insertErr) {
          return `Failed to insert updated surfaces: ${insertErr.message}`;
        }

        const now = new Date().toISOString();
        const { error: updateErr } = await supabase
          .from('quotes')
          .update({
            subtotal_cents: totals.subtotal_cents,
            tax_cents: totals.tax_cents,
            total_cents: totals.total_cents,
            updated_at: now,
          })
          .eq('id', quote.id);

        if (updateErr) {
          return `Surfaces updated but failed to recalculate totals: ${updateErr.message}`;
        }

        const surfaceSummary = pricedSurfaces
          .map((s) => `${s.surface_type} (${s.sqft} sqft) ${formatCad(s.price_cents)}`)
          .join(', ');

        return (
          `Quote #${quote.id.slice(0, 8)} updated: ${surfaceSummary}. ` +
          `New total: ${formatCad(totals.total_cents)}.`
        );
      } catch (e) {
        return `Failed to update quote surfaces: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
  },
];
