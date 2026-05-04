/**
 * AG-5 telemetry hook — verifies eventToRow mapping + writer dispatch +
 * failure isolation. The actual DB write is mocked.
 */

import { describe, expect, it, vi } from 'vitest';
import type { RouterAttemptEvent } from '@/lib/ai-gateway/router-types';
import { createTelemetryHook } from '@/lib/ai-gateway/telemetry';

const baseEvent: RouterAttemptEvent = {
  task: 'receipt_ocr',
  attempt_index: 0,
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  api_key_label: 'default-0',
  tenant_id: 'tenant-uuid',
  outcome: 'success',
  tokens_in: 120,
  tokens_out: 40,
  cost_micros: BigInt(33000),
  latency_ms: 850,
};

describe('createTelemetryHook', () => {
  it('writes a success row mapping every field', async () => {
    const writer = vi.fn(async () => {});
    const hook = createTelemetryHook({ writer });
    hook.onAttempt?.(baseEvent);
    // Hook is fire-and-forget; flush microtasks.
    await new Promise((r) => setTimeout(r, 0));
    expect(writer).toHaveBeenCalledTimes(1);
    expect(writer.mock.calls[0][0]).toMatchObject({
      task: 'receipt_ocr',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      api_key_label: 'default-0',
      tenant_id: 'tenant-uuid',
      status: 'success',
      attempt_index: 0,
      tokens_in: 120,
      tokens_out: 40,
      cost_micros: 33000, // bigint converted to number
      latency_ms: 850,
    });
  });

  it('maps outcome=error + error_kind to status', async () => {
    const writer = vi.fn(async () => {});
    const hook = createTelemetryHook({ writer });
    hook.onAttempt?.({
      ...baseEvent,
      outcome: 'error',
      error_kind: 'quota',
      tokens_in: undefined,
      tokens_out: undefined,
      cost_micros: undefined,
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(writer.mock.calls[0][0]).toMatchObject({
      status: 'quota',
      tokens_in: null,
      tokens_out: null,
      cost_micros: null,
    });
  });

  it('falls back to status=unknown when error_kind is missing', async () => {
    const writer = vi.fn(async () => {});
    const hook = createTelemetryHook({ writer });
    hook.onAttempt?.({ ...baseEvent, outcome: 'error', error_kind: undefined });
    await new Promise((r) => setTimeout(r, 0));
    expect(writer.mock.calls[0][0].status).toBe('unknown');
  });

  it('null tenant_id when event has none (cron / system jobs)', async () => {
    const writer = vi.fn(async () => {});
    const hook = createTelemetryHook({ writer });
    hook.onAttempt?.({ ...baseEvent, tenant_id: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(writer.mock.calls[0][0].tenant_id).toBeNull();
  });

  it('writer failures are swallowed — caller never sees them', async () => {
    const writer = vi.fn(async () => {
      throw new Error('db down');
    });
    const hook = createTelemetryHook({ writer });
    expect(() => hook.onAttempt?.(baseEvent)).not.toThrow();
    // Let the rejected promise settle without unhandled-rejection noise.
    await new Promise((r) => setTimeout(r, 0));
    expect(writer).toHaveBeenCalled();
  });
});
