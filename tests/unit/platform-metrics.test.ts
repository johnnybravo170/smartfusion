import { beforeEach, describe, expect, it, vi } from 'vitest';

// Build a flexible mock client that captures calls + returns a staged response.
type Stage = { count?: number | null; data?: unknown[] | null };

const stages = new Map<string, Stage>();

function makeChain() {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.eq = vi.fn(() => chain);
  chain.gte = vi.fn(() => chain);
  chain.is = vi.fn(() => chain);
  chain.not = vi.fn(() => chain);
  chain.order = vi.fn(() => chain);
  chain.limit = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(() => chain);
  // End of chain returns a thenable resolving to the staged stage.
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable for await
  chain.then = (resolve: (v: unknown) => unknown) => {
    const stage = stages.get((chain as Record<string, string>)._table) ?? { count: 0, data: [] };
    return Promise.resolve(
      resolve({ count: stage.count ?? null, data: stage.data ?? null, error: null }),
    );
  };
  return chain;
}

const fromMock = vi.fn((table: string) => {
  const chain = makeChain();
  (chain as Record<string, string>)._table = table;
  return chain;
});

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

import {
  getInteractionsInWindow,
  getSignupsInWindow,
  getSmsInWindow,
  getTotalTenants,
  getVoiceMinutesInWindow,
} from '@/lib/db/queries/platform-metrics';

describe('platform-metrics queries', () => {
  beforeEach(() => {
    stages.clear();
    fromMock.mockClear();
  });

  it('getTotalTenants returns count from tenants', async () => {
    stages.set('tenants', { count: 42 });
    const result = await getTotalTenants();
    expect(result).toBe(42);
    expect(fromMock).toHaveBeenCalledWith('tenants');
  });

  it('getTotalTenants returns 0 when count is null', async () => {
    stages.set('tenants', { count: null });
    const result = await getTotalTenants();
    expect(result).toBe(0);
  });

  it('getSignupsInWindow returns count from tenants', async () => {
    stages.set('tenants', { count: 5 });
    const result = await getSignupsInWindow(30);
    expect(result).toBe(5);
  });

  it('getVoiceMinutesInWindow sums input+output seconds / 60', async () => {
    stages.set('henry_interactions', {
      data: [
        { audio_input_seconds: 30, audio_output_seconds: 60 }, // 90s
        { audio_input_seconds: 120, audio_output_seconds: 180 }, // 300s
      ],
    });
    const result = await getVoiceMinutesInWindow(30);
    // (90 + 300) / 60 = 6.5 minutes
    expect(result).toBeCloseTo(6.5, 5);
  });

  it('getVoiceMinutesInWindow handles null audio_seconds', async () => {
    stages.set('henry_interactions', {
      data: [{ audio_input_seconds: null, audio_output_seconds: 60 }],
    });
    const result = await getVoiceMinutesInWindow(30);
    expect(result).toBeCloseTo(1, 5);
  });

  it('getInteractionsInWindow returns count', async () => {
    stages.set('henry_interactions', { count: 128 });
    const result = await getInteractionsInWindow(30);
    expect(result).toBe(128);
  });

  it('getSmsInWindow returns count from twilio_messages', async () => {
    stages.set('twilio_messages', { count: 17 });
    const result = await getSmsInWindow(30);
    expect(result).toBe(17);
  });
});
