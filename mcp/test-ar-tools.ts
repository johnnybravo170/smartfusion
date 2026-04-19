/**
 * Smoke test for the autoresponder MCP tools.
 *
 * Boots the MCP server in platform-AR mode (no tenant id), then exercises the
 * full happy path: create template → create sequence → set steps → activate →
 * create contact → tag → enroll. Relies on a local Supabase instance.
 *
 * Usage:
 *   SMARTFUSION_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
 *     npx tsx test-ar-tools.ts
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const DATABASE_URL = process.env.SMARTFUSION_DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Required: SMARTFUSION_DATABASE_URL');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['tsx', join(__dirname, 'src', 'index.ts')],
  env: {
    ...process.env,
    SMARTFUSION_AR_PLATFORM: '1',
    SMARTFUSION_DATABASE_URL: DATABASE_URL,
  },
});

const client = new Client({ name: 'ar-test', version: '1.0.0' });
await client.connect(transport);

type CallResult = { content: Array<{ type: string; text?: string }>; isError?: boolean };

async function call(name: string, args: Record<string, unknown>): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as CallResult;
  const text = res.content.map((c) => c.text ?? '').join('');
  if (res.isError) {
    throw new Error(`${name} → ${text}`);
  }
  return text;
}

function extractId(text: string, prefix: string): string {
  const match = text.match(new RegExp(`${prefix}\\s+([0-9a-f-]{36})`));
  if (!match) throw new Error(`couldn't find ${prefix} id in: ${text}`);
  return match[1];
}

const results: string[] = [];
try {
  const tools = await client.listTools();
  const arToolNames = tools.tools.map((t) => t.name).filter((n) => n.startsWith('ar_'));
  results.push(`✓ ${arToolNames.length} AR tools registered: ${arToolNames.join(', ')}`);

  // Template
  const tplRes = await call('ar_upsert_template', {
    name: `Smoke Test Template ${Date.now()}`,
    channel: 'email',
    subject: 'Hi {{first_name}}',
    body_html: '<p>Hello {{first_name}}!</p>',
  });
  const templateId = extractId(tplRes, 'template');
  results.push(`✓ Template created: ${templateId}`);

  // Sequence
  const seqRes = await call('ar_create_sequence', {
    name: `Smoke Test Sequence ${Date.now()}`,
    description: 'created by test-ar-tools',
  });
  const sequenceId = extractId(seqRes, 'sequence');
  results.push(`✓ Sequence created: ${sequenceId}`);

  await call('ar_set_sequence_steps', {
    sequence_id: sequenceId,
    steps: [
      { type: 'email', delay_minutes: 0, template_id: templateId },
      { type: 'wait', delay_minutes: 1440 },
      { type: 'email', delay_minutes: 0, template_id: templateId },
    ],
  });
  results.push('✓ Steps set');

  await call('ar_set_sequence_status', { sequence_id: sequenceId, status: 'active' });
  results.push('✓ Sequence activated');

  // Contact
  const contactRes = await call('ar_upsert_contact', {
    email: `smoke+${Date.now()}@example.com`,
    first_name: 'Smoke',
    last_name: 'Tester',
  });
  const contactId = extractId(contactRes, 'contact');
  results.push(`✓ Contact created: ${contactId}`);

  await call('ar_tag_contact', { contact_id: contactId, add: ['smoke_test'] });
  results.push('✓ Contact tagged');

  const enrollRes = await call('ar_enroll_contact', {
    contact_id: contactId,
    sequence_id: sequenceId,
  });
  results.push(`✓ Enrolled: ${enrollRes.split('\n')[0]}`);

  // Reads
  const listed = await call('ar_list_sequences', { status: 'active' });
  results.push(`✓ list_sequences returned text (len ${listed.length})`);

  const got = await call('ar_get_sequence', { id: sequenceId });
  if (!got.includes('Steps (3)')) throw new Error(`expected 3 steps, got: ${got}`);
  results.push('✓ get_sequence returned 3 steps');

  // Cleanup (best effort)
  await call('ar_set_sequence_status', { sequence_id: sequenceId, status: 'archived' });
  results.push('✓ Sequence archived (cleanup)');
} catch (e) {
  console.error('\nFAIL:', e instanceof Error ? e.message : e);
  for (const r of results) console.log(r);
  await client.close();
  process.exit(1);
}

console.log('\nAR smoke test passed:');
for (const r of results) console.log(r);
await client.close();
process.exit(0);
