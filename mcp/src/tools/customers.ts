import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getDb } from '../db.js';
import { errorResult, formatDate, textResult } from '../types.js';

export function registerCustomerTools(server: McpServer, tenantId: string) {
  server.tool(
    'list_customers',
    'List customers. Filter by search term, type (residential/commercial/agent), or limit results.',
    {
      search: z.string().optional().describe('Search by name, email, phone, or city'),
      type: z
        .enum(['residential', 'commercial', 'agent'])
        .optional()
        .describe('Filter by customer type'),
      limit: z.number().int().min(1).max(100).default(20).describe('Max results to return'),
    },
    async ({ search, type, limit }) => {
      const sql = getDb();
      try {
        const conditions = [sql`tenant_id = ${tenantId}`, sql`deleted_at IS NULL`];
        if (type) {
          conditions.push(sql`type = ${type}`);
        }
        if (search) {
          const pattern = `%${search}%`;
          conditions.push(
            sql`(name ILIKE ${pattern} OR email ILIKE ${pattern} OR phone ILIKE ${pattern} OR city ILIKE ${pattern})`,
          );
        }

        const where = conditions.reduce((a, b) => sql`${a} AND ${b}`);
        const rows = await sql`
          SELECT id, name, type, email, phone, city, created_at
          FROM customers
          WHERE ${where}
          ORDER BY name ASC
          LIMIT ${limit}
        `;

        if (rows.length === 0) {
          return textResult('No customers found matching your criteria.');
        }

        let output = `Found ${rows.length} customer(s):\n\n`;
        for (let i = 0; i < rows.length; i++) {
          const c = rows[i];
          const parts = [c.name];
          parts.push(`(${c.type})`);
          if (c.city) parts.push(`- ${c.city}`);
          if (c.phone) parts.push(`- ${c.phone}`);
          if (c.email) parts.push(`- ${c.email}`);
          output += `${i + 1}. ${parts.join(' ')}\n`;
          output += `   ID: ${c.id}\n`;
        }

        return textResult(output);
      } catch (e) {
        return errorResult(
          `Failed to list customers: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );

  server.tool(
    'get_customer',
    'Get full details for a specific customer, including counts of related quotes, jobs, and invoices.',
    {
      id: z.string().uuid().describe('Customer UUID'),
    },
    async ({ id }) => {
      const sql = getDb();
      try {
        const [customer] = await sql`
          SELECT * FROM customers
          WHERE id = ${id} AND tenant_id = ${tenantId} AND deleted_at IS NULL
        `;

        if (!customer) {
          return errorResult('Customer not found.');
        }

        const [counts] = await sql`
          SELECT
            (SELECT COUNT(*)::int FROM quotes WHERE customer_id = ${id} AND deleted_at IS NULL) AS quote_count,
            (SELECT COUNT(*)::int FROM jobs WHERE customer_id = ${id} AND deleted_at IS NULL) AS job_count,
            (SELECT COUNT(*)::int FROM invoices WHERE customer_id = ${id} AND deleted_at IS NULL) AS invoice_count
        `;

        let output = `Customer: ${customer.name}\n${'='.repeat(40)}\n\n`;
        output += `Type: ${customer.type}\n`;
        if (customer.email) output += `Email: ${customer.email}\n`;
        if (customer.phone) output += `Phone: ${customer.phone}\n`;
        if (customer.address_line1) output += `Address: ${customer.address_line1}\n`;
        if (customer.city) output += `City: ${customer.city}`;
        if (customer.province) output += `, ${customer.province}`;
        if (customer.postal_code) output += ` ${customer.postal_code}`;
        if (customer.city) output += '\n';
        if (customer.notes) output += `Notes: ${customer.notes}\n`;
        output += `\nCreated: ${formatDate(customer.created_at)}\n`;
        output += `\nRelated Records\n${'-'.repeat(20)}\n`;
        output += `Quotes: ${counts.quote_count}\n`;
        output += `Jobs: ${counts.job_count}\n`;
        output += `Invoices: ${counts.invoice_count}\n`;

        return textResult(output);
      } catch (e) {
        return errorResult(`Failed to get customer: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    'create_customer',
    'Create a new customer. Requires name and type (residential/commercial/agent).',
    {
      name: z.string().min(1).describe('Customer name'),
      type: z.enum(['residential', 'commercial', 'agent']).describe('Customer type'),
      email: z.string().email().optional().describe('Email address'),
      phone: z.string().optional().describe('Phone number'),
      city: z.string().optional().describe('City'),
      notes: z.string().optional().describe('Additional notes'),
    },
    async ({ name, type, email, phone, city, notes }) => {
      const sql = getDb();
      try {
        const [created] = await sql`
          INSERT INTO customers (tenant_id, name, type, email, phone, city, notes)
          VALUES (${tenantId}, ${name}, ${type}, ${email ?? null}, ${phone ?? null}, ${city ?? null}, ${notes ?? null})
          RETURNING id, name, type
        `;

        return textResult(
          `Customer created successfully.\n\nName: ${created.name}\nType: ${created.type}\nID: ${created.id}`,
        );
      } catch (e) {
        return errorResult(
          `Failed to create customer: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
  );
}
