/**
 * HeyHenry MCP Server
 *
 * Standalone MCP server that exposes business data (customers, quotes, jobs,
 * invoices, todos, worklog, catalog) + autoresponder management to Claude
 * Desktop or any MCP-compatible client via stdio transport.
 *
 * Auth: tenant_id passed via env var. Connects with service_role key
 * (bypasses RLS) but always filters by tenant_id explicitly.
 *
 * AR scope:
 *   - HEYHENRY_AR_PLATFORM=1  → AR tools operate on platform scope (tenant_id NULL)
 *   - otherwise               → AR tools operate on HEYHENRY_TENANT_ID
 *
 * TENANT_ID is required for tenant-scoped tools (customers, jobs, etc.). When
 * only AR_PLATFORM is in use (e.g. Jonathan managing Hey Henry's own marketing
 * list), TENANT_ID can be omitted and only AR tools will register.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerArContactTools } from './tools/ar-contacts.js';
import { registerArSequenceTools } from './tools/ar-sequences.js';
import { registerArTemplateTools } from './tools/ar-templates.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerCustomerTools } from './tools/customers.js';
import { registerDashboardTools } from './tools/dashboard.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerJobTools } from './tools/jobs.js';
import { registerQuoteTools } from './tools/quotes.js';
import { registerTodoTools } from './tools/todos.js';
import { registerWorklogTools } from './tools/worklog.js';

// HEYHENRY_* names are canonical; SMARTFUSION_* fall-backs kept for any
// existing MCP configs that haven't been updated yet. Drop after all
// callers migrate.
const TENANT_ID = process.env.HEYHENRY_TENANT_ID ?? process.env.SMARTFUSION_TENANT_ID;
const DATABASE_URL = process.env.HEYHENRY_DATABASE_URL ?? process.env.SMARTFUSION_DATABASE_URL;
const AR_PLATFORM =
  process.env.HEYHENRY_AR_PLATFORM === '1' || process.env.SMARTFUSION_AR_PLATFORM === '1';

if (!DATABASE_URL) {
  process.stderr.write('Error: HEYHENRY_DATABASE_URL must be set.\n');
  process.exit(1);
}
if (!TENANT_ID && !AR_PLATFORM) {
  process.stderr.write(
    'Error: set HEYHENRY_TENANT_ID for tenant tools, or HEYHENRY_AR_PLATFORM=1 for platform AR only.\n',
  );
  process.exit(1);
}

const server = new McpServer({
  name: 'heyhenry',
  version: '1.1.0',
});

// Tenant-scoped tools (skipped when running platform-AR-only).
if (TENANT_ID) {
  registerDashboardTools(server, TENANT_ID);
  registerCustomerTools(server, TENANT_ID);
  registerQuoteTools(server, TENANT_ID);
  registerJobTools(server, TENANT_ID);
  registerInvoiceTools(server, TENANT_ID);
  registerTodoTools(server, TENANT_ID);
  registerWorklogTools(server, TENANT_ID);
  registerCatalogTools(server, TENANT_ID);
}

// AR tools: platform scope (null) when AR_PLATFORM=1, else the tenant's.
const arScope: string | null = AR_PLATFORM ? null : (TENANT_ID as string);
registerArContactTools(server, arScope);
registerArTemplateTools(server, arScope);
registerArSequenceTools(server, arScope);

const transport = new StdioServerTransport();
await server.connect(transport);
