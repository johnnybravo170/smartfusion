/**
 * Smoke test for the Smartfusion MCP server.
 *
 * Connects to the MCP server programmatically via stdio, calls every tool,
 * and verifies responses are non-empty.
 *
 * Usage:
 *   SMARTFUSION_TENANT_ID=... SMARTFUSION_DATABASE_URL=... npx tsx test-tools.ts
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TENANT_ID = process.env.SMARTFUSION_TENANT_ID;
const DATABASE_URL = process.env.SMARTFUSION_DATABASE_URL;

if (!TENANT_ID || !DATABASE_URL) {
  console.error('Required: SMARTFUSION_TENANT_ID, SMARTFUSION_DATABASE_URL');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', join(__dirname, 'src', 'index.ts')],
  env: {
    ...process.env,
    SMARTFUSION_TENANT_ID: TENANT_ID,
    SMARTFUSION_DATABASE_URL: DATABASE_URL,
  } as Record<string, string>,
});

const client = new Client({
  name: 'smartfusion-test',
  version: '1.0.0',
});

await client.connect(transport);

let passed = 0;
let failed = 0;

type ToolCallResult = {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

async function testTool(name: string, args: Record<string, unknown> = {}): Promise<void> {
  try {
    const result = (await client.callTool({ name, arguments: args })) as ToolCallResult;
    const text = result.content?.[0]?.text ?? '';
    if (!text || text.length === 0) {
      console.log(`  FAIL  ${name} - empty response`);
      failed++;
    } else if (result.isError) {
      console.log(`  FAIL  ${name} - ${text.substring(0, 100)}`);
      failed++;
    } else {
      console.log(`  PASS  ${name} (${text.length} chars)`);
      passed++;
    }
  } catch (e) {
    console.log(`  FAIL  ${name} - ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

console.log('\nSmartfusion MCP Tool Tests');
console.log('='.repeat(40));

// List tools first
const tools = await client.listTools();
console.log(`\nServer reports ${tools.tools.length} tools.\n`);

// Read tools
await testTool('get_dashboard');
await testTool('list_customers', { limit: 5 });
await testTool('list_customers', { search: 'test', limit: 3 });
await testTool('list_quotes', { limit: 5 });
await testTool('list_jobs', { limit: 5 });
await testTool('list_invoices', { limit: 5 });
await testTool('list_todos', { limit: 5 });
await testTool('search_worklog', { query: 'status', limit: 5 });
await testTool('get_revenue_summary', { period: 'month' });
await testTool('list_catalog');

// Write tools (create, then clean up)
await testTool('create_todo', { title: 'MCP test todo - delete me' });
await testTool('add_worklog_note', {
  title: 'MCP test note',
  body: 'Automated test entry - safe to ignore.',
});

console.log(`\n${'='.repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests.`);

await client.close();
process.exit(failed > 0 ? 1 : 0);
