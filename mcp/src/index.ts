/**
 * Smartfusion MCP Server
 *
 * Standalone MCP server that exposes business data (customers, quotes, jobs,
 * invoices, todos, worklog, catalog) to Claude Desktop or any MCP-compatible
 * client via stdio transport.
 *
 * Auth: tenant_id passed via env var. Connects with service_role key
 * (bypasses RLS) but always filters by tenant_id explicitly.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerCatalogTools } from './tools/catalog.js';
import { registerCustomerTools } from './tools/customers.js';
import { registerDashboardTools } from './tools/dashboard.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerJobTools } from './tools/jobs.js';
import { registerQuoteTools } from './tools/quotes.js';
import { registerTodoTools } from './tools/todos.js';
import { registerWorklogTools } from './tools/worklog.js';

const TENANT_ID = process.env.SMARTFUSION_TENANT_ID;
const DATABASE_URL = process.env.SMARTFUSION_DATABASE_URL;

if (!TENANT_ID || !DATABASE_URL) {
  process.stderr.write(
    'Error: Required environment variables SMARTFUSION_TENANT_ID and SMARTFUSION_DATABASE_URL must be set.\n',
  );
  process.exit(1);
}

const server = new McpServer({
  name: 'smartfusion',
  version: '1.0.0',
});

// Register all tool groups
registerDashboardTools(server, TENANT_ID);
registerCustomerTools(server, TENANT_ID);
registerQuoteTools(server, TENANT_ID);
registerJobTools(server, TENANT_ID);
registerInvoiceTools(server, TENANT_ID);
registerTodoTools(server, TENANT_ID);
registerWorklogTools(server, TENANT_ID);
registerCatalogTools(server, TENANT_ID);

const transport = new StdioServerTransport();
await server.connect(transport);
