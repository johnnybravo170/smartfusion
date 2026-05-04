/**
 * AG-6 — pure tier-progress math (no DB).
 */

import { describe, expect, it } from 'vitest';
import { computeTierProgress, microsToUsd } from '@/lib/ai-gateway/tier-ladders';

const NOW = new Date('2026-05-03T12:00:00Z');

function microsForUsd(usd: number): bigint {
  // 1 USD = 100_000_000 micros
  return BigInt(Math.round(usd * 100_000_000));
}

describe('microsToUsd', () => {
  it('converts micros to USD as a JS number', () => {
    expect(microsToUsd(BigInt(100_000_000))).toBe(1); // $1
    expect(microsToUsd(BigInt(15_000_000))).toBeCloseTo(0.15);
    expect(microsToUsd(BigInt(0))).toBe(0);
  });
});

describe('computeTierProgress — OpenAI ladder', () => {
  it('starts at Free with $0 spend', () => {
    const p = computeTierProgress({
      provider: 'openai',
      lifetime_micros: BigInt(0),
      first_call_at: null,
      now: NOW,
    });
    expect(p.current_tier.name).toBe('Free');
    expect(p.next_tier?.name).toBe('Tier 1');
    expect(p.usd_remaining).toBe(5);
  });

  it('promotes to Tier 1 immediately at $5+ (no day gate)', () => {
    const p = computeTierProgress({
      provider: 'openai',
      lifetime_micros: microsForUsd(7),
      first_call_at: NOW, // same day
      now: NOW,
    });
    expect(p.current_tier.name).toBe('Tier 1');
    expect(p.next_tier?.name).toBe('Tier 2');
  });

  it('Tier 2 needs both $50 AND 7 days', () => {
    // $52 spent, only 3 days in
    const p = computeTierProgress({
      provider: 'openai',
      lifetime_micros: microsForUsd(52),
      first_call_at: new Date(NOW.getTime() - 3 * 86_400_000),
      now: NOW,
    });
    expect(p.current_tier.name).toBe('Tier 1');
    expect(p.usd_remaining).toBe(0);
    expect(p.days_remaining).toBe(4); // 7 - 3
    expect(p.ready_for_next).toBe(false);
  });

  it('Tier 2 promotes when both gates pass', () => {
    const p = computeTierProgress({
      provider: 'openai',
      lifetime_micros: microsForUsd(52),
      first_call_at: new Date(NOW.getTime() - 8 * 86_400_000),
      now: NOW,
    });
    expect(p.current_tier.name).toBe('Tier 2');
    expect(p.next_tier?.name).toBe('Tier 3');
  });

  it('caps at Tier 5 (no next_tier)', () => {
    const p = computeTierProgress({
      provider: 'openai',
      lifetime_micros: microsForUsd(2_000),
      first_call_at: new Date(NOW.getTime() - 60 * 86_400_000),
      now: NOW,
    });
    expect(p.current_tier.name).toBe('Tier 5');
    expect(p.next_tier).toBeNull();
    expect(p.usd_remaining).toBe(0);
  });

  it('ready_for_next reflects "today both gates met"', () => {
    // $5 + 0 days → already at Tier 1, ready_for_next true would mean Tier 2 ready
    // Tier 2 needs $50 + 7d, so ready=false at $5+0d.
    const p = computeTierProgress({
      provider: 'openai',
      lifetime_micros: microsForUsd(5),
      first_call_at: NOW,
      now: NOW,
    });
    expect(p.current_tier.name).toBe('Tier 1');
    expect(p.ready_for_next).toBe(false);
  });
});

describe('computeTierProgress — Anthropic ladder', () => {
  it('Build Tier 1 at zero', () => {
    const p = computeTierProgress({
      provider: 'anthropic',
      lifetime_micros: BigInt(0),
      first_call_at: null,
      now: NOW,
    });
    expect(p.current_tier.name).toBe('Build (Tier 1)');
    expect(p.next_tier?.name).toBe('Build (Tier 2)');
  });

  it('Tier 2 at $40 + 7d', () => {
    const p = computeTierProgress({
      provider: 'anthropic',
      lifetime_micros: microsForUsd(50),
      first_call_at: new Date(NOW.getTime() - 10 * 86_400_000),
      now: NOW,
    });
    expect(p.current_tier.name).toBe('Build (Tier 2)');
  });
});

describe('computeTierProgress — Gemini', () => {
  it('Gemini ladder is single-step (no tier promotion math)', () => {
    const p = computeTierProgress({
      provider: 'gemini',
      lifetime_micros: microsForUsd(10_000),
      first_call_at: new Date('2025-01-01'),
      now: NOW,
    });
    expect(p.current_tier.name).toBe('Paid');
    expect(p.next_tier).toBeNull();
  });
});

describe('computeTierProgress — defaults', () => {
  it('first_call_at=null reads as 0 days since first payment', () => {
    const p = computeTierProgress({
      provider: 'openai',
      lifetime_micros: microsForUsd(60), // would qualify for $50 gate
      first_call_at: null,
      now: NOW,
    });
    expect(p.current_tier.name).toBe('Tier 1'); // day-gate pins us at Tier 1
    expect(p.days_remaining).toBe(7);
  });
});
