/**
 * Per-request context passed to every MCP tool registrar.
 *
 * `keyId` + `actorName` are stamped into every audit row and (where the
 * table has it) into `actor_name` on the inserted row, so we can trace
 * who/what called what.
 */

import type { Scope } from '@/lib/keys';
import { createServiceClient } from '@/lib/supabase';

export type McpToolCtx = {
  /**
   * `ops.api_keys.id` for HMAC api-key-authed calls; `null` for OAuth-authed
   * calls (the row lives in `ops.oauth_tokens` instead, which doesn't FK
   * here). Used as the `key_id` column on audit + resource rows.
   */
  keyId: string | null;
  actorName: string;
  scopes: string[];
};

export function hasScope(ctx: McpToolCtx, required: Scope): boolean {
  return ctx.scopes.includes(required);
}

/**
 * Wraps a tool handler with audit logging + scope check.
 * Writes a row to ops.audit_log keyed by `tool_name` (path = `/api/mcp/<tool>`)
 * with success/error status. If the key is missing the required scope,
 * returns an MCP error result without invoking the handler.
 */
export function withAudit<TArgs, TRes>(
  ctx: McpToolCtx,
  toolName: string,
  required: Scope,
  fn: (args: TArgs) => Promise<TRes>,
): (args: TArgs) => Promise<TRes | { content: [{ type: 'text'; text: string }]; isError: true }> {
  return async (args: TArgs) => {
    const path = `/api/mcp/${toolName}`;
    const service = createServiceClient();
    if (!hasScope(ctx, required)) {
      await service
        .schema('ops')
        .from('audit_log')
        .insert({
          key_id: ctx.keyId,
          method: 'POST',
          path,
          status: 403,
          reason: `missing scope ${required}`,
        })
        .then(
          () => undefined,
          () => undefined,
        );
      return {
        content: [{ type: 'text' as const, text: `Forbidden: missing scope ${required}` }],
        isError: true,
      };
    }
    try {
      const result = await fn(args);
      await service
        .schema('ops')
        .from('audit_log')
        .insert({ key_id: ctx.keyId, method: 'POST', path, status: 200 })
        .then(
          () => undefined,
          () => undefined,
        );
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await service
        .schema('ops')
        .from('audit_log')
        .insert({ key_id: ctx.keyId, method: 'POST', path, status: 500, reason: msg.slice(0, 500) })
        .then(
          () => undefined,
          () => undefined,
        );
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  };
}

export function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function jsonResult(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}
