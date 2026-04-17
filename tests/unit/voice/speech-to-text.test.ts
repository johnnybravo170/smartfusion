import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transcribeOnce } from '@/lib/voice/speech-to-text';

let mockInstance: {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onend: (() => void) | null;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

function MockSpeechRecognition() {
  mockInstance = {
    continuous: false,
    interimResults: false,
    lang: '',
    onresult: null,
    onerror: null,
    onend: null,
    start: vi.fn(),
    stop: vi.fn(),
  };
  return mockInstance;
}

describe('transcribeOnce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    (globalThis as any).webkitSpeechRecognition = MockSpeechRecognition;
  });

  afterEach(() => {
    vi.useRealTimers();
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    delete (globalThis as any).webkitSpeechRecognition;
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    delete (globalThis as any).SpeechRecognition;
  });

  it('resolves with transcript on successful recognition', async () => {
    const promise = transcribeOnce();

    mockInstance.onresult?.({
      results: [{ 0: { transcript: 'Check my invoices' }, length: 1 }],
    });

    await expect(promise).resolves.toBe('Check my invoices');
  });

  it('rejects when no speech is detected (onend fires)', async () => {
    const promise = transcribeOnce();
    mockInstance.onend?.();
    await expect(promise).rejects.toThrow('No speech detected');
  });

  it('rejects on recognition error', async () => {
    const promise = transcribeOnce();
    mockInstance.onerror?.({ error: 'not-allowed' });
    await expect(promise).rejects.toThrow('not-allowed');
  });

  it('rejects when API is not supported', async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mocking browser API
    delete (globalThis as any).webkitSpeechRecognition;
    await expect(transcribeOnce()).rejects.toThrow('not supported');
  });
});
