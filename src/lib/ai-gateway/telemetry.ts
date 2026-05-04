/**
 * AG-5 — telemetry hook. Persists every router attempt to `ai_calls`.
 *
 * Wired into the default singleton via `gateway()` in router.ts;
 * tests build an isolated Gateway without this hook.
 *
 * Strategy:
 *  - Writes go through `createAdminClient()` so RLS denies the table
 *    to authenticated callers without affecting the gateway.
 *  - Each attempt fires a fire-and-forget insert. If `next/server`'s
 *    `after()` is available we hand off the work post-response; else
 *    we just dispatch the promise. Errors are swallowed (the router
 *    already enforces this — telemetry must never fail the user's call).
 *  - Bigint cost_micros is stored as INT8 (bigint) — we serialize via
 *    Number() because Supabase's REST layer doesn't accept JS bigint
 *    natively. We're well below 2^53 micros (= ~$90M) per row.
 */

import { createAdminClient } from '@/lib/supabase/admin';
import type { RouterAttemptEvent, RouterHooks } from './router-types';

export type TelemetryHookOptions = {
  /** Use a different write target. Defaults to the supabase admin client. */
  writer?: (row: AiCallRow) => Promise<void>;
};

export type AiCallRow = {
  tenant_id: string | null;
  task: string;
  provider: string;
  model: string;
  api_key_label: string | null;
  status: string;
  attempt_index: number;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_micros: number | null;
  latency_ms: number;
  error_message: string | null;
};

export function createTelemetryHook(options: TelemetryHookOptions = {}): RouterHooks {
  const writer = options.writer ?? defaultWriter;

  return {
    onAttempt: (event: RouterAttemptEvent) => {
      const row = eventToRow(event);
      // Detach from the request lifecycle — telemetry shouldn't add
      // latency to the user's response. Try Next's after() first; fall
      // back to a fire-and-forget promise.
      detach(
        writer(row).catch(() => {
          // Telemetry must never fail the user's call.
        }),
      );
    },
  };
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function eventToRow(event: RouterAttemptEvent): AiCallRow {
  const status = event.outcome === 'success' ? 'success' : (event.error_kind ?? 'unknown');
  return {
    tenant_id: event.tenant_id ?? null,
    task: event.task,
    provider: event.provider,
    model: event.model,
    api_key_label: event.api_key_label ?? null,
    status,
    attempt_index: event.attempt_index,
    tokens_in: event.tokens_in ?? null,
    tokens_out: event.tokens_out ?? null,
    // Supabase REST doesn't accept native bigint; convert. We're far
    // below 2^53 micros per row.
    cost_micros: event.cost_micros !== undefined ? Number(event.cost_micros) : null,
    latency_ms: event.latency_ms,
    error_message: null, // populated by future enrichment hooks; AG-5 keeps it null.
  };
}

async function defaultWriter(row: AiCallRow): Promise<void> {
  const admin = createAdminClient();
  const { error } = await admin.from('ai_calls').insert(row);
  if (error) throw new Error(error.message);
}

/**
 * Best-effort post-response dispatch. In Next 15+ server actions /
 * route handlers we can `after()` to keep work alive past the
 * response; in vitest / non-Next contexts we just attach `.catch()`
 * and let the event loop drain.
 */
function detach(promise: Promise<unknown>): void {
  // Avoid a synchronous import — `next/server` isn't available in all
  // runtimes (vitest in particular). Probe lazily; if absent, fall
  // through to plain fire-and-forget.
  try {
    void import('next/server')
      .then((mod) => {
        const after = (mod as { after?: (cb: () => void | Promise<void>) => void }).after;
        if (typeof after === 'function') {
          after(async () => {
            await promise;
          });
        } else {
          promise.catch(() => {});
        }
      })
      .catch(() => {
        promise.catch(() => {});
      });
  } catch {
    promise.catch(() => {});
  }
}
