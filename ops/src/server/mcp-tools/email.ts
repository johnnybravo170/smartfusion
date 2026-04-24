import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { sendOpsEmail } from '@/server/ops-services/email';
import { jsonResult, type McpToolCtx, withAudit } from './context';

export function registerEmailTools(server: McpServer, ctx: McpToolCtx) {
  server.tool(
    'ops_email_send',
    [
      'Send an email via HeyHenry ops (Resend-backed).',
      'Use for: transactional sends from agents (digests, alerts, handoffs).',
      'DO NOT use for: bulk marketing (use the autoresponder for that),',
      'per-customer invoices (use the in-app invoice flow).',
    ].join(' '),
    {
      to: z.union([z.string().email(), z.array(z.string().email()).min(1)]),
      from: z.string().optional(),
      subject: z.string().min(1).max(250),
      html: z.string().optional(),
      text: z.string().optional(),
      reply_to: z.string().email().optional(),
      tags: z
        .array(
          z.object({
            name: z.string().min(1).max(256),
            value: z.string().min(1).max(256),
          }),
        )
        .optional(),
    },
    withAudit(ctx, 'ops_email_send', 'write:email', async (input) => {
      if (!input.html && !input.text) {
        throw new Error('At least one of html or text is required');
      }
      const result = await sendOpsEmail(input, {
        keyId: ctx.keyId,
        path: '/api/mcp/ops_email_send',
        method: 'POST',
      });
      if (!result.ok) {
        throw new Error(result.error);
      }
      return jsonResult({
        ok: true,
        id: result.id,
        to: result.to,
        subject: result.subject,
      });
    }),
  );
}
